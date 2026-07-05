'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const CodexAdapter = require('../src/adapters/codex');

function makeAdapter(env = {}) {
  const adapter = new CodexAdapter({
    workspaceId: 'ws-test',
    channelName: 'session-test',
    token: 'tok-test',
    agentName: 'codex-agent',
    endpoint: 'http://localhost:8000',
    agentType: 'codex',
    agentEnv: env,
    workingDir: 'C:/repo',
  });
  adapter._codexBin = 'codex';
  adapter._log = () => {};
  return adapter;
}

describe('CodexAdapter', () => {
  it('passes workspace model, reasoning effort, and fast service tier to Codex CLI', () => {
    const adapter = makeAdapter({
      CODEX_MODEL: 'gpt-5.5',
      CODEX_REASONING_EFFORT: 'xhigh',
      CODEX_SERVICE_TIER: 'fast',
    });

    const { cmd } = adapter._buildCodexExecCommand('session-test');

    assert.deepEqual(cmd.slice(0, 4), ['codex', '-C', 'C:/repo', 'exec']);
    assert.ok(cmd.includes('--json'));
    assert.ok(cmd.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.equal(cmd[cmd.indexOf('-m') + 1], 'gpt-5.5');
    assert.ok(cmd.includes('model_reasoning_effort="xhigh"'));
    assert.ok(cmd.includes('service_tier="fast"'));
    assert.equal(cmd.includes('model_service_tier="fast"'), false);
  });

  it('places cwd before exec resume so current Codex accepts it', () => {
    const adapter = makeAdapter({
      CODEX_MODEL: 'gpt-5.5',
    });
    adapter._channelThreads['session-test'] = '11111111-2222-3333-4444-555555555555';

    const { cmd } = adapter._buildCodexExecCommand('session-test');

    assert.deepEqual(cmd.slice(0, 4), ['codex', '-C', 'C:/repo', 'exec']);
    assert.equal(cmd[4], 'resume');
    assert.equal(cmd[5], '11111111-2222-3333-4444-555555555555');
    assert.equal(cmd.includes('-C', 4), false);
  });

  it('extracts resume thread ids for precise process cleanup', () => {
    const adapter = makeAdapter();
    const cmd = ['codex', '-C', 'C:/repo', 'exec', 'resume', '11111111-2222-3333-4444-555555555555', '--json'];

    assert.equal(adapter._extractResumeThreadId(cmd), '11111111-2222-3333-4444-555555555555');
    assert.equal(adapter._extractResumeThreadId(['codex', 'exec', '--json']), null);
  });

  it('marks running subprocesses interrupted when stopped by control', async () => {
    const adapter = makeAdapter();
    const proc = { pid: 12345, exitCode: null };
    adapter._channelProcesses['session-test'] = proc;
    const stopped = [];
    adapter._stopProcess = async (p) => { stopped.push(p); };
    adapter.sendStatus = async () => {};

    await adapter._onControlAction('stop', {});

    assert.equal(proc._openagentsInterrupted, true);
    assert.equal(proc._openagentsStopReason, 'control stop');
    assert.deepEqual(stopped, [proc]);
    assert.equal(adapter._channelProcesses['session-test'], undefined);
  });

  it('summarizes command status without exposing workspace tokens', () => {
    const adapter = makeAdapter();
    const command = String.raw`"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Command '$headers = @{ "X-Workspace-Token" = "abcdefghijklmnopqrstuvwxyz1234567890ABCDEFG" }; Invoke-RestMethod -Headers $headers -Uri http://127.0.0.1:8000/v1/workspace-tasks'`;

    const status = adapter._formatCommandStatus(command, 0);

    assert.equal(status, '**Running:** `workspace API request` (exit 0)');
    assert.equal(status.includes('abcdefghijklmnopqrstuvwxyz1234567890ABCDEFG'), false);
    assert.equal(status.includes('X-Workspace-Token'), false);
  });

  it('streams Codex process text and status by default', () => {
    const adapter = makeAdapter();

    assert.equal(adapter._streamAgentThinking, true);
    assert.equal(adapter._emitCommandStatus, true);
  });

  it('allows Codex agent text streaming to be disabled explicitly', () => {
    const adapter = makeAdapter({
      OPENAGENTS_STREAM_AGENT_THINKING: 'false',
    });

    assert.equal(adapter._streamAgentThinking, false);
  });

  it('allows Codex command status to be disabled explicitly', () => {
    const adapter = makeAdapter({
      OPENAGENTS_EMIT_COMMAND_STATUS: 'false',
    });

    assert.equal(adapter._emitCommandStatus, false);
  });

  it('attaches hidden process details to the final response', async () => {
    const adapter = makeAdapter();
    let sentOptions = null;
    adapter.client = {
      sendMessage: async (_workspaceId, _channel, _token, _content, options) => {
        sentOptions = options;
      },
    };

    adapter._recordProcessDetail('session-test', {
      kind: 'command',
      label: '命令',
      value: 'npm test',
      exit_code: 0,
    });
    await adapter.sendResponse('session-test', 'done');

    assert.equal(sentOptions.details.length, 1);
    assert.equal(sentOptions.details[0].kind, 'command');
    assert.equal(sentOptions.details[0].label, '命令');
    assert.equal(sentOptions.details[0].value, 'npm test');
  });

  it('retries a failed resumed turn instead of sending partial streamed text', async () => {
    const adapter = makeAdapter();
    adapter._channelThreads['session-test'] = '11111111-2222-3333-4444-555555555555';
    adapter._buildSystemContext = () => 'system';
    adapter._saveSessions = () => {};
    const sent = [];
    adapter.sendResponse = async (_channel, content) => { sent.push(content); };
    const commands = [];
    adapter._spawnCodex = async (cmd) => {
      commands.push(cmd);
      if (commands.length === 1) {
        return {
          responseText: 'partial progress before the transport failed',
          exitCode: 1,
          turnErrors: ['stream disconnected before completion'],
          stderr: '',
        };
      }
      return { responseText: 'final result', exitCode: 0, stderr: '' };
    };

    await adapter._handleViaSubprocess('please work', 'session-test');

    assert.equal(commands.length, 2);
    assert.equal(commands[0].includes('resume'), true);
    assert.equal(commands[1].includes('resume'), false);
    assert.deepEqual(sent, ['final result']);
  });

  it('throws on a failed fresh turn so the delivery is not acked as success', async () => {
    const adapter = makeAdapter();
    adapter._buildSystemContext = () => 'system';
    const sent = [];
    adapter.sendResponse = async (_channel, content) => { sent.push(content); };
    adapter._spawnCodex = async () => ({
      responseText: 'partial progress before the transport failed',
      exitCode: 1,
      turnErrors: ['stream disconnected before completion'],
      stderr: 'Reading prompt from stdin...',
    });

    await assert.rejects(
      () => adapter._handleViaSubprocess('please work', 'session-test'),
      /Codex CLI exited with code 1: stream disconnected before completion/,
    );
    assert.deepEqual(sent, []);
  });

  it('surfaces Codex turn timeouts as failures', async () => {
    const adapter = makeAdapter({ OPENAGENTS_CODEX_TURN_TIMEOUT_MS: '60000' });
    adapter._buildSystemContext = () => 'system';
    adapter._spawnCodex = async () => ({
      responseText: '',
      exitCode: 1,
      stderr: '',
      timedOut: true,
    });

    await assert.rejects(
      () => adapter._handleViaSubprocess('please work', 'session-test'),
      /Codex turn timed out after 1 min/,
    );
  });
});
