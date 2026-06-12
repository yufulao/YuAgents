'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildClaudeSystemPrompt,
  buildCodexSystemPrompt,
  buildOpenclawSystemPrompt,
} = require('../src/adapters/workspace-prompt');

const baseOpts = {
  agentName: '紫',
  workspaceId: 'bfcb0c20',
  channelName: '总控室',
  endpoint: 'http://localhost:18080',
  token: 'tok-test',
  disabledModules: new Set(),
  mode: 'execute',
};

describe('workspace prompt budget', () => {
  it('uses a compact Codex prompt for per-turn CLI execution', () => {
    const prompt = buildCodexSystemPrompt(baseOpts);

    assert.ok(prompt.includes("You are agent '紫'"));
    assert.ok(prompt.includes('Auth: X-Workspace-Token: tok-test'));
    assert.ok(prompt.includes('Post status/chat: POST /v1/events'));
    assert.ok(prompt.length < 5000, `prompt too large: ${prompt.length}`);
    assert.equal(prompt.includes('Exact prop names'), false);
    assert.equal(prompt.includes('Daily PR Review'), false);
  });

  it('keeps Claude system prompt lightweight by default', () => {
    const prompt = buildClaudeSystemPrompt(baseOpts);

    assert.ok(prompt.includes('Use workspace_get_history'));
    assert.ok(prompt.length < 3500, `prompt too large: ${prompt.length}`);
    assert.equal(prompt.includes('```a2ui'), false);
    assert.equal(prompt.includes('Exact prop names'), false);
  });

  it('preserves the legacy long prompt for adapters that still need full curl examples', () => {
    const prompt = buildOpenclawSystemPrompt(baseOpts);

    assert.ok(prompt.includes('Daily PR Review'));
    assert.ok(prompt.includes('```a2ui'));
  });
});
