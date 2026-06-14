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
});
