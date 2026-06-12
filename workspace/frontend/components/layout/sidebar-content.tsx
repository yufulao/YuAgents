'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  Plus, MessageSquare, FileText, Globe, PlusSquare, Sparkles, BookOpen,
  Settings, Copy, Check, ListTodo, CalendarClock, Inbox,
  LogIn, LogOut, Shield, Moon, Sun, KeyRound, X, Crown, Users, Network,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { useLayout, type ViewMode } from './layout-context';
import { useWorkspace } from '@/lib/workspace-context';
import { timeAgo } from '@/lib/helpers';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { AgentActivityPanel } from '@/components/agents/agent-activity-panel';
import { cn } from '@/lib/utils';
import { workspaceApi } from '@/lib/api';
import { Switch } from '@/components/ui/switch';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { toast } from 'sonner';
import type { WorkspaceCollaborator } from '@/lib/types';
import { useOpenAgentsAuth } from '@/lib/openagents-auth-context';
import { workspaceCreationEnabled, workspaceDirectoryEnabled } from '@/lib/workspace-policy';
import { NewThreadDialog } from '@/components/threads/new-thread-dialog';
import {
  createLocalWorkspace,
  getLocalWorkspaceTokens,
  listLocalWorkspaces,
  rememberLocalWorkspaceToken,
} from '@/lib/dashboard-api';
import type { Workspace } from '@/lib/types';

// ── Navigation button helper ──

function NavButton({
  active,
  icon,
  label,
  count,
  onClick,
}: {
  active?: boolean;
  icon: React.ReactNode;
  label: string;
  count?: number;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2 px-2 h-8 rounded-lg text-[13px] transition-colors',
        active
          ? 'bg-zinc-100 dark:bg-zinc-800 text-primary font-medium'
          : 'hover:bg-zinc-100 dark:hover:bg-zinc-800 text-foreground font-normal hover:text-primary'
      )}
    >
      <span className={active ? 'opacity-100' : 'opacity-60'}>{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      {count !== undefined && count > 0 && (
        <span className="text-xs text-muted-foreground">{count}</span>
      )}
    </button>
  );
}

// ── Main SidebarContent ──

export function SidebarContent() {
  const router = useRouter();
  const { isSidebarOpen, sidebarToggle, viewMode, setViewMode, setSelectedAgentName } = useLayout();
  const { agents, sessions, files, browserTabs, createSession, workspace, token, refreshWorkspace, todos, routines, knowledge, currentUser, onlineUsers, unreadNotificationCount, activeSessionIds } = useWorkspace();
  const { user, isOpenAgentsDomain, signIn, signOut } = useOpenAgentsAuth();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [newThreadOpen, setNewThreadOpen] = useState(false);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  const isDark = mounted && theme === 'dark';
  const toggleTheme = () => setTheme(isDark ? 'light' : 'dark');

  const handleCopyToken = () => {
    if (!token) {
      toast.error('没有可用的管理 Token');
      return;
    }
    navigator.clipboard.writeText(token);
    setTokenCopied(true);
    toast.success('管理 Token 已复制');
    setTimeout(() => setTokenCopied(false), 2000);
  };

  const handleNewThread = () => {
    if (agents.length >= 2) {
      setNewThreadOpen(true);
    } else {
      createSession();
      setViewMode('threads');
    }
  };

  // Show configured agents even when they are offline. Local-first workspaces
  // need the created config to remain visible before the CLI process starts.
  const visibleAgents = agents;
  const onlineCount = agents.filter((a) => a.status === 'online').length;

  const isUnclaimed = workspace && !workspace.creatorEmail;
  const isOwnedByUser = workspace && user && workspace.creatorEmail === user.email;

  const handleClaim = async () => {
    setClaiming(true);
    try {
      await workspaceApi.claimWorkspace();
      await refreshWorkspace();
      toast.success('工作区已认领');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '认领工作区失败');
    } finally {
      setClaiming(false);
    }
  };

  // ── Collapsed sidebar ──
  if (!isSidebarOpen) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex justify-center px-2.5 py-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleNewThread}
                className="size-9 rounded-lg bg-primary flex items-center justify-center text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                <Plus className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">新建会话</TooltipContent>
          </Tooltip>
        </div>

        <div className="flex-1 flex flex-col items-center py-3 gap-2">
          {visibleAgents.map((agent) => (
            <Tooltip key={agent.agentName}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setSelectedAgentName(agent.agentName)}
                  className="cursor-pointer hover:ring-2 hover:ring-zinc-300 dark:hover:ring-zinc-600 transition-shadow rounded-full"
                >
                  <AgentAvatar name={agent.agentName} size={28} status={agent.status} showStatus />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">{agent.agentName}</TooltipContent>
            </Tooltip>
          ))}
        </div>

        <div className="px-2.5 py-3 space-y-1">
          {isOpenAgentsDomain && !user && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button onClick={signIn} className="w-full flex items-center justify-center py-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800">
                  <LogIn className="size-4 text-muted-foreground" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">登录</TooltipContent>
            </Tooltip>
          )}
          {isOpenAgentsDomain && user && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button onClick={sidebarToggle} className="w-full flex items-center justify-center py-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800">
                  <div className="size-6 rounded-full bg-primary flex items-center justify-center text-primary-foreground text-[10px] font-bold">
                    {user.email[0].toUpperCase()}
                  </div>
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">{user.email}</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button onClick={toggleTheme} className="w-full flex items-center justify-center py-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800">
                {isDark ? <Sun className="size-4 text-muted-foreground" /> : <Moon className="size-4 text-muted-foreground" />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{isDark ? '浅色模式' : '深色模式'}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button onClick={sidebarToggle} className="w-full flex items-center justify-center py-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800">
                <Settings className="size-4 text-muted-foreground" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">设置</TooltipContent>
          </Tooltip>
        </div>
      </div>
    );
  }

  // ── Expanded sidebar ──
  return (
    <>
      <div className="flex flex-col h-full">
        <ScrollArea className="flex-1 min-h-0">
          {/* New Thread button */}
          <div className="px-3.5 pb-3">
            <button
              onClick={handleNewThread}
              className="w-full h-9 flex items-center justify-center gap-2 rounded-lg bg-primary text-primary-foreground text-[13px] font-medium hover:bg-primary/90 transition-colors"
            >
              <Plus className="size-4" />
              <span>新建会话</span>
            </button>
          </div>

          {/* Agents */}
          <div className="px-2.5">
            <p className="text-xs font-normal text-muted-foreground px-2 py-1.5 mb-0.5">
              Agents（{onlineCount}/{visibleAgents.length}）
            </p>
            <div className="space-y-0.5 max-h-48 overflow-y-auto">
              {visibleAgents.map((agent) => (
                <button
                  key={agent.agentName}
                  onClick={() => setSelectedAgentName(agent.agentName)}
                  className="w-full flex items-center gap-2 px-2 h-8 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer group transition-colors"
                >
                  <AgentAvatar name={agent.agentName} size={20} status={agent.status} showStatus />
                  <span className="text-[13px] font-normal text-foreground group-hover:text-primary truncate text-left">
                    {agent.agentName}
                  </span>
                </button>
              ))}
            </div>

            <AgentActivityPanel
              agents={visibleAgents}
              sessions={sessions}
              activeSessionIds={activeSessionIds}
              onRefresh={refreshWorkspace}
            />

            {/* Online Users */}
            {onlineUsers.length > 0 && (
              <>
                <p className="text-xs font-normal text-muted-foreground px-2 py-1.5 mb-0.5 mt-6">
                  <Users className="size-3 inline-block mr-1 -mt-0.5" />
                  在线成员（{onlineUsers.length}）
                </p>
                <div className="space-y-0.5">
                  {onlineUsers.map((u) => (
                    <div
                      key={u.id}
                      className="flex items-center gap-2 px-2 h-8 rounded-lg text-[13px]"
                    >
                      <div className="size-2 rounded-full bg-emerald-500 shrink-0" />
                      <span className="truncate text-foreground">
                        {u.id === currentUser.id ? `${u.name}（我）` : u.name}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* Collaboration */}
            <p className="text-xs font-normal text-muted-foreground px-2 py-1.5 mb-0.5 mt-6">
              协作
            </p>
            <div className="space-y-0.5">
              <NavButton active={viewMode === 'threads'} icon={<MessageSquare className="size-[15px]" />} label="会话" count={sessions.filter((s) => !s.sessionId.startsWith('routine:')).length} onClick={() => setViewMode('threads')} />
              {visibleAgents.length > 0 && (
                <>
                  <NavButton active={viewMode === 'files'} icon={<FileText className="size-[15px]" />} label="文件" count={files.length} onClick={() => setViewMode('files')} />
                  <NavButton active={viewMode === 'browser'} icon={<Globe className="size-[15px]" />} label="浏览器" count={browserTabs.length} onClick={() => setViewMode('browser')} />
                  <NavButton active={viewMode === 'routines'} icon={<CalendarClock className="size-[15px]" />} label="例行任务" count={routines.filter((r) => r.status === 'active').length} onClick={() => setViewMode('routines')} />
                  <NavButton active={viewMode === 'knowledge'} icon={<BookOpen className="size-[15px]" />} label="知识库" count={knowledge.length} onClick={() => setViewMode('knowledge')} />
                  <NavButton active={viewMode === 'tasks'} icon={<ListTodo className="size-[15px]" />} label="任务" count={todos.filter((t) => t.status === 'pending' || t.status === 'in_progress').length} onClick={() => setViewMode('tasks')} />
                  <NavButton active={viewMode === 'inbox'} icon={<Inbox className="size-[15px]" />} label="收件箱" count={unreadNotificationCount > 0 ? unreadNotificationCount : undefined} onClick={() => setViewMode('inbox')} />
                  <NavButton active={viewMode === 'skills'} icon={<Sparkles className="size-[15px]" />} label="技能中心" onClick={() => setViewMode('skills')} />
                </>
              )}
            </div>

          </div>
        </ScrollArea>

        {/* Bottom section — pinned to bottom */}
        <div className="shrink-0 px-2.5 pb-1">
          {visibleAgents.length === 0 ? (
            <button
              onClick={() => setViewMode('connect')}
              className={cn(
                'w-full flex items-center justify-center gap-2 h-9 rounded-lg text-[13px] font-medium transition-colors',
                viewMode === 'connect'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-primary/10 text-primary hover:bg-primary/20',
              )}
            >
              <PlusSquare className="size-4" />
              连接第一个 Agent
            </button>
          ) : (
            <NavButton active={viewMode === 'connect'} icon={<PlusSquare className="size-[15px]" />} label="连接 Agent" onClick={() => setViewMode('connect')} />
          )}
        </div>
        <div className="shrink-0 border-t border-border px-2.5 py-2.5 space-y-1">
          {workspace && (
            <button
              onClick={() => setSwitcherOpen(true)}
              className="w-full flex items-center gap-2 px-2 h-8 rounded-lg text-[13px] hover:bg-muted transition-colors"
              title="切换或创建工作区"
            >
              <Network className="size-[15px] text-muted-foreground" />
              <span className="flex-1 truncate text-left">{workspace.name}</span>
              <span className="text-[10px] text-muted-foreground font-mono truncate max-w-[68px]">{workspace.slug}</span>
            </button>
          )}

          {/* Logged-in user details */}
          {isOpenAgentsDomain && user && (
            <div className="px-2 py-1.5 space-y-2">
              <div className="flex items-center gap-2">
                <div className="size-6 rounded-full bg-primary flex items-center justify-center text-primary-foreground text-[10px] font-bold shrink-0">
                  {user.email[0].toUpperCase()}
                </div>
                <span className="text-[12px] text-muted-foreground truncate flex-1">{user.email}</span>
                <button onClick={signOut} className="text-muted-foreground hover:text-foreground transition-colors" title="退出登录">
                  <LogOut className="size-3.5" />
                </button>
              </div>
              {isUnclaimed && (
                <button
                  onClick={handleClaim}
                  disabled={claiming}
                  className="w-full flex items-center justify-center gap-1.5 h-7 rounded-md bg-emerald-600 text-white text-[12px] font-medium hover:bg-emerald-700 transition-colors disabled:opacity-50"
                >
                  <Shield className="size-3.5" />
                  {claiming ? '认领中...' : '认领工作区'}
                </button>
              )}
              {isOwnedByUser && (
                <p className="text-[11px] text-emerald-600 flex items-center gap-1 px-0.5">
                  <Shield className="size-3" /> 你拥有此工作区
                </p>
              )}
            </div>
          )}

          {/* Bottom row: Sign in (left) + icon buttons (right) */}
          <div className="flex items-center gap-1 px-1">
            {isOpenAgentsDomain && !user && (
              <button
                onClick={signIn}
                className="flex items-center gap-1.5 px-2 py-1.5 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <LogIn className="size-[15px]" />
                <span className="text-xs">登录</span>
              </button>
            )}
            <div className="flex-1" />
            <button
              onClick={toggleTheme}
              className="size-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
              title={isDark ? '浅色模式' : '深色模式'}
            >
              {isDark ? <Sun className="size-[15px]" /> : <Moon className="size-[15px]" />}
            </button>
            {token && (
              <button
                onClick={handleCopyToken}
                className="size-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
                title={tokenCopied ? '已复制' : '复制工作区 Token'}
              >
                {tokenCopied ? <Check className="size-[15px]" /> : <KeyRound className="size-[15px]" />}
              </button>
            )}
            <button
              onClick={() => setSettingsOpen(true)}
              className="size-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
              title="设置"
            >
              <Settings className="size-[15px]" />
            </button>
          </div>
        </div>
      </div>

      {/* Settings Dialog */}
      <SettingsDialogPortal open={settingsOpen} onOpenChange={setSettingsOpen} workspace={workspace} refreshWorkspace={refreshWorkspace} />

      <WorkspaceSwitcherDialog
        open={switcherOpen}
        onOpenChange={setSwitcherOpen}
        currentSlug={workspace?.slug || ''}
        onNavigate={(slug, nextToken) => {
          if (nextToken) rememberLocalWorkspaceToken(slug, nextToken);
          router.push(nextToken ? `/${slug}?token=${encodeURIComponent(nextToken)}` : `/${slug}`);
        }}
      />



      {/* New Thread Dialog (agent picker) */}
      <NewThreadDialog
        open={newThreadOpen}
        onOpenChange={setNewThreadOpen}
        agents={agents}
        sessions={sessions}
        onCreateThread={({ master, participants, resumeFrom }) => {
          createSession({ master, participants, resumeFrom });
          setViewMode('threads');
        }}
      />
    </>
  );
}


function WorkspaceSwitcherDialog({
  open,
  onOpenChange,
  currentSlug,
  onNavigate,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  currentSlug: string;
  onNavigate: (slug: string, token?: string) => void;
}) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [newName, setNewName] = useState('');
  const [newAgent, setNewAgent] = useState('');
  const [manualSlug, setManualSlug] = useState('');
  const [manualToken, setManualToken] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useMemo(() => async () => {
    if (!workspaceDirectoryEnabled) {
      setWorkspaces([]);
      setTokens(getLocalWorkspaceTokens());
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const items = await listLocalWorkspaces();
      setWorkspaces(items);
      setTokens(getLocalWorkspaceTokens());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '读取工作区失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const created = await createLocalWorkspace({
        name,
        agentName: newAgent.trim() || undefined,
        agentType: newAgent.trim() ? 'codex' : undefined,
      });
      onOpenChange(false);
      onNavigate(created.slug, created.token);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建工作区失败');
    } finally {
      setCreating(false);
    }
  };

  const handleManualOpen = () => {
    const slug = manualSlug.trim();
    const token = manualToken.trim();
    if (!slug) return;
    if (token) rememberLocalWorkspaceToken(slug, token);
    onOpenChange(false);
    onNavigate(slug, token || tokens[slug]);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>切换 Workspace</DialogTitle>
        </DialogHeader>
        <div className="space-y-5 py-2">
          <div className="rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground leading-relaxed">
            {workspaceDirectoryEnabled
              ? '这里列出的是当前本机主控里的 workspace。服务器和 Web 只是访问入口；选择 workspace 后仍然连接本机 backend。'
              : '远端 Web 只作为访问入口。请输入已有 workspace slug 和 token/password 进入。'}
          </div>

          {workspaceDirectoryEnabled && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>本机 Workspace</Label>
              <Button size="sm" variant="ghost" onClick={load} disabled={loading}>
                {loading ? '刷新中...' : '刷新'}
              </Button>
            </div>
            <div className="space-y-2">
              {workspaces.length === 0 && !loading ? (
                <div className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
                  暂无 workspace
                </div>
              ) : (
                workspaces.map((workspace) => {
                  const token = tokens[workspace.slug];
                  const active = workspace.slug === currentSlug;
                  return (
                    <button
                      key={workspace.workspaceId}
                      onClick={() => {
                        if (!token) {
                          setManualSlug(workspace.slug);
                          setManualToken('');
                          return;
                        }
                        onOpenChange(false);
                        onNavigate(workspace.slug, token);
                      }}
                      className={cn(
                        'w-full rounded-md border px-3 py-2 text-left transition-colors',
                        active ? 'border-primary bg-primary/5' : 'hover:bg-muted/60',
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium truncate">{workspace.name}</span>
                        <span className="text-[10px] text-muted-foreground">{active ? '当前' : token ? '可进入' : '需 token'}</span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-3 text-xs text-muted-foreground">
                        <span className="font-mono">{workspace.slug}</span>
                        <span>{workspace.agents.length} Agent</span>
                        {workspace.lastActivityAt && <span>{timeAgo(workspace.lastActivityAt)}</span>}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
          )}

          <div className={cn('grid gap-3', workspaceCreationEnabled ? 'sm:grid-cols-2' : 'sm:grid-cols-1')}>
            {workspaceCreationEnabled && (
            <div className="space-y-2 rounded-md border p-3">
              <Label>创建 Workspace</Label>
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="名称" />
              <Input value={newAgent} onChange={(e) => setNewAgent(e.target.value)} placeholder="初始 Agent（可选）" />
              <Button size="sm" className="w-full" onClick={handleCreate} disabled={!newName.trim() || creating}>
                {creating ? '创建中...' : '创建并进入'}
              </Button>
            </div>
            )}

            <div className="space-y-2 rounded-md border p-3">
              <Label>用 Token 打开</Label>
              <Input value={manualSlug} onChange={(e) => setManualSlug(e.target.value)} placeholder="workspace slug" />
              <Input value={manualToken} onChange={(e) => setManualToken(e.target.value)} placeholder="token" type="password" />
              <Button size="sm" variant="outline" className="w-full" onClick={handleManualOpen} disabled={!manualSlug.trim()}>
                打开
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}


// ── Controlled Settings Dialog ──

function SettingsDialogPortal({ open, onOpenChange, workspace, refreshWorkspace }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  workspace: ReturnType<typeof useWorkspace>['workspace'];
  refreshWorkspace: () => Promise<void>;
}) {
  const [name, setName] = useState(workspace?.name || '');
  const [monitorMode, setMonitorMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const { isCopied: urlCopied, copyToClipboard: copyUrl } = useCopyToClipboard();
  const { isCopied: tokenCopied, copyToClipboard: copyToken } = useCopyToClipboard();
  const { notificationSound, setNotificationSound } = useWorkspace();
  const { splitBrowser, setSplitBrowser } = useLayout();
  const [collabEmail, setCollabEmail] = useState('');
  const [collabAdding, setCollabAdding] = useState(false);
  const [collaborators, setCollaborators] = useState<WorkspaceCollaborator[]>([]);
  const [collabOwner, setCollabOwner] = useState<string | null>(null);
  const [bfApiKey, setBfApiKey] = useState('');

  useEffect(() => {
    if (open && workspace) {
      setName(workspace.name);
      setMonitorMode(!!(workspace.settings?.monitorMode));
      setBfApiKey('');
      workspaceApi.listCollaborators().then((d) => {
        setCollaborators(d.collaborators);
        setCollabOwner(d.owner);
      }).catch(() => {});
    }
  }, [open, workspace]);

  if (!workspace) return null;

  const workspaceUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/${workspace.slug}${window.location.search}`
    : '';

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const wsUpdates: Record<string, unknown> = { name: name.trim(), settings: { ...workspace.settings, monitorMode } };
      if (bfApiKey.trim()) wsUpdates.browserfabric_api_key = bfApiKey.trim();
      await workspaceApi.updateWorkspace(wsUpdates);
      await refreshWorkspace();
      toast.success('设置已保存');
      onOpenChange(false);
    } catch {
      toast.error('保存设置失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>工作区设置</DialogTitle></DialogHeader>
        <div className="space-y-6 py-4">
          <div className="space-y-2">
            <Label>工作区名称</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="我的工作区" />
          </div>
          <div className="space-y-2">
            <Label variant="secondary">工作区 URL</Label>
            <div className="flex items-center gap-2">
              <Input value={workspaceUrl} readOnly className="text-xs font-mono" />
              <Button variant="outline" size="icon" onClick={() => copyUrl(workspaceUrl)}>
                {urlCopied ? <Check className="size-4" /> : <Copy className="size-4" />}
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            <Label variant="secondary">工作区 ID</Label>
            <div className="flex items-center gap-2">
              <Input value={workspace.slug} readOnly className="text-xs font-mono" />
              <Button variant="outline" size="icon" onClick={() => copyToken(workspace.slug)}>
                {tokenCopied ? <Check className="size-4" /> : <Copy className="size-4" />}
              </Button>
            </div>
          </div>

          {/* Experimental */}
          <div className="flex items-center justify-between gap-4 rounded-lg border border-input px-4 py-3">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2">
                <Label>监控模式</Label>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 font-medium">
                  实验性
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                用 2x3 网格展示最近会话，而不是列表。
              </p>
            </div>
            <Switch checked={monitorMode} onCheckedChange={setMonitorMode} size="sm" />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-lg border border-input px-4 py-3">
            <div className="space-y-0.5">
              <Label>通知音效</Label>
              <p className="text-xs text-muted-foreground">
                Agent 完成任务时播放提示音。
              </p>
            </div>
            <Switch checked={notificationSound} onCheckedChange={setNotificationSound} size="sm" />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-lg border border-input px-4 py-3">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2">
                <Label>分屏浏览器</Label>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 font-medium">
                  实验性
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                查看会话时让浏览器标签与聊天并排显示。
              </p>
            </div>
            <Switch checked={splitBrowser} onCheckedChange={setSplitBrowser} size="sm" />
          </div>

          {/* Collaborators */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Users className="size-4 text-muted-foreground" />
              <Label>协作者</Label>
            </div>
            <p className="text-xs text-muted-foreground">
              通过邮箱添加成员。对方登录后即可访问此工作区。
            </p>
            <div className="flex items-center gap-2">
              <Input
                value={collabEmail}
                onChange={(e) => setCollabEmail(e.target.value)}
                placeholder="colleague@example.com"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && collabEmail.trim()) {
                    setCollabAdding(true);
                    workspaceApi.addCollaborator(collabEmail.trim().toLowerCase(), 'editor')
                      .then(() => {
                        toast.success(`已添加 ${collabEmail.trim()}`);
                        setCollabEmail('');
                        return workspaceApi.listCollaborators();
                      })
                      .then((d) => setCollaborators(d.collaborators))
                      .catch((e) => toast.error(e instanceof Error ? e.message : '操作失败'))
                      .finally(() => setCollabAdding(false));
                  }
                }}
                className="flex-1"
              />
              <Button
                onClick={() => {
                  if (!collabEmail.trim()) return;
                  setCollabAdding(true);
                  workspaceApi.addCollaborator(collabEmail.trim().toLowerCase(), 'editor')
                    .then(() => {
                      toast.success(`已添加 ${collabEmail.trim()}`);
                      setCollabEmail('');
                      return workspaceApi.listCollaborators();
                    })
                    .then((d) => setCollaborators(d.collaborators))
                    .catch((e) => toast.error(e instanceof Error ? e.message : '操作失败'))
                    .finally(() => setCollabAdding(false));
                }}
                disabled={collabAdding || !collabEmail.trim()}
                size="sm"
              >
                {collabAdding ? '...' : '添加'}
              </Button>
            </div>
            <div className="space-y-1.5 max-h-40 overflow-y-auto">
              {collabOwner && (
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-muted/30 text-sm">
                  <Crown className="size-3.5 text-amber-500 shrink-0" />
                  <span className="truncate flex-1">{collabOwner}</span>
                  <span className="text-xs text-muted-foreground">所有者</span>
                </div>
              )}
              {collaborators.map((c) => (
                <div key={c.email} className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-muted/30 text-sm">
                  <span className="truncate flex-1">{c.email}</span>
                  <button
                    onClick={() => {
                      workspaceApi.removeCollaborator(c.email)
                        .then(() => setCollaborators((prev) => prev.filter((x) => x.email !== c.email)))
                        .catch((e) => toast.error(e instanceof Error ? e.message : '操作失败'));
                    }}
                    className="size-5 flex items-center justify-center rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-muted-foreground hover:text-red-500 transition-colors shrink-0"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Browser Fabric API Key */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Globe className="size-4 text-muted-foreground" />
              <Label>Browser Fabric API Key</Label>
            </div>
            {workspace.browserfabricApiKey && (
              <p className="text-xs text-muted-foreground font-mono">
                当前：{workspace.browserfabricApiKey}
              </p>
            )}
            <Input
              value={bfApiKey}
              onChange={(e) => setBfApiKey(e.target.value)}
              placeholder={workspace.browserfabricApiKey ? '输入新 Key 以替换' : 'bf_...（可选，留空自动分配）'}
              className="text-xs font-mono"
            />
            <p className="text-xs text-muted-foreground">
              每个工作区会自动获得免费额度 Key；也可以填写自己的 BrowserFabric 账号 Key。
            </p>
          </div>

        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={handleSave} disabled={saving || !name.trim()}>{saving ? '保存中...' : '保存'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
