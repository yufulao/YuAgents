'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildClaudeSystemPrompt,
  buildClaudeSkillMd,
  buildCodexSystemPrompt,
  buildCursorSkillMd,
  buildOpenclawSystemPrompt,
  buildRuntimeRulePackPrompt,
  buildRuntimeRuleSkillMd,
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
    assert.ok(prompt.includes('OpenAgents Runtime Rule Pack'));
    assert.ok(prompt.includes('docs/*.md'));
    assert.ok(prompt.includes('Auth: X-Workspace-Token: tok-test'));
    assert.ok(prompt.includes('Post status/chat: POST /v1/events'));
    assert.ok(prompt.length < 5000, `prompt too large: ${prompt.length}`);
    assert.equal(prompt.includes('Exact prop names'), false);
    assert.equal(prompt.includes('Daily PR Review'), false);
  });

  it('keeps Claude system prompt lightweight by default', () => {
    const prompt = buildClaudeSystemPrompt(baseOpts);

    assert.ok(prompt.includes('Use workspace_get_history'));
    assert.ok(prompt.includes('OpenAgents Runtime Rule Pack'));
    assert.ok(prompt.length < 3500, `prompt too large: ${prompt.length}`);
    assert.equal(prompt.includes('```a2ui'), false);
    assert.equal(prompt.includes('Exact prop names'), false);
  });

  it('builds mandatory runtime rule pack and skill markdown', () => {
    const prompt = buildRuntimeRulePackPrompt();
    const skill = buildRuntimeRuleSkillMd();

    assert.ok(prompt.includes('docs/*.md'));
    assert.ok(prompt.includes('Scheduling is rolling-parallel'));
    assert.ok(prompt.includes('rolling-parallel'));
    assert.ok(prompt.includes('do not batch-barrier'));
    assert.ok(prompt.includes('scope-aware'));
    assert.ok(prompt.includes('resource_locks'));
    assert.ok(prompt.includes('Ambient is passive'));
    assert.ok(prompt.includes('Non-leads report evidence'));
    assert.ok(prompt.includes('Plans: root/stage'));
    assert.ok(prompt.includes('Never close root/stage'));
    assert.ok(skill.includes('name: OpenAgents Runtime Rules'));
    assert.ok(skill.includes('/v1/agent-context'));
    assert.ok(skill.includes('shared task APIs'));
    assert.ok(skill.includes('active plans'));
    assert.ok(skill.includes('rolling-parallel'));
  });

  it('injects runtime rules into generated workspace skills', () => {
    const claudeSkill = buildClaudeSkillMd(baseOpts);
    const cursorSkill = buildCursorSkillMd(baseOpts);

    assert.ok(claudeSkill.includes('OpenAgents Runtime Rule Pack'));
    assert.ok(cursorSkill.includes('OpenAgents Runtime Rule Pack'));
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
      active_tasks: [{
        id: 'task-1',
        title: '移动端复测',
        status: 'in_progress',
        priority: 'high',
        assignee: '博丽灵梦',
        claimed_by: '博丽灵梦',
        description: 'QA verify mobile layout.',
        lane_type: 'write',
        write_scope: ['path:Src/UI'],
        resource_locks: ['path:Src/UI'],
        scheduling: { parallel_safe: false, conflicts: [{ task_id: 'task-2' }] },
      }],
      active_goals: [{
        id: 'goal-1',
        objective: '持续统筹 L1 批次',
        stop_condition: '所有子任务 done 或明确 blocked',
        status: 'active',
        checkpoint: '等待 QA 证据',
      }],
      runtime_rules: ['Do not flatten roles.'],
    });

    assert.ok(prompt.includes('Runtime Context Pack'));
    assert.ok(prompt.includes('role=master'));
    assert.ok(prompt.includes('博丽灵梦: role=qa'));
    assert.ok(prompt.includes('Passive Ambient Messages'));
    assert.ok(prompt.includes('Active Shared Tasks'));
    assert.ok(prompt.includes('task-1: [in_progress] 移动端复测'));
    assert.ok(prompt.includes('lane=write'));
    assert.ok(prompt.includes('locks=path:Src/UI'));
    assert.ok(prompt.includes('scheduling=CONFLICT'));
    assert.ok(prompt.includes('Active Workspace Plans'));
    assert.ok(prompt.includes('goal-1: [active/root_plan] 持续统筹 L1 批次'));
    assert.ok(prompt.includes('所有子任务 done 或明确 blocked'));
    assert.ok(prompt.includes('Do not flatten roles.'));
  });

  it('keeps runtime context within a hard budget while preserving owned tasks', () => {
    const longText = 'x'.repeat(1000);
    const prompt = buildRuntimeContextPrompt({
      self: {
        agent_name: '八云紫',
        role: 'master',
        agent_type: 'codex',
        status: 'thinking',
        description: longText,
      },
      channel: { name: '工作室', title: '工作室', master_agent: '八云紫' },
      agents: Array.from({ length: 30 }, (_, i) => ({
        agent_name: `agent-${i}`,
        role: i === 0 ? 'master' : 'member',
        agent_type: 'codex',
        status: 'online',
        in_channel: true,
        description: longText,
      })),
      recent_messages: Array.from({ length: 30 }, (_, i) => ({
        source: `human:${i}`,
        payload: { content: `recent-${i} ${longText}`, message_type: 'chat' },
        metadata: {},
      })),
      ambient_messages: Array.from({ length: 20 }, (_, i) => ({
        event: {
          source: `openagents:agent-${i}`,
          payload: { content: `ambient-${i} ${longText}`, message_type: 'chat' },
          metadata: {},
        },
      })),
      active_tasks: Array.from({ length: 30 }, (_, i) => ({
        id: `task-${i}`,
        title: `Task ${i}`,
        status: 'in_progress',
        priority: 'normal',
        assignee: i === 20 ? '八云紫' : `agent-${i}`,
        claimed_by: i === 20 ? '八云紫' : '',
        description: longText,
      })),
      runtime_rules: Array.from({ length: 20 }, (_, i) => `rule-${i} ${longText}`),
    }, { maxChars: 2500 });

    assert.ok(prompt.length <= 2500, `runtime context too large: ${prompt.length}`);
    assert.ok(prompt.includes('task-20: [in_progress] Task 20'));
    assert.ok(prompt.includes('Runtime context truncated by budget') || prompt.includes('omitted'));
    assert.equal(prompt.includes('recent-0'), false);
  });
});
