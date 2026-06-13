'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildClaudeSystemPrompt,
  buildCodexSystemPrompt,
  buildOpenclawSystemPrompt,
  buildRuntimeContextPrompt,
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

  it('formats runtime context with role boundaries and ambient messages', () => {
    const prompt = buildRuntimeContextPrompt({
      self: {
        agent_name: '八云紫',
        role: 'master',
        agent_type: 'codex',
        status: 'online',
        description: '总架构师，负责拆分并行任务和最终验收。',
      },
      channel: { name: '工作室', title: '工作室', master_agent: '八云紫' },
      agents: [
        { agent_name: '八云紫', role: 'master', agent_type: 'codex', status: 'online', in_channel: true, description: 'architect' },
        { agent_name: '博丽灵梦', role: 'qa', agent_type: 'claude', status: 'online', in_channel: true, description: 'QA verifier' },
      ],
      recent_messages: [{
        source: 'human:yufulao',
        payload: { content: '继续优化团队协作', message_type: 'chat' },
        metadata: {},
      }],
      ambient_messages: [{
        event: {
          source: 'openagents:博丽灵梦',
          payload: { content: '复测通过', message_type: 'chat' },
          metadata: {},
        },
      }],
      runtime_rules: ['Do not flatten roles.'],
    });

    assert.ok(prompt.includes('Runtime Context Pack'));
    assert.ok(prompt.includes('role=master'));
    assert.ok(prompt.includes('博丽灵梦: role=qa'));
    assert.ok(prompt.includes('Passive Ambient Messages'));
    assert.ok(prompt.includes('Do not flatten roles.'));
  });
});
