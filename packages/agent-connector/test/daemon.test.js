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

  it('BaseAdapter suppresses no-response thinking messages', async () => {
    const adapter = new BaseAdapter({
      workspaceId: 'ws',
      channelName: 'general',
      token: 'token',
      agentName: 'agent-a',
      endpoint: 'http://127.0.0.1:1',
    });
    let sent = 0;
    adapter.client.sendMessage = async () => {
      sent += 1;
      return { ok: true };
    };

    await adapter.sendThinking('general', '__no_response__');

    assert.equal(sent, 0);
  });

  it('BaseAdapter suppresses placeholder status and redacts status secrets', async () => {
    const adapter = new BaseAdapter({
      workspaceId: 'ws',
      channelName: 'general',
      token: 'token',
      agentName: 'agent-a',
      endpoint: 'http://127.0.0.1:1',
    });
    const sent = [];
    adapter.client.sendMessage = async (_workspaceId, _channel, _token, content, opts) => {
      sent.push({ content, opts });
      return { ok: true };
    };

    await adapter.sendStatus('general', 'thinking...');
    await adapter.sendStatus(
      'general',
      "Invoke-RestMethod -Headers @{ 'X-Workspace-Token' = 'abcdefghijklmnopqrstuvwxyz1234567890ABCDEFG' }",
      { queued_message: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234567890' },
    );

    assert.equal(sent.length, 1);
    assert.match(sent[0].content, /X-Workspace-Token/);
    assert.equal(sent[0].content.includes('abcdefghijklmnopqrstuvwxyz1234567890ABCDEFG'), false);
    assert.equal(String(sent[0].opts.metadata.queued_message).includes('abcdefghijklmnopqrstuvwxyz1234567890'), false);
    assert.match(String(sent[0].opts.metadata.queued_message), /<redacted>/);
  });

  it('BaseAdapter reports current process detail in active heartbeat payload', () => {
    const adapter = new BaseAdapter({
      workspaceId: 'ws',
      channelName: 'general',
      token: 'token',
      agentName: 'agent-a',
      endpoint: 'http://127.0.0.1:1',
    });
    adapter._log = () => {};
    adapter._channelBusy.add('general');
    adapter._recordProcessDetail('general', {
      kind: 'command',
      label: '命令',
      value: 'npm test',
    });

    const payload = adapter._activityHeartbeatPayload();

    assert.equal(payload.activity_state, 'running_command');
    assert.equal(payload.activity_summary, '命令: npm test');
    assert.equal(payload.current_channel, 'general');
    assert.equal(payload.activity_details[0].value, 'npm test');
  });

  it('BaseAdapter dedupes repeated status updates in a short window', async () => {
    const adapter = new BaseAdapter({
      workspaceId: 'ws',
      channelName: 'general',
      token: 'token',
      agentName: 'agent-a',
      endpoint: 'http://127.0.0.1:1',
    });
    const sent = [];
    adapter.client.sendMessage = async (_workspaceId, _channel, _token, content) => {
      sent.push(content);
      return { ok: true };
    };

    await adapter.sendStatus('general', '**Running:** `workspace API request` (exit 0)');
    await adapter.sendStatus('general', '**Running:** `workspace API request` (exit 0)');
    await adapter.sendStatus('general', '**Running:** `git status --short --branch` (exit 0)');
    await adapter.sendStatus('general', '**Running:** `git status --short --branch` (exit 0)');
    await adapter.sendStatus('general', '**Running:** `different command` (exit 0)');
    await adapter.sendStatus('general', '**Running:** `another different command` (exit 0)');

    assert.deepEqual(sent, [
      '**Running:** `workspace API request` (exit 0)',
      '**Running:** `git status --short --branch` (exit 0)',
      '**Running:** `different command` (exit 0)',
      '**Running:** `another different command` (exit 0)',
    ]);
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

  it('BaseAdapter processes old queued routed agent deliveries', async () => {
    const adapter = new BaseAdapter({
      workspaceId: 'ws',
      channelName: 'general',
      token: 'token',
      agentName: 'agent-a',
      endpoint: 'http://127.0.0.1:1',
    });
    adapter._log = () => {};
    adapter._sessionId = 'sess-1';
    adapter._agentQueueTtlMs = 1000;
    const handled = [];
    adapter._handleMessage = async (msg) => { handled.push(msg.messageId); };
    const acked = [];
    adapter.client.ackDelivery = async (_workspaceId, _agentName, _token, deliveryId) => {
      acked.push(deliveryId);
      return { status: 'acked' };
    };
    const queued = {
      messageId: 'old-agent-task',
      _deliveryId: 'delivery-old',
      _deliveryKind: 'attention',
      _attentionReason: 'routed',
      _queueId: 'q-old',
      _queuedAt: Date.now() - 2000,
      senderType: 'agent',
      messageType: 'task',
      content: 'Workspace task created: old work',
    };
    adapter._channelQueues.general = [queued];
    adapter._markMessageInFlight(queued);

    await adapter._channelWorker('general', { messageId: 'current-human', senderType: 'human', content: 'current' });

    assert.deepEqual(handled, ['current-human', 'old-agent-task']);
    assert.deepEqual(acked, ['delivery-old']);
    assert.equal(adapter._processedIds.has('old-agent-task'), true);
    assert.equal(adapter._isInFlightMessage(queued), false);
    assert.deepEqual(adapter._channelQueues.general, []);
  });

  it('BaseAdapter processes old queued mentioned agent deliveries', async () => {
    const adapter = new BaseAdapter({
      workspaceId: 'ws',
      channelName: 'general',
      token: 'token',
      agentName: 'agent-a',
      endpoint: 'http://127.0.0.1:1',
    });
    adapter._log = () => {};
    adapter._sessionId = 'sess-1';
    adapter._agentQueueTtlMs = 1000;
    const handled = [];
    adapter._handleMessage = async (msg) => { handled.push(msg.messageId); };
    const acked = [];
    adapter.client.ackDelivery = async (_workspaceId, _agentName, _token, deliveryId) => {
      acked.push(deliveryId);
      return { status: 'acked' };
    };
    const queued = {
      messageId: 'old-agent-mention',
      _deliveryId: 'delivery-mentioned',
      _deliveryKind: 'attention',
      _attentionReason: 'mention',
      _queueId: 'q-mentioned',
      _queuedAt: Date.now() - 2000,
      senderType: 'agent',
      messageType: 'task',
      content: '@agent-a Workspace task created: old work',
    };
    adapter._channelQueues.general = [queued];
    adapter._markMessageInFlight(queued);

    await adapter._channelWorker('general', { messageId: 'current-human', senderType: 'human', content: 'current' });

    assert.deepEqual(handled, ['current-human', 'old-agent-mention']);
    assert.deepEqual(acked, ['delivery-mentioned']);
    assert.equal(adapter._processedIds.has('old-agent-mention'), true);
    assert.equal(adapter._isInFlightMessage(queued), false);
    assert.deepEqual(adapter._channelQueues.general, []);
  });

  it('BaseAdapter keeps stale queued agent chat handoffs', async () => {
    const adapter = new BaseAdapter({
      workspaceId: 'ws',
      channelName: 'general',
      token: 'token',
      agentName: 'agent-a',
      endpoint: 'http://127.0.0.1:1',
    });
    adapter._log = () => {};
    adapter._sessionId = 'sess-1';
    adapter._agentQueueTtlMs = 1000;
    const handled = [];
    adapter._handleMessage = async (msg) => { handled.push(msg.messageId); };
    const acked = [];
    adapter.client.ackDelivery = async (_workspaceId, _agentName, _token, deliveryId) => {
      acked.push(deliveryId);
      return { status: 'acked' };
    };
    const handoff = {
      messageId: 'agent-pass-chat',
      _deliveryId: 'delivery-pass-chat',
      _deliveryKind: 'attention',
      _attentionReason: 'routed',
      _queueId: 'q-pass',
      _queuedAt: Date.now() - 2000,
      senderType: 'agent',
      messageType: 'chat',
      content: 'ENG-117B PASS / no blocker',
    };
    adapter._channelQueues.general = [handoff];
    adapter._markMessageInFlight(handoff);

    await adapter._channelWorker('general', { messageId: 'current-human', senderType: 'human', content: 'current' });

    assert.deepEqual(handled, ['current-human', 'agent-pass-chat']);
    assert.deepEqual(acked, ['delivery-pass-chat']);
    assert.equal(adapter._processedIds.has('agent-pass-chat'), true);
    assert.equal(adapter._isInFlightMessage(handoff), false);
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

  it('BaseAdapter absorbs ambient deliveries without starting idle work', async () => {
    const adapter = new BaseAdapter({
      workspaceId: 'ws',
      channelName: 'general',
      token: 'token',
      agentName: 'agent-a',
      endpoint: 'http://127.0.0.1:1',
    });
    adapter._log = () => {};
    adapter._sessionId = 'sess-1';
    let ackedDelivery = null;
    let handled = 0;
    adapter.client.ackDelivery = async (_workspaceId, _agentName, _token, deliveryId) => {
      ackedDelivery = deliveryId;
      return { status: 'acked' };
    };
    adapter._handleMessage = async () => { handled += 1; };

    await adapter._dispatchMessage({
      messageId: 'event-ambient-idle',
      _deliveryId: 'delivery-ambient-idle',
      _deliveryKind: 'ambient',
      sessionId: 'general',
      content: 'passive room context',
    });

    assert.equal(ackedDelivery, 'delivery-ambient-idle');
    assert.equal(handled, 0);
    assert.equal(adapter._channelBusy.has('general'), false);
    assert.equal(adapter._processedIds.has('event-ambient-idle'), true);
    assert.equal(adapter._isInFlightMessage({ messageId: 'event-ambient-idle' }), false);
    assert.deepEqual(adapter._channelQueues.general || [], []);
  });

  it('BaseAdapter self-nudges owned active tasks after idle polls', async () => {
    const adapter = new BaseAdapter({
      workspaceId: 'ws',
      channelName: 'general',
      token: 'token',
      agentName: 'agent-a',
      endpoint: 'http://127.0.0.1:1',
      agentEnv: { OPENAGENTS_SELF_TASK_NUDGE_MS: '1' },
    });
    adapter._log = () => {};
    let listed = 0;
    let dispatched = null;
    adapter.client.listWorkspaceTasks = async (_workspaceId, channelName, _token, opts) => {
      listed += 1;
      assert.equal(channelName, null);
      assert.equal(opts.assignee, 'agent-a');
      assert.equal(opts.active, true);
      return {
        tasks: [{
          id: 'task-1',
          title: 'Continue engine work',
          status: 'in_progress',
          assignee: 'agent-a',
          claimed_by: 'agent-a',
          channel_name: 'general',
          updated_at: '2026-06-19T00:00:00Z',
        }],
      };
    };
    adapter._dispatchMessage = async (msg) => { dispatched = msg; };

    const nudged = await adapter._maybeDispatchSelfTaskNudge();

    assert.equal(nudged, true);
    assert.equal(listed, 1);
    assert.equal(dispatched.sessionId, 'general');
    assert.equal(dispatched.senderName, 'system:self-task-nudge');
    assert.equal(dispatched.metadata.task_id, 'task-1');
    assert.match(dispatched.content, /Continue engine work/);
  });

  it('BaseAdapter does not self-nudge tasks that are explicitly waiting', async () => {
    const adapter = new BaseAdapter({
      workspaceId: 'ws',
      channelName: 'general',
      token: 'token',
      agentName: 'agent-a',
      endpoint: 'http://127.0.0.1:1',
      agentEnv: { OPENAGENTS_SELF_TASK_NUDGE_MS: '1' },
    });
    adapter._log = () => {};
    let dispatched = 0;
    adapter.client.listWorkspaceTasks = async () => ({
      tasks: [{
        id: 'task-wait',
        title: 'Verification lane',
        status: 'in_progress',
        assignee: 'agent-a',
        claimed_by: 'agent-a',
        result: 'Claimed and waiting for implementation evidence.',
      }],
    });
    adapter._dispatchMessage = async () => { dispatched += 1; };

    const nudged = await adapter._maybeDispatchSelfTaskNudge();

    assert.equal(nudged, false);
    assert.equal(dispatched, 0);
  });

  it('BaseAdapter does not emit visible queue status for agent deliveries', async () => {
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
    let statusCount = 0;
    adapter.sendStatus = async () => { statusCount += 1; };

    await adapter._dispatchMessage({
      messageId: 'event-agent',
      _deliveryId: 'delivery-agent',
      _deliveryKind: 'attention',
      _attentionReason: 'routed',
      sessionId: 'general',
      senderType: 'agent',
      content: 'agent coordination',
    });

    assert.equal(statusCount, 0);
    assert.equal(adapter._channelQueues.general.length, 1);
    assert.equal(adapter._channelQueues.general[0].messageId, 'event-agent');
  });

  it('BaseAdapter restores visible queue status for human messages', async () => {
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
    let statusCount = 0;
    adapter.sendStatus = async () => { statusCount += 1; };

    await adapter._dispatchMessage({
      messageId: 'event-human',
      sessionId: 'general',
      senderType: 'human',
      content: 'please continue',
    });

    assert.equal(statusCount, 1);
    assert.equal(adapter._channelQueues.general.length, 1);
    assert.equal(adapter._channelQueues.general[0].messageId, 'event-human');
  });

  it('BaseAdapter prioritizes human messages ahead of queued agent backlog', async () => {
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
    adapter.sendStatus = async () => {};

    await adapter._dispatchMessage({
      messageId: 'old-agent',
      _deliveryId: 'delivery-agent',
      _deliveryKind: 'attention',
      _attentionReason: 'mention',
      sessionId: 'general',
      senderType: 'agent',
      content: 'old agent handoff',
    });
    await adapter._dispatchMessage({
      messageId: 'new-human',
      _deliveryId: 'delivery-human',
      _deliveryKind: 'attention',
      _attentionReason: 'mention',
      sessionId: 'general',
      senderType: 'human',
      content: 'please handle this now',
    });

    assert.deepEqual(
      adapter._channelQueues.general.map((msg) => msg.messageId),
      ['new-human', 'old-agent'],
    );
  });

  it('BaseAdapter interrupts a long busy channel for queued human messages', async () => {
    const adapter = new BaseAdapter({
      workspaceId: 'ws',
      channelName: 'general',
      token: 'token',
      agentName: 'agent-a',
      endpoint: 'http://127.0.0.1:1',
      agentEnv: { OPENAGENTS_HUMAN_INTERRUPT_AFTER_MS: '1' },
    });
    adapter._log = () => {};
    adapter._sessionId = 'sess-1';
    adapter._channelBusy.add('general');
    adapter._channelBusySince.set('general', Date.now() - 5000);
    adapter.sendStatus = async () => {};
    let interrupted = null;
    adapter._interruptChannelForHuman = async (channel, msg, context) => {
      interrupted = { channel, messageId: msg.messageId, busyMs: context.busyMs };
      return true;
    };

    await adapter._dispatchMessage({
      messageId: 'human-interrupt',
      _deliveryId: 'delivery-human',
      _deliveryKind: 'attention',
      _attentionReason: 'mention',
      sessionId: 'general',
      senderType: 'human',
      content: 'stop waiting and answer me',
    });

    assert.equal(interrupted.channel, 'general');
    assert.equal(interrupted.messageId, 'human-interrupt');
    assert.ok(interrupted.busyMs >= 1);
    assert.equal(adapter._channelQueues.general[0].messageId, 'human-interrupt');
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

  it('BaseAdapter attention delivery prompt requires idempotent handling', () => {
    const adapter = new BaseAdapter({
      workspaceId: 'ws',
      channelName: 'general',
      token: 'token',
      agentName: 'agent-a',
      endpoint: 'http://127.0.0.1:1',
    });

    const prompt = adapter._buildDeliveryPrompt({ _deliveryKind: 'attention', _attentionReason: 'routed' });

    assert.ok(prompt.includes('at-least-once delivery'));
    assert.ok(prompt.includes('reconcile against the current task board'));
    assert.ok(prompt.includes('do not duplicate side effects'));
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
