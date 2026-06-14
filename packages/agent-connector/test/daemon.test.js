'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Daemon } = require('../src/daemon');
const { Config } = require('../src/config');
const { EnvManager } = require('../src/env');
const { Registry } = require('../src/registry');
const BaseAdapter = require('../src/adapters/base');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-daemon-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Daemon', () => {
  it('creates with correct initial state', () => {
    const config = new Config(tmpDir);
    const env = new EnvManager(tmpDir);
    const reg = new Registry(tmpDir);
    const daemon = new Daemon(config, env, reg);

    assert.deepEqual(daemon.getStatus(), {});
    assert.equal(daemon._shuttingDown, false);
  });

  it('getStatus returns empty when no agents', () => {
    const config = new Config(tmpDir);
    const env = new EnvManager(tmpDir);
    const reg = new Registry(tmpDir);
    const daemon = new Daemon(config, env, reg);

    assert.deepEqual(daemon.getStatus(), {});
  });

  it('_buildAgentEnv merges saved + resolved env', () => {
    const config = new Config(tmpDir);
    const env = new EnvManager(tmpDir);
    const reg = new Registry(tmpDir);
    const daemon = new Daemon(config, env, reg);

    // Save some env vars
    env.save('openclaw', { LLM_API_KEY: 'sk-test', LLM_BASE_URL: 'https://api.openai.com/v1' });

    const result = daemon._buildAgentEnv({ name: 'test', type: 'openclaw' });
    assert.equal(result.LLM_API_KEY, 'sk-test');
    // Should have resolved vars too
    assert.equal(result.OPENAI_API_KEY, 'sk-test');
  });

  it('_buildAgentEnv lets per-agent env override type defaults', () => {
    const config = new Config(tmpDir);
    const env = new EnvManager(tmpDir);
    const reg = new Registry(tmpDir);
    const daemon = new Daemon(config, env, reg);

    env.save('opencode', {
      LLM_BASE_URL: 'https://openrouter.ai/api/v1',
      LLM_MODEL: 'default-model',
    });

    const result = daemon._buildAgentEnv({
      name: 'agent-a',
      type: 'opencode',
      env: { LLM_MODEL: 'custom-model' },
    });

    assert.equal(result.LLM_BASE_URL, 'https://openrouter.ai/api/v1');
    assert.equal(result.LLM_MODEL, 'custom-model');
    assert.equal(result.OPENCODE_MODEL, 'custom-model');
  });

  it('_getLaunchCommand returns command from registry', () => {
    const config = new Config(tmpDir);
    const env = new EnvManager(tmpDir);
    const reg = new Registry(tmpDir);
    const daemon = new Daemon(config, env, reg);

    const cmd = daemon._getLaunchCommand({ name: 'test', type: 'claude' });
    assert.ok(cmd);
    assert.equal(cmd[0], 'claude');
    // Claude has launch args
    assert.ok(cmd.length > 1);
    assert.ok(cmd[1].includes('--append-system-prompt'));
  });

  it('_getLaunchCommand substitutes agent_name', () => {
    const config = new Config(tmpDir);
    const env = new EnvManager(tmpDir);
    const reg = new Registry(tmpDir);
    const daemon = new Daemon(config, env, reg);

    const cmd = daemon._getLaunchCommand({ name: 'my-bot', type: 'claude' });
    assert.ok(cmd.some((arg) => arg.includes('my-bot')));
  });

  it('_getLaunchCommand returns null for unknown type', () => {
    const config = new Config(tmpDir);
    const env = new EnvManager(tmpDir);
    const reg = new Registry(tmpDir);
    const daemon = new Daemon(config, env, reg);

    const cmd = daemon._getLaunchCommand({ name: 'test', type: 'nonexistent-xyz' });
    assert.equal(cmd, null);
  });

  it('_writeStatus creates status file', () => {
    const config = new Config(tmpDir);
    const env = new EnvManager(tmpDir);
    const reg = new Registry(tmpDir);
    const daemon = new Daemon(config, env, reg);

    daemon._writeStatus();
    assert.ok(fs.existsSync(config.statusFile));

    const status = JSON.parse(fs.readFileSync(config.statusFile, 'utf-8'));
    assert.ok(status.agents);
    assert.equal(status.pid, process.pid);
    assert.equal(status.runtime.feature_version, 2);
    assert.ok(status.runtime.started_at);
    assert.ok(status.runtime.source_mtime_ms > 0);
  });

  it('_processCommands handles stop command', async () => {
    const config = new Config(tmpDir);
    const env = new EnvManager(tmpDir);
    const reg = new Registry(tmpDir);
    const daemon = new Daemon(config, env, reg);

    // Create a fake process entry
    daemon._processes['test-agent'] = {
      state: 'running', proc: null, restarts: 0,
      type: 'openclaw', network: '(local)',
    };

    // Write stop command
    fs.writeFileSync(config.cmdFile, 'stop:test-agent\n', 'utf-8');
    daemon._processCommands();

    assert.ok(daemon._stoppedAgents.has('test-agent'));
  });

  it('_processCommands parses restart command', () => {
    const config = new Config(tmpDir);
    config.addAgent({ name: 'r-agent', type: 'openclaw', role: 'worker' });
    const env = new EnvManager(tmpDir);
    const reg = new Registry(tmpDir);
    const daemon = new Daemon(config, env, reg);

    daemon._processes['r-agent'] = {
      state: 'running', proc: null, restarts: 0,
      type: 'openclaw', network: '(local)',
    };

    // Stub restartAgent to verify it gets called without spawning
    let restarted = null;
    daemon.restartAgent = async (name) => { restarted = name; };

    fs.writeFileSync(config.cmdFile, 'restart:r-agent\n', 'utf-8');
    daemon._processCommands();

    assert.equal(restarted, 'r-agent');
  });

  it('start command is idempotent — skips restart when already running', () => {
    const config = new Config(tmpDir);
    config.addAgent({ name: 's-agent', type: 'openclaw', role: 'worker' });
    const daemon = new Daemon(config, new EnvManager(tmpDir), new Registry(tmpDir));

    // Already running with a live adapter — a blind restart here would tear
    // down the joined workspace session and re-join, getting the first session
    // revoked (agent stops after "thinking..."). `start:` must NOT restart it.
    daemon._adapters['s-agent'] = { stop() {} };
    daemon._processes['s-agent'] = { state: 'running', proc: null, restarts: 0 };

    let restarted = null;
    daemon.restartAgent = async (name) => { restarted = name; };

    fs.writeFileSync(config.cmdFile, 'start:s-agent\n', 'utf-8');
    daemon._processCommands();

    assert.equal(restarted, null, 'start: must not restart an already-running agent');
  });

  it('start command launches the agent when it is not running', () => {
    const config = new Config(tmpDir);
    config.addAgent({ name: 's-agent', type: 'openclaw', role: 'worker' });
    const daemon = new Daemon(config, new EnvManager(tmpDir), new Registry(tmpDir));

    // No adapter and no live process → start: must (re)launch it.
    let restarted = null;
    daemon.restartAgent = async (name) => { restarted = name; };

    fs.writeFileSync(config.cmdFile, 'start:s-agent\n', 'utf-8');
    daemon._processCommands();

    assert.equal(restarted, 's-agent', 'start: must launch an agent that is not running');
  });

  it('_configuredAgents honors OPENAGENTS_START_ONLY', () => {
    const previous = process.env.OPENAGENTS_START_ONLY;
    process.env.OPENAGENTS_START_ONLY = JSON.stringify(['target']);
    try {
      const config = new Config(tmpDir);
      config.addAgent({ name: 'target', type: 'codex', role: 'worker' });
      config.addAgent({ name: 'old-agent', type: 'codex', role: 'worker' });
      const daemon = new Daemon(config, new EnvManager(tmpDir), new Registry(tmpDir));

      assert.deepEqual(daemon._configuredAgents().map((agent) => agent.name), ['target']);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENAGENTS_START_ONLY;
      } else {
        process.env.OPENAGENTS_START_ONLY = previous;
      }
    }
  });

  it('BaseAdapter records session_revoked as stop reason', () => {
    const adapter = new BaseAdapter({
      workspaceId: 'ws',
      channelName: 'general',
      token: 'token',
      agentName: 'agent-a',
      endpoint: 'http://127.0.0.1:1',
    });
    adapter._log = () => {};

    adapter._onSessionRevoked();

    assert.equal(adapter.stopReason, 'session_revoked');
  });

  it('BaseAdapter installs the built-in runtime rule skill in the agent workdir', () => {
    const workDir = path.join(tmpDir, 'agent-work');
    const adapter = new BaseAdapter({
      workspaceId: 'ws',
      channelName: 'general',
      token: 'token',
      agentName: 'agent-a',
      agentType: 'codex',
      workingDir: workDir,
      endpoint: 'http://127.0.0.1:1',
    });
    adapter._log = () => {};

    adapter._ensureRuntimeRuleSkill();

    const skillPath = path.join(workDir, '.codex', 'skills', 'openagents-runtime', 'SKILL.md');
    assert.equal(adapter._runtimeRuleSkillPath, skillPath);
    assert.ok(fs.existsSync(skillPath));
    const content = fs.readFileSync(skillPath, 'utf-8');
    assert.ok(content.includes('OpenAgents Runtime Rules'));
    assert.ok(content.includes('docs/*.md'));
  });

  it('BaseAdapter reports locally installed skills back to the workspace', async () => {
    const workDir = path.join(tmpDir, 'agent-work');
    const unitySkillDir = path.join(workDir, '.codex', 'skills', 'unity-mcp');
    fs.mkdirSync(unitySkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(unitySkillDir, 'SKILL.md'),
      '---\nname: Unity MCP\ndescription: Unity editor automation\n---\n\n# Unity MCP\n',
      'utf-8',
    );
    const adapter = new BaseAdapter({
      workspaceId: 'ws',
      channelName: 'general',
      token: 'token',
      agentName: 'agent-a',
      agentType: 'codex',
      workingDir: workDir,
      endpoint: 'http://127.0.0.1:1',
    });
    adapter._log = () => {};
    const reported = [];
    adapter.client.reportSkillStatus = async (_workspaceId, _agentName, _token, payload) => {
      reported.push(payload);
      return { ok: true };
    };

    adapter._ensureRuntimeRuleSkill();
    await adapter._reportInstalledLocalSkills();

    const ids = new Set(reported.map((item) => item.skillId));
    assert.ok(ids.has('openagents-runtime'));
    assert.ok(ids.has('unity-mcp'));
    assert.ok(reported.every((item) => item.state === 'installed'));
  });

  it('BaseAdapter tracks in-flight durable deliveries by event and delivery id', () => {
    const adapter = new BaseAdapter({
      workspaceId: 'ws',
      channelName: 'general',
      token: 'token',
      agentName: 'agent-a',
      endpoint: 'http://127.0.0.1:1',
    });
    const msg = { messageId: 'event-1', _deliveryId: 'delivery-1' };

    adapter._markMessageInFlight(msg);

    assert.equal(adapter._isInFlightMessage({ messageId: 'event-1' }), true);
    assert.equal(adapter._isInFlightMessage({ _deliveryId: 'delivery-1' }), true);
    adapter._clearMessageInFlight(msg);
    assert.equal(adapter._isInFlightMessage(msg), false);
  });

  it('BaseAdapter requests a long durable delivery lease', () => {
    const adapter = new BaseAdapter({
      workspaceId: 'ws',
      channelName: 'general',
      token: 'token',
      agentName: 'agent-a',
      endpoint: 'http://127.0.0.1:1',
    });

    assert.equal(adapter._deliveryLeaseSeconds, 21600);
  });

  it('BaseAdapter requeues failed deliveries only for limited retries', async () => {
    const adapter = new BaseAdapter({
      workspaceId: 'ws',
      channelName: 'general',
      token: 'token',
      agentName: 'agent-a',
      endpoint: 'http://127.0.0.1:1',
    });
    adapter._sessionId = 'sess-1';
    const statuses = [];
    adapter.client.ackDelivery = async (_workspaceId, _agentName, _token, _deliveryId, _sessionId, opts) => {
      statuses.push(opts.status);
      return { status: opts.status };
    };

    await adapter._failMessage({ messageId: 'event-1', _deliveryId: 'delivery-1', _deliveryAttempts: 1 }, new Error('boom'));
    await adapter._failMessage({ messageId: 'event-2', _deliveryId: 'delivery-2', _deliveryAttempts: 3 }, new Error('boom again'));

    assert.deepEqual(statuses, ['failed', 'acked']);
    assert.equal(adapter._processedIds.has('event-2'), true);
  });

  it('BaseAdapter ack-clears cancelled queued durable deliveries', async () => {
    const adapter = new BaseAdapter({
      workspaceId: 'ws',
      channelName: 'general',
      token: 'token',
      agentName: 'agent-a',
      endpoint: 'http://127.0.0.1:1',
    });
    adapter._sessionId = 'sess-1';
    const queued = { messageId: 'event-1', _deliveryId: 'delivery-1', _queueId: 'q-1' };
    adapter._channelQueues.general = [queued];
    adapter._markMessageInFlight(queued);
    let ackedDelivery = null;
    adapter.client.ackDelivery = async (_workspaceId, _agentName, _token, deliveryId) => {
      ackedDelivery = deliveryId;
      return { status: 'acked' };
    };

    const cancelled = await adapter._cancelQueuedMessage('general', 'q-1');

    assert.equal(cancelled, true);
    assert.equal(ackedDelivery, 'delivery-1');
    assert.equal(adapter._isInFlightMessage(queued), false);
    assert.equal(adapter._processedIds.has('event-1'), true);
    assert.deepEqual(adapter._channelQueues.general, []);
  });

  it('BaseAdapter absorbs ambient deliveries when channel is busy', async () => {
    const adapter = new BaseAdapter({
      workspaceId: 'ws',
      channelName: 'general',
      token: 'token',
      agentName: 'agent-a',
      endpoint: 'http://127.0.0.1:1',
    });
    adapter._log = () => {};
    adapter._sessionId = 'sess-1';
    adapter._channelBusy.add('general');
    let ackedDelivery = null;
    let statusCount = 0;
    adapter.client.ackDelivery = async (_workspaceId, _agentName, _token, deliveryId) => {
      ackedDelivery = deliveryId;
      return { status: 'acked' };
    };
    adapter.sendStatus = async () => { statusCount += 1; };

    await adapter._dispatchMessage({
      messageId: 'event-ambient',
      _deliveryId: 'delivery-ambient',
      _deliveryKind: 'ambient',
      sessionId: 'general',
      content: 'passive room context',
    });

    assert.equal(ackedDelivery, 'delivery-ambient');
    assert.equal(statusCount, 0);
    assert.equal(adapter._processedIds.has('event-ambient'), true);
    assert.equal(adapter._isInFlightMessage({ messageId: 'event-ambient' }), false);
    assert.deepEqual(adapter._channelQueues.general || [], []);
  });

  it('BaseAdapter ambient delivery prompt forbids coordination side effects', () => {
    const adapter = new BaseAdapter({
      workspaceId: 'ws',
      channelName: 'general',
      token: 'token',
      agentName: 'agent-a',
      endpoint: 'http://127.0.0.1:1',
    });

    const prompt = adapter._buildDeliveryPrompt({ _deliveryKind: 'ambient' });

    assert.ok(prompt.includes('Ambient is passive'));
    assert.ok(prompt.includes('create/claim tasks'));
    assert.ok(prompt.includes('visibly coordinate'));
    assert.ok(prompt.includes('__no_response__'));
  });

  it('readDaemonPid returns null when no pid file', () => {
    assert.equal(Daemon.readDaemonPid(tmpDir), null);
  });

  it('readDaemonPid reads valid pid', () => {
    fs.writeFileSync(path.join(tmpDir, 'daemon.pid'), String(process.pid), 'utf-8');
    assert.equal(Daemon.readDaemonPid(tmpDir), process.pid);
  });

  it('readDaemonPid returns pid without validating liveness', () => {
    fs.writeFileSync(path.join(tmpDir, 'daemon.pid'), '99999999', 'utf-8');
    // PID validation removed — returns raw value (liveness checked elsewhere)
    assert.equal(Daemon.readDaemonPid(tmpDir), 99999999);
  });

  it('_reload is serialized (concurrent calls queue)', async () => {
    const config = new Config(tmpDir);
    const env = new EnvManager(tmpDir);
    const reg = new Registry(tmpDir);
    const daemon = new Daemon(config, env, reg);

    // Track how many times _reloadUnsafe actually runs concurrently vs. serially.
    const order = [];
    let inFlight = 0;
    let maxConcurrent = 0;
    daemon._reloadUnsafe = async () => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      order.push('start');
      await new Promise((r) => setTimeout(r, 30));
      order.push('end');
      inFlight--;
    };

    // Fire 3 reloads concurrently; they should all run (each sees the config
    // might have changed) but never overlap.
    await Promise.all([daemon._reload(), daemon._reload(), daemon._reload()]);

    assert.equal(maxConcurrent, 1, '_reloadUnsafe must never run concurrently');
    // 3 start/end pairs, always alternating
    assert.equal(order.length, 6);
    for (let i = 0; i < order.length; i += 2) {
      assert.equal(order[i], 'start');
      assert.equal(order[i + 1], 'end');
    }
  });

  it('_ensureAdapterCleared force-releases stuck adapter', async () => {
    const config = new Config(tmpDir);
    const env = new EnvManager(tmpDir);
    const reg = new Registry(tmpDir);
    const daemon = new Daemon(config, env, reg);

    let stopped = false;
    daemon._adapters['stuck'] = {
      stop: () => { stopped = true; },
    };
    // Override _sleep to make the test fast (returns immediately)
    daemon._sleep = () => Promise.resolve();

    await daemon._ensureAdapterCleared('stuck');

    assert.equal(stopped, true, 'adapter.stop() must be called when slot is stuck');
    assert.equal(daemon._adapters['stuck'], undefined, 'stuck adapter slot must be cleared');
  });

  it('_ensureAdapterCleared returns quickly when slot is already free', async () => {
    const config = new Config(tmpDir);
    const env = new EnvManager(tmpDir);
    const reg = new Registry(tmpDir);
    const daemon = new Daemon(config, env, reg);

    // No adapter in the slot
    const t0 = Date.now();
    await daemon._ensureAdapterCleared('nonexistent');
    const elapsed = Date.now() - t0;

    assert.ok(elapsed < 100, `should return immediately, took ${elapsed}ms`);
  });
});
