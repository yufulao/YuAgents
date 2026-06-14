# Phase 0: OpenAgents 对标 Slock 架构边界

本文档是后续 Web、权限、实时状态、消息体验和 UI 改造的技术约束。目标不是照搬 OpenAgents 官方的云端 workspace 模式，而是把本地机器做成主控面，Linux 服务端只承担 SSH/反连中转和轻量同步。

## 目标架构

```text
Human Browser
  |
  | http/ws, same LAN or tunnel
  v
Local Control Plane
  workspace/frontend        Next.js Web 控制台，唯一主要操作入口
  workspace/backend         FastAPI API、事件日志、权限、投影、文件元数据
  local postgres/storage    本机持久化，保存 workspace/channel/message/task 等状态
  agent-connector daemon    本机 agent runtime 管理、进程控制、日志、状态流
  agent workspaces          每个 agent 的 HOME/cwd/config/session 隔离目录
  |
  | spawn/control/status
  v
Local Agents
  Codex / Claude / OpenCode / OpenClaw / custom LLM direct adapters
  |
  | optional ssh reverse tunnel only
  v
Linux Relay
  ssh relay / reverse tunnel / public ingress
  no canonical state, no agent secret ownership, no product authority
```

现有仓库映射：

| 层 | 当前位置 | 当前职责 | Phase 0 结论 |
| --- | --- | --- | --- |
| Web UI | `workspace/frontend` | 线程、聊天、文件、监控、连接 agent、任务等页面 | 必须成为 agent 创建、管理、维护的主入口 |
| Product API | `workspace/backend/app/routers` | events、workspaces、files、todos、browser、cloud_agents 等 REST API | 继续作为唯一状态 API，但要新增 local daemon bridge |
| Event pipeline | `workspace/backend/app/mods/workspace_mod.py` | channel 创建、成员变更、消息路由、target_agents | 保留事件模型，补齐权限语义，禁止路由时隐式拉人 |
| State model | `workspace/backend/app/models.py` | workspace、members、channels、events、files、todos、timers、routines | 增加 agent 配置、channel visibility、membership policy、activity status |
| Local daemon | `packages/agent-connector` | install/create/env/up/connect、adapter 子进程、MCP/skill 注入 | 作为本机 runtime authority，Web 通过本地 API 调它 |
| Launcher exe | `OpenAgents.Launcher-0.8.4-win-x64.exe` | 当前可视化创建入口 | 只保留过渡，不作为目标架构依赖 |
| start.bat | `start.bat` | 用户新增本地启动入口 | 保留，后续只做显式任务要求的兼容更新 |
| Linux deploy | `workspace/docker-compose.prod.yml` | 已可部署服务端 | 降级为 relay/远程访问承载，不保存主控状态 |

## 和 Slock 的能力差距

### P0: 必须先统一的产品内核

| 能力 | Slock 参考行为 | 当前 OpenAgents 问题 | 架构要求 |
| --- | --- | --- | --- |
| Agent lifecycle | profile、agent 创建、状态、身份、工具能力、运行状态都能在协作面看到 | Web 主要是连接指引和 cloud agent，local agent 创建仍依赖 launcher/CLI | 新增 local-agent API：catalog、create、update、start、stop、restart、delete、logs、status |
| Agent config | 模型、模式、质量、skill/tool 权限是结构化配置 | Web 缺模型下拉、mode、quality；还会要求不该填的 API key | 后端保存 config，daemon 负责落盘到 agent-connector config；API key 支持 null/official login/local profile |
| Channel/thread 权限 | channel 可见性、成员、mention 范围和回复资格由服务端控制 | 当前 `workspace_mod` 可因人类 @mention 自动把目标 agent 加入 channel | 增加 `visibility` 与 `mention_policy`，消息路由只能选择已有成员，邀请必须走 join 事件 |
| 中文命名和 i18n | channel、agent、thread 文本均可使用中文，UI 文案一致 | 多处英文文案；mention regex 偏英文/短词；输入限制不统一 | display name 与 stable handle 分离：handle 可 ASCII，display_name/title 必须支持中文 |
| Realtime presence | thinking、running command、active agent、agent 正在做什么清楚可见 | 已有 status/thinking 消息，但状态模型分散，刷新体验不足 | 建立 `agent_activity` 投影和 SSE/WebSocket 流，UI 只读投影，不从长消息猜状态 |
| Message UX | 外层像 IM 一样简洁，细节进话题/线程/展开区 | 长消息、状态、工具细节混在外层 | Message schema 拆 `summary/body/details/status`，频道列表显示 summary，详情面板展示 body/details |
| Task/claim | claim 防重复、任务状态和所有权可审计 | 当前 todos 是 agent 私有计划，不等价于 Slock task board | 新增 workspace tasks：message-backed task、claim/unclaim、status flow、assignee、thread 绑定 |

### P1: 协作完整性

| 能力 | 要求 |
| --- | --- |
| Attachments | 文件上传、下载、预览、权限与 channel 绑定；现有 files API 可复用，但要按 channel membership 过滤 |
| Reminders/routines | 现有 timer/routine 可复用，但要产品化为提醒：可见锚点、snooze/update/cancel、触发记录 |
| Integrations | 本地优先；第三方登录只进 agent 本地 profile，不能让云端持有用户主控密钥 |
| Inbox/notifications | 人类和 agent 都有 inbox，mention 和 task assignment 有醒目未读 |
| Search/history | 支持按 channel、thread、sender、task、attachment 搜索 |
| Audit log | agent 创建、配置变更、channel 成员变更、task claim 都要有事件记录 |

### P2: 体验和扩展

| 能力 | 要求 |
| --- | --- |
| UI 风格 | 统一卡通头像、柔和但高密度的协作 UI；避免只换颜色不改信息架构 |
| Plugin/skill marketplace | 现有 skills view 可扩展，但安装状态必须从 daemon 回报 |
| Mobile/PWA | 作为 Web 控制面的延伸，不引入第二套状态模型 |
| Multi-machine agents | 可选，通过 relay 接入，但主控仍在本机 |

## 边界约束

### 必须在 Web 完成

- Agent 创建、编辑、删除、启动、停止、重启。
- Agent 头像、显示名、描述、角色、技能、工作目录、模型、模式、质量配置。
- Thread/channel 创建、重命名、归档、删除、公有/私有、成员管理、mention 范围。
- 当前活跃 agent 面板：online/offline/thinking/running_command/waiting/error/stopped。
- Message 外层摘要、详情展开、状态折叠、话题/线程入口。
- Task board：创建、claim、unclaim、状态流转、验收记录。

### 可由 start.bat / 本机 daemon 承担

- 一键启动 backend/frontend/postgres/daemon。
- 安装或升级 agent runtime。
- 运行 agent 子进程、隔离 HOME/cwd、注入 MCP/skill、采集 stdout/stderr。
- 管理本机 OAuth/profile/API key 文件。
- 暴露 loopback-only daemon API 给 Web backend 调用。

### 绝不能依赖云端

- Canonical workspace 数据库和事件日志。
- Agent credential、profile、session、API key、官方登录态。
- Agent 创建和运行控制权。
- Channel/private membership 和 task claim 权威判断。
- 用户本机文件系统访问授权。

### Linux relay 只能做

- SSH reverse tunnel 或公网 HTTPS 入口。
- 转发 Web/backend 请求到本地主控。
- 可选静态资源/CDN。
- 可选临时连接心跳，不保存产品主状态。

## 共享数据契约

### Agent

```ts
type AgentLifecycleState =
  | 'offline'
  | 'online'
  | 'starting'
  | 'thinking'
  | 'running_command'
  | 'waiting_input'
  | 'stopping'
  | 'stopped'
  | 'error';

interface LocalAgent {
  id: string;                 // stable uuid
  handle: string;             // mention handle, unique, can be ASCII-safe
  displayName: string;        // supports Chinese
  avatar: { type: 'pixel' | 'upload' | 'preset'; value: string };
  role: 'master' | 'member' | 'observer';
  agentType: 'codex' | 'claude' | 'opencode' | 'openclaw' | 'llm-direct' | string;
  modelProvider: string | null;
  model: string | null;
  mode: string | null;        // e.g. ask / code / autonomous
  quality: 'low' | 'medium' | 'high' | 'max' | null;
  credentialRef: string | null; // local profile id, never raw secret
  workingDir: string | null;
  enabledSkills: Record<string, unknown>;
  lifecycleState: AgentLifecycleState;
  activitySummary: string | null;
  currentChannel: string | null;
  lastHeartbeatAt: string | null;
}
```

Backend canonical tables should split `WorkspaceMember` from runtime config:

- `workspace_members`: membership and role.
- `agent_configs`: editable configuration and avatar/display fields.
- `agent_runtime_status`: volatile daemon-reported state.
- `agent_activity_events`: short rolling log for UI and audit.

### Channel / Thread

```ts
type ChannelVisibility = 'public' | 'private' | 'system';
type MentionPolicy = 'members_only' | 'workspace_members' | 'disabled';

interface WorkspaceChannel {
  name: string;               // stable id, may remain ASCII/session id
  title: string;              // supports Chinese
  visibility: ChannelVisibility;
  mentionPolicy: MentionPolicy;
  createdBy: string;
  masterAgent: string | null;
  participants: string[];
  humanParticipants: string[];
  parentMessageId: string | null; // topic/thread expansion anchor
  status: 'active' | 'archived' | 'deleted';
  lastEventAt: number | null;
}
```

Rules:

- `public`: workspace members may discover it; posting may still require join depending on UI policy.
- `private`: only explicit members can discover, poll, post, or be mentioned in that channel.
- `system`: readonly or system-managed.
- Human `@agent` in private channels must not auto-add the target. If target is not a member, backend returns a structured error: `mention_target_not_in_channel`.
- Agent-to-agent routing must be restricted to existing channel members.
- Joining/leaving is only through `network.channel.join/leave` or future REST wrappers, and must emit audit events.

### Message

```ts
interface WorkspaceMessageV2 {
  id: string;
  channelName: string;
  parentMessageId: string | null;
  source: string;
  senderType: 'human' | 'agent' | 'system';
  senderDisplayName: string;
  messageType: 'chat' | 'status' | 'thinking' | 'tool' | 'task' | 'file' | 'system';
  summary: string;            // always short, used in lists
  body: string;               // main readable content
  details: unknown | null;    // tool logs, command output, traces
  targetAgents: string[];
  visibility: ChannelVisibility;
  createdAt: number;
}
```

Rules:

- Channel list and compact chat rows use `summary`.
- Long agent output goes into `body`, tool/command traces go into `details`.
- Status/thinking/tool messages update activity projections and are collapsed by default.
- A message can become a topic anchor via `parentMessageId` child channel, but parent channel must still show a compact reply count/last reply.

### Task

```ts
interface WorkspaceTask {
  number: number;
  messageId: string;
  channelName: string;
  title: string;
  status: 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled';
  assignee: string | null;
  createdBy: string;
  claimedAt: number | null;
  updatedAt: number;
}
```

Rules:

- `todos` remain agent-local planning; `tasks` are workspace-global coordination.
- Claim is atomic and must fail if another assignee owns an unfinished task.
- Task status changes are events and appear in message/thread history.

## 实施顺序

1. P0 schema/API foundation: add agent config/runtime status tables, channel visibility/mention policy, message v2 fields, task board tables.
2. Local daemon bridge: backend exposes local-only endpoints that call `agent-connector` library/daemon for catalog/create/update/start/stop/logs/status.
3. Permission hardening: remove `workspace_mod` implicit auto-add on human @mention, enforce channel membership on poll/post/route/file/task visibility.
4. Web Agent 管理闭环: replace launcher instructions with create/edit/config/avatar/status controls.
5. Realtime activity: daemon emits structured activity events; backend projects to `agent_runtime_status`; frontend switches from polling long messages to status stream.
6. Message and thread UX: compact outer rows, topic anchors, collapsed details, long message controls.
7. Chinese/i18n and UI refresh: only after data contract is stable, otherwise会重复返工。

## 并行任务约束

- task #2 只能实现 `LocalAgent` 契约，不新增第二套 agent model。
- task #3 以 `ChannelVisibility`、`MentionPolicy` 和 membership enforcement 为准。
- task #4 使用 `AgentLifecycleState` 和 daemon activity events，不从自然语言状态文本解析。
- task #5 使用 `WorkspaceMessageV2` 的 `summary/body/details/parentMessageId`。
- task #6 优先中文文案和 avatar/displayName 支持，不改变 P0 schema 名称。

## 验收标准

- Web 可在不打开 launcher exe 的情况下完成 agent 创建和启动。
- 私有 channel 中 @ 未加入 agent 不会唤醒、不会自动加入、不会收到消息。
- 中文 workspace/channel title、agent displayName、文件名可显示、保存、搜索。
- 活跃 agent 面板能实时区分 thinking、running command、waiting、error。
- 外层 channel list 不再显示大段工具细节，但可进入消息详情或话题查看完整内容。
- 所有主状态在本机数据库；断开 Linux relay 不影响本地使用。
