export interface Workspace {
  workspaceId: string;
  slug: string;
  name: string;
  creatorEmail: string | null;
  settings: Record<string, unknown>;
  browserfabricApiKey: string | null;
  status: string;
  createdAt: string | null;
  lastActivityAt: string | null;
  agents: WorkspaceAgent[];
}

export interface WorkspaceAgent {
  id?: string;
  handle?: string;
  agentName: string;
  displayName?: string;
  avatar?: { type: string; value: string } | null;
  avatarUrl?: string | null;
  role: string;
  agentType: string | null;
  serverHost: string | null;
  workingDir: string | null;
  description: string | null;
  // Workspace modules map to booleans; `installed` is a string[] of skill ids;
  // `skill_status` maps skill id → install status. Hence the union value type.
  enabledSkills: Record<string, unknown> | null;
  status: string;
  lifecycleState?: string;
  presenceStatus?: string | null;
  activityState?: string | null;
  workloadState?: string | null;
  displayStatus?: string | null;
  isConnected?: boolean;
  hasActiveWork?: boolean;
  activitySummary?: string | null;
  currentChannel?: string | null;
  activeTask?: WorkspaceAgentTask | null;
  modelProvider?: string | null;
  model?: string | null;
  modelName?: string | null;
  mode?: string | null;
  quality?: string | null;
  credentialRef?: string | null;
  managedMetadata?: Record<string, unknown> | null;
  lastHeartbeatAt: string | null;
  joinedAt: string | null;
}

export interface WorkspaceAgentTaskDependency {
  id: string;
  title: string;
  status: string;
  assignee?: string | null;
  claimedBy?: string | null;
  updatedAt?: string | null;
}

export interface WorkspaceAgentTask {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  priority?: string | null;
  assignee?: string | null;
  claimedBy?: string | null;
  createdBy?: string | null;
  channelName?: string | null;
  waitingOnDependency?: boolean;
  dependsOn?: string[];
  dependencies?: WorkspaceAgentTaskDependency[];
  result?: string | null;
  updatedAt?: string | null;
  claimedAt?: string | null;
}

/** Per-skill install status stored under enabledSkills.skill_status[skillId]. */
export type SkillState = 'installing' | 'installed' | 'failed' | 'uninstalled';
export interface SkillStatusEntry {
  state: SkillState;
  updated_at?: number;
  path?: string;
  error?: string;
}

export interface SkillCatalogEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  source_repo: string;
  source_path: string;
  author: string;
}

export interface CodexReasoningLevel {
  effort: string;
  description?: string;
}

export interface CodexServiceTier {
  id: string;
  name: string;
  description?: string;
}

export interface CodexModelInfo {
  slug: string;
  display_name: string;
  description?: string;
  default_reasoning_level?: string | null;
  supported_reasoning_levels?: CodexReasoningLevel[];
  additional_speed_tiers?: string[];
  service_tiers?: CodexServiceTier[];
  priority?: number;
}

export interface CodexLocalCatalog {
  installed: boolean;
  binary?: string | null;
  version?: string | null;
  codex_home: string;
  config: {
    path: string;
    exists: boolean;
    model?: string;
    model_reasoning_effort?: string;
    model_provider?: string;
    approval_policy?: string;
    sandbox_mode?: string;
    error?: string;
  };
  models: CodexModelInfo[];
}

export interface WorkspaceSession {
  sessionId: string;
  workspaceId: string;
  createdBy: string | null;
  title: string;
  visibility: 'public' | 'private' | 'system';
  mentionPolicy: 'members_only' | 'workspace_members' | 'disabled';
  status: string;
  starred: boolean;
  participants: string[];
  master: string | null;
  createdAt: string | null;
  lastEventAt: number | null; // unix ms timestamp of last message
}

export interface WorkspaceMessage {
  messageId: string;
  sessionId: string;
  senderId?: string | null;
  senderType: string;
  senderName: string;
  senderAvatarUrl?: string | null;
  content: string;
  summary?: string | null;
  body?: string | null;
  details?: unknown;
  mentions: string[];
  targetAgents: string[] | null;
  messageType: string;
  metadata: Record<string, unknown>;
  createdAt: string | null;
}

export interface WorkspaceIdentity {
  id: string;
  name: string;
  avatarUrl?: string | null;
  isAuthenticated: boolean;
}

export interface OnlineUser {
  id: string;
  name: string;
  status: 'online';
  lastSeen: number;
}

export interface WorkspaceFile {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  uploadedBy: string;
  channelName: string | null;
  status: string;
  createdAt: string | null;
}

export interface KnowledgeEntry {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  contentSize: number | null;
  createdBy: string;
  updatedBy: string | null;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface BrowserTab {
  id: string;
  url: string;
  title: string | null;
  status: string;
  createdBy: string;
  sharedWith: string[];
  liveUrl: string | null;
  sessionId: string | null;
  contextId: string | null;
  createdAt: string | null;
  lastActiveAt: string | null;
}

export interface BrowserPersistentContext {
  id: string;
  name: string;
  domain: string | null;
  status: string;
  createdBy: string;
  sharedWith: string[];
  createdAt: string | null;
  lastUsedAt: string | null;
}

// ---------------------------------------------------------------------------
// Todos / Tasks (agent planning)
// ---------------------------------------------------------------------------

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  assignee: string;
  createdBy: string;
  channelName: string;
  threadId: string | null;
  position: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface TimerItem {
  id: string;
  message: string;
  delaySeconds: number;
  firesAt: string;
  status: string;
  createdBy: string;
  creatorType: string;
  targetAgent: string | null;
  repeatIntervalSeconds: number | null;
  fireCount: number;
  channelName: string;
  createdAt: string | null;
}

export interface RoutineItem {
  id: string;
  name: string;
  message: string;
  context: string | null;
  scheduleHour: number;
  scheduleMinute: number;
  scheduleDays: number[] | null;
  scheduleIntervalMinutes: number | null;
  timezone: string;
  nextFiresAt: string;
  lastFiredAt: string | null;
  status: string;
  createdBy: string;
  channelName: string;
  createdAt: string | null;
}

// ---------------------------------------------------------------------------
// Inbox / Notifications
// ---------------------------------------------------------------------------

export interface NotificationItem {
  id: string;
  title: string;
  message: string;
  priority: 'low' | 'normal' | 'high';
  isRead: boolean;
  createdBy: string;
  channelName: string | null;
  threadId: string | null;
  linkUrl: string | null;
  status: string;
  createdAt: string | null;
  readAt: string | null;
}

// ---------------------------------------------------------------------------
// Agent catalog (supported client types)
// ---------------------------------------------------------------------------

export interface AgentCatalogEntry {
  name: string;
  label: string;
  description: string;
  install_command: string;
  homepage: string;
  tags: string[];
  builtin: boolean;
}

// ---------------------------------------------------------------------------
// ONM Event types (event-native API)
// ---------------------------------------------------------------------------

export interface ONMEvent {
  id: string;
  type: string;
  source: string;
  target: string;
  payload: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  timestamp: number;
  visibility: string;
}

export interface EventPollResponse {
  events: ONMEvent[];
  has_more: boolean;
  oldest_id: string | null;
  newest_id: string | null;
}

export interface NetworkAgent {
  id?: string;
  address: string;
  handle?: string;
  display_name?: string | null;
  avatar?: { type: string; value: string } | null;
  role: string;
  status: string;
  lifecycle_state?: string | null;
  lifecycle_status?: string | null;
  presence_status?: string | null;
  activity_state?: string | null;
  workload_state?: string | null;
  display_status?: string | null;
  is_connected?: boolean;
  has_active_work?: boolean;
  agent_type: string | null;
  avatar_url?: string | null;
  server_host: string | null;
  working_dir: string | null;
  description: string | null;
  enabled_skills: Record<string, unknown> | null;
  model_provider?: string | null;
  model?: string | null;
  model_name?: string | null;
  mode?: string | null;
  quality?: string | null;
  credential_ref?: string | null;
  managed_metadata?: Record<string, unknown> | null;
  activity_summary?: string | null;
  current_channel?: string | null;
  active_task?: {
    id: string;
    title: string;
    description?: string | null;
    status: string;
    priority?: string | null;
    assignee?: string | null;
    claimed_by?: string | null;
    created_by?: string | null;
    channel_name?: string | null;
    waiting_on_dependency?: boolean;
    depends_on?: string[];
    dependencies?: Array<{
      id: string;
      title: string;
      status: string;
      assignee?: string | null;
      claimed_by?: string | null;
      updated_at?: string | null;
    }>;
    result?: string | null;
    updated_at?: string | null;
    claimed_at?: string | null;
  } | null;
  last_heartbeat_at: string | null;
  joined_at: string | null;
}

export interface NetworkChannel {
  address: string;
  title: string | null;
  master: string | null;
  participants: string[];
  visibility?: 'public' | 'private' | 'system';
  mention_policy?: 'members_only' | 'workspace_members' | 'disabled';
  created_at: number | null;
  last_event_at: number | null;
  status: string;
  starred: boolean;
}

export interface NetworkDiscovery {
  agents: NetworkAgent[];
  channels: NetworkChannel[];
  mods: string[];
  resources: string[];
}

export interface NetworkProfile {
  id: string;
  slug: string;
  name: string;
  access: { policy: string; min_verification: number };
  status: string;
  capabilities: string[];
  agents_online: number;
}

// ---------------------------------------------------------------------------
// API response wrappers
// ---------------------------------------------------------------------------

export interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
}

export interface PaginationMeta {
  page: number;
  page_size: number;
  total: number | null;
  total_pages: number | null;
  has_next: boolean;
  has_prev: boolean;
}

export interface PaginatedResponse<T> {
  items: T[];
  pagination: PaginationMeta;
}

export interface MessagePollResponse {
  messages: WorkspaceMessage[];
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Converters — map ONM types to component-friendly types
// ---------------------------------------------------------------------------

/** Convert an ONM event to a WorkspaceMessage for the chat UI. */
export function eventToMessage(event: ONMEvent): WorkspaceMessage {
  const isHuman = event.source.startsWith('human:');
  const payload = (event.payload || {}) as Record<string, unknown>;
  const senderName = (payload.sender_name as string) || event.source.replace(/^(openagents:|human:)/, '');
  const targetAgents = Array.isArray(event.metadata?.target_agents)
    ? (event.metadata.target_agents as string[]).filter((name) => name && name !== '__no_response__')
    : null;

  return {
    messageId: event.id,
    senderId: (payload.sender_id as string) || null,
    sessionId: event.target.replace(/^channel\//, ''),
    senderType: isHuman ? 'human' : 'agent',
    senderName,
    senderAvatarUrl: (payload.sender_avatar_url as string) || null,
    content: (payload.content as string) || '',
    summary: (payload.summary as string) || null,
    body: (payload.body as string) || null,
    details: payload.details ?? event.metadata?.details ?? null,
    mentions: (payload.mentions as string[]) || [],
    targetAgents: targetAgents && targetAgents.length > 0 ? targetAgents : null,
    messageType: (payload.message_type as string) || 'chat',
    metadata: {
      ...(event.metadata || {}),
      ...(payload.attachments ? { attachments: payload.attachments } : {}),
      ...(payload.todos ? { todos: payload.todos } : {}),
    },
    createdAt: new Date(event.timestamp).toISOString(),
  };
}

function normalizeAgentTask(task: any): WorkspaceAgentTask | null {
  if (!task) return null;
  return {
    id: task.id,
    title: task.title,
    description: task.description || null,
    status: task.status,
    priority: task.priority || null,
    assignee: task.assignee || null,
    claimedBy: task.claimed_by ?? task.claimedBy ?? null,
    createdBy: task.created_by ?? task.createdBy ?? null,
    channelName: task.channel_name ?? task.channelName ?? null,
    waitingOnDependency: task.waiting_on_dependency ?? task.waitingOnDependency ?? false,
    dependsOn: task.depends_on ?? task.dependsOn ?? [],
    dependencies: (task.dependencies || []).map((dependency: any) => ({
      id: dependency.id,
      title: dependency.title,
      status: dependency.status,
      assignee: dependency.assignee || null,
      claimedBy: dependency.claimed_by ?? dependency.claimedBy ?? null,
      updatedAt: dependency.updated_at ?? dependency.updatedAt ?? null,
    })),
    result: task.result || null,
    updatedAt: task.updated_at ?? task.updatedAt ?? null,
    claimedAt: task.claimed_at ?? task.claimedAt ?? null,
  };
}

/** Convert an API agent shape to a WorkspaceAgent. Accepts discover snake_case and workspace-detail camelCase. */
export function normalizeWorkspaceAgent(agent: any): WorkspaceAgent {
  const agentName = agent.agentName || agent.handle || (agent.address || '').replace(/^openagents:/, '') || 'agent';
  return {
    id: agent.id || agentName,
    handle: agentName,
    agentName,
    displayName: agent.displayName ?? agent.display_name ?? agentName,
    avatar: agent.avatar || null,
    avatarUrl: agent.avatarUrl ?? agent.avatar_url ?? null,
    role: agent.role,
    agentType: agent.agentType ?? agent.agent_type ?? null,
    serverHost: agent.serverHost ?? agent.server_host ?? null,
    workingDir: agent.workingDir ?? agent.working_dir ?? null,
    description: agent.description || null,
    enabledSkills: agent.enabledSkills ?? agent.enabled_skills ?? null,
    status: agent.status,
    lifecycleState: agent.lifecycleState ?? agent.lifecycle_state ?? (agent.lifecycle_status === 'disabled' ? 'stopped' : agent.status),
    presenceStatus: agent.presenceStatus ?? agent.presence_status ?? agent.status,
    activityState: agent.activityState ?? agent.activity_state ?? agent.lifecycleState ?? agent.lifecycle_state ?? agent.status,
    workloadState: agent.workloadState ?? agent.workload_state ?? null,
    displayStatus: agent.displayStatus ?? agent.display_status ?? agent.status,
    isConnected: agent.isConnected ?? agent.is_connected ?? agent.status === 'online',
    hasActiveWork: agent.hasActiveWork ?? agent.has_active_work ?? false,
    activitySummary: agent.activitySummary ?? agent.activity_summary ?? null,
    currentChannel: agent.currentChannel ?? agent.current_channel ?? null,
    activeTask: normalizeAgentTask(agent.activeTask ?? agent.active_task),
    modelProvider: agent.modelProvider ?? agent.model_provider ?? null,
    model: agent.model || agent.model_name || null,
    modelName: agent.modelName ?? agent.model_name ?? agent.model ?? null,
    mode: agent.mode || null,
    quality: agent.quality || null,
    credentialRef: agent.credentialRef ?? agent.credential_ref ?? null,
    managedMetadata: agent.managedMetadata ?? agent.managed_metadata ?? null,
    lastHeartbeatAt: agent.lastHeartbeatAt ?? agent.last_heartbeat_at ?? null,
    joinedAt: agent.joinedAt ?? agent.joined_at ?? null,
  };
}

/** Convert a NetworkAgent from discover to a WorkspaceAgent. */
export function networkAgentToWorkspaceAgent(agent: NetworkAgent): WorkspaceAgent {
  return normalizeWorkspaceAgent(agent);
}

/** Convert a NetworkChannel from discover to a WorkspaceSession for the thread UI. */
export function networkChannelToSession(ch: NetworkChannel, workspaceId: string): WorkspaceSession {
  const name = ch.address.replace(/^channel\//, '');
  return {
    sessionId: name,
    workspaceId,
    createdBy: null,
    title: ch.title || name,
    visibility: ch.visibility || 'public',
    mentionPolicy: ch.mention_policy || 'members_only',
    status: ch.status || 'active',
    starred: ch.starred || false,
    participants: ch.participants,
    master: ch.master,
    createdAt: ch.created_at ? new Date(ch.created_at).toISOString() : null,
    lastEventAt: ch.last_event_at,
  };
}
