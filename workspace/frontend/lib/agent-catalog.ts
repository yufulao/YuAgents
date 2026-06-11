import type { AgentCatalogEntry } from './types';

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
  {
    name: 'gemini',
    label: 'Gemini CLI',
    description: 'Google Gemini 命令行 Agent，可用于代码和通用协作任务。',
    install_command: 'npm install -g @google/gemini-cli',
    homepage: 'https://github.com/google-gemini/gemini-cli',
    tags: ['通用'],
    builtin: false,
  },
  {
    name: 'cursor',
    label: 'Cursor',
    description: 'Cursor 终端 Agent，可连接到工作区参与协作。',
    install_command: 'curl -fsSL https://cursor.com/install | bash',
    homepage: 'https://cursor.com',
    tags: ['代码'],
    builtin: true,
  },
  {
    name: 'openclaw',
    label: 'OpenClaw',
    description: '开源终端 Agent，适合作为本地协作成员接入。',
    install_command: 'npm install -g openclaw@latest',
    homepage: 'https://github.com/qwibitai/openclaw',
    tags: ['开源'],
    builtin: true,
  },
  {
    name: 'aider',
    label: 'Aider',
    description: '面向代码库的 AI 结对编程 Agent。',
    install_command: 'pip install aider-chat',
    homepage: 'https://aider.chat',
    tags: ['代码'],
    builtin: false,
  },
  {
    name: 'goose',
    label: 'Goose',
    description: '开源开发者 Agent，可用于自动化开发流程。',
    install_command: 'pip install goose-ai',
    homepage: 'https://github.com/block/goose',
    tags: ['开发'],
    builtin: false,
  },
  {
    name: 'opencode',
    label: 'OpenCode',
    description: '终端原生的开源代码 Agent。',
    install_command: 'npm install -g opencode-ai@latest',
    homepage: 'https://opencode.ai',
    tags: ['开源'],
    builtin: false,
  },
];

export function withDefaultAgentCatalog(entries: AgentCatalogEntry[]): AgentCatalogEntry[] {
  return entries.length > 0 ? entries : DEFAULT_AGENT_CATALOG;
}
