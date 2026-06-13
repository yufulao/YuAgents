import type { SkillStatusEntry, WorkspaceAgent } from './types';

const MODEL_METADATA_KEYS = [
  'actual_model',
  'effective_model',
  'runtime_model',
  'codex_model',
  'claude_model',
  'model',
  'model_name',
];

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function getAgentModelLabel(agent: WorkspaceAgent): string | null {
  const metadata = agent.managedMetadata || {};
  for (const key of MODEL_METADATA_KEYS) {
    const value = stringValue(metadata[key]);
    if (value) return value;
  }
  return stringValue(agent.modelName) || stringValue(agent.model) || null;
}

function skillStatusEntries(agent: WorkspaceAgent): Record<string, SkillStatusEntry> {
  const status = agent.enabledSkills?.skill_status;
  if (!status || typeof status !== 'object' || Array.isArray(status)) return {};
  return status as Record<string, SkillStatusEntry>;
}

export function getInstalledSkillIds(agent: WorkspaceAgent): string[] {
  const skills = agent.enabledSkills;
  const installed = new Set<string>();
  if (!skills) return [];

  if (Array.isArray(skills.installed)) {
    for (const skill of skills.installed) {
      const id = stringValue(skill);
      if (id) installed.add(id);
    }
  }

  for (const [skillId, status] of Object.entries(skillStatusEntries(agent))) {
    if (status?.state === 'installed') installed.add(skillId);
  }

  return Array.from(installed).sort((a, b) => a.localeCompare(b));
}
