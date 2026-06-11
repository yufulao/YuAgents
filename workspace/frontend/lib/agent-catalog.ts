import type { AgentCatalogEntry } from './types';

const LOCAL_AGENT_NAMES = ['claude', 'codex'];

export const DEFAULT_AGENT_CATALOG: AgentCatalogEntry[] = [
  {
    name: 'claude',
    label: 'Claude Code',
    description: '适合代码修改、项目理解和长任务执行的本地 CLI Agent。',
    install_command: 'curl -fsSL https://claude.ai/install.sh | bash',
    homepage: 'https://claude.ai',
    tags: ['代码'],
    builtin: true,
  },
  {
    name: 'codex',
    label: 'OpenAI Codex CLI',
    description: '适合代码实现、仓库操作和自动化开发任务的终端 Agent。',
    install_command: 'npm install -g @openai/codex',
    homepage: 'https://github.com/openai/codex',
    tags: ['代码'],
    builtin: true,
  },
];

export function withDefaultAgentCatalog(entries: AgentCatalogEntry[]): AgentCatalogEntry[] {
  const source = entries.length > 0 ? entries : DEFAULT_AGENT_CATALOG;
  const filtered = LOCAL_AGENT_NAMES
    .map((name) => source.find((entry) => entry.name === name) || DEFAULT_AGENT_CATALOG.find((entry) => entry.name === name))
    .filter((entry): entry is AgentCatalogEntry => Boolean(entry));
  return filtered.length > 0 ? filtered : DEFAULT_AGENT_CATALOG;
}
