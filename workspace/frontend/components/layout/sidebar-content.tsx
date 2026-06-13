'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  BookOpen,
  CalendarClock,
  Check,
  FileText,
  Globe,
  Inbox,
  KeyRound,
  ListTodo,
  MessageSquare,
  Moon,
  Network,
  Plus,
  PlusSquare,
  Settings,
  Sun,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useLayout } from './layout-context';
import { useWorkspace } from '@/lib/workspace-context';
import { workspaceApi } from '@/lib/api';
import { getAgentModelLabel } from '@/lib/agent-display';
import { withWorkspaceIdentityProfile } from '@/lib/identity';
import type { WorkspaceAgent } from '@/lib/types';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { AgentActivityPanel } from '@/components/agents/agent-activity-panel';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { NewThreadDialog } from '@/components/threads/new-thread-dialog';

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
        'flex h-8 w-full items-center gap-2 rounded-lg px-2 text-[13px] transition-colors',
        active
          ? 'bg-zinc-100 font-medium text-primary dark:bg-zinc-800'
          : 'font-normal text-foreground hover:bg-zinc-100 hover:text-primary dark:hover:bg-zinc-800',
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

function AgentListButton({ agent, status, onClick }: { agent: WorkspaceAgent; status: string; onClick: () => void }) {
  const modelLabel = getAgentModelLabel(agent);
  return (
    <button
      onClick={onClick}
      className="group flex min-h-9 w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1 transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
    >
      <AgentAvatar
        name={agent.agentName}
        avatar={agent.avatar}
        avatarUrl={agent.avatarUrl}
        size={20}
        status={status}
        showStatus
      />
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-[13px] font-normal leading-tight text-foreground group-hover:text-primary">
          {agent.agentName}
        </span>
        {modelLabel && (
          <span className="block truncate font-mono text-[10px] leading-tight text-muted-foreground">
            {modelLabel}
          </span>
        )}
      </span>
    </button>
  );
}

export function SidebarContent() {
  const router = useRouter();
  const { isSidebarOpen, sidebarToggle, viewMode, setViewMode, setSelectedAgentName } = useLayout();
  const {
    agents,
    sessions,
    files,
    browserTabs,
    createSession,
    workspace,
    token,
    refreshWorkspace,
    todos,
    routines,
    knowledge,
    unreadNotificationCount,
    activeSessionIds,
  } = useWorkspace();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newThreadOpen, setNewThreadOpen] = useState(false);
  const [tokenCopied, setTokenCopied] = useState(false);

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

  const visibleAgents = agents;
  const onlineCount = agents.filter((agent) => agent.status === 'online').length;
  const agentStatusDot = (agent: typeof agents[number]) =>
    agent.activityState && agent.activityState !== 'idle'
      ? agent.activityState
      : agent.presenceStatus || agent.status;

  if (!isSidebarOpen) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex justify-center px-2.5 py-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleNewThread}
                className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-colors hover:bg-primary/90"
              >
                <Plus className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">新建会话</TooltipContent>
          </Tooltip>
        </div>

        <div className="flex flex-1 flex-col items-center gap-2 py-3">
          {visibleAgents.map((agent) => (
            <Tooltip key={agent.agentName}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setSelectedAgentName(agent.agentName)}
                  className="cursor-pointer rounded-full transition-shadow hover:ring-2 hover:ring-zinc-300 dark:hover:ring-zinc-600"
                >
                  <AgentAvatar
                    name={agent.agentName}
                    avatar={agent.avatar}
                    avatarUrl={agent.avatarUrl}
                    size={28}
                    status={agentStatusDot(agent)}
                    showStatus
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">{agent.agentName}</TooltipContent>
            </Tooltip>
          ))}
        </div>

        <div className="space-y-1 px-2.5 py-3">
          {workspace && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => router.push('/')}
                  className="flex w-full items-center justify-center rounded-lg py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  <Network className="size-4 text-muted-foreground" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">返回 Workspace 入口</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button onClick={toggleTheme} className="flex w-full items-center justify-center rounded-lg py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                {isDark ? <Sun className="size-4 text-muted-foreground" /> : <Moon className="size-4 text-muted-foreground" />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{isDark ? '浅色模式' : '深色模式'}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button onClick={sidebarToggle} className="flex w-full items-center justify-center rounded-lg py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                <Settings className="size-4 text-muted-foreground" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">设置</TooltipContent>
          </Tooltip>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="flex h-full flex-col">
        <ScrollArea className="min-h-0 flex-1">
          <div className="px-3.5 pb-3">
            <button
              onClick={handleNewThread}
              className="flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-primary text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <Plus className="size-4" />
              <span>新建会话</span>
            </button>
          </div>

          <div className="px-2.5">
            <p className="mb-0.5 px-2 py-1.5 text-xs font-normal text-muted-foreground">
              Agents（{onlineCount}/{visibleAgents.length}）
            </p>
            <div className="max-h-48 space-y-0.5 overflow-y-auto">
              {visibleAgents.map((agent) => (
                <AgentListButton
                  key={agent.agentName}
                  agent={agent}
                  status={agentStatusDot(agent)}
                  onClick={() => setSelectedAgentName(agent.agentName)}
                />
              ))}
            </div>

            <AgentActivityPanel
              agents={visibleAgents}
              sessions={sessions}
              activeSessionIds={activeSessionIds}
              onRefresh={refreshWorkspace}
            />

            <p className="mb-0.5 mt-6 px-2 py-1.5 text-xs font-normal text-muted-foreground">
              功能
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
                </>
              )}
            </div>
          </div>
        </ScrollArea>

        <div className="shrink-0 px-2.5 pb-1">
          <NavButton active={viewMode === 'connect'} icon={<PlusSquare className="size-[15px]" />} label="创建 Agent" onClick={() => setViewMode('connect')} />
        </div>
        <div className="shrink-0 space-y-1 border-t border-border px-2.5 py-2.5">
          {workspace && (
            <button
              onClick={() => router.push('/')}
              className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-[13px] transition-colors hover:bg-muted"
              title="返回 Workspace 入口"
            >
              <Network className="size-[15px] text-muted-foreground" />
              <span className="flex-1 truncate text-left">{workspace.name}</span>
              <span className="max-w-[68px] truncate font-mono text-[10px] text-muted-foreground">{workspace.slug}</span>
            </button>
          )}

          <div className="flex items-center gap-1 px-1">
            <div className="flex-1" />
            <button
              onClick={toggleTheme}
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title={isDark ? '浅色模式' : '深色模式'}
            >
              {isDark ? <Sun className="size-[15px]" /> : <Moon className="size-[15px]" />}
            </button>
            {token && (
              <button
                onClick={handleCopyToken}
                className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title={tokenCopied ? '已复制' : '复制工作区 Token'}
              >
                {tokenCopied ? <Check className="size-[15px]" /> : <KeyRound className="size-[15px]" />}
              </button>
            )}
            <button
              onClick={() => setSettingsOpen(true)}
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title="设置"
            >
              <Settings className="size-[15px]" />
            </button>
          </div>
        </div>
      </div>

      <SettingsDialogPortal open={settingsOpen} onOpenChange={setSettingsOpen} workspace={workspace} refreshWorkspace={refreshWorkspace} />

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

function SettingsDialogPortal({
  open,
  onOpenChange,
  workspace,
  refreshWorkspace,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  workspace: ReturnType<typeof useWorkspace>['workspace'];
  refreshWorkspace: () => Promise<void>;
}) {
  const [name, setName] = useState(workspace?.name || '');
  const [monitorMode, setMonitorMode] = useState(false);
  const [userName, setUserNameDraft] = useState('');
  const [userAvatar, setUserAvatar] = useState('');
  const [saving, setSaving] = useState(false);
  const { currentUser, setUserProfile, notificationSound, setNotificationSound } = useWorkspace();
  const { splitBrowser, setSplitBrowser } = useLayout();

  useEffect(() => {
    if (open && workspace) {
      setName(workspace.name);
      setMonitorMode(!!workspace.settings?.monitorMode);
      setUserNameDraft(currentUser.name || '');
      setUserAvatar(currentUser.avatarUrl || '');
    }
  }, [open, workspace, currentUser.name, currentUser.avatarUrl]);

  if (!workspace) return null;

  const handleSave = async () => {
    if (!name.trim() || !userName.trim()) return;
    setSaving(true);
    try {
      await workspaceApi.updateWorkspace({
        name: name.trim(),
        settings: withWorkspaceIdentityProfile(
          { ...workspace.settings, monitorMode },
          {
            id: currentUser.id,
            name: userName.trim(),
            avatarUrl: userAvatar.trim() || null,
          },
        ),
      });
      setUserProfile({
        name: userName.trim(),
        avatarUrl: userAvatar.trim() || null,
      });
      await refreshWorkspace();
      toast.success('设置已保存');
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存设置失败');
    } finally {
      setSaving(false);
    }
  };

  const handleAvatarFile = (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('请选择图片文件');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setUserAvatar(String(reader.result || ''));
    reader.onerror = () => toast.error('读取头像失败');
    reader.readAsDataURL(file);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader><DialogTitle>工作区设置</DialogTitle></DialogHeader>
        <div className="space-y-6 py-4">
          <div className="space-y-2">
            <Label>工作区名称</Label>
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="我的工作区" />
          </div>

          <div className="space-y-3 rounded-lg border border-input px-4 py-3">
            <div className="space-y-0.5">
              <Label>本人资料</Label>
              <p className="text-xs text-muted-foreground">用于本机发送的消息显示。</p>
            </div>
            <div className="flex items-center gap-3">
              <AgentAvatar
                name={userName || currentUser.name || '我'}
                avatar={userAvatar ? { type: 'upload', value: userAvatar } : null}
                size={40}
                square
              />
              <div className="min-w-0 flex-1 space-y-2">
                <Input value={userName} onChange={(event) => setUserNameDraft(event.target.value)} placeholder="显示名称" />
                <div className="flex items-center gap-2">
                  <Input
                    value={userAvatar}
                    onChange={(event) => setUserAvatar(event.target.value)}
                    placeholder="头像图片 URL 或 data URL"
                    className="font-mono text-xs"
                  />
                  <label className="inline-flex h-9 shrink-0 cursor-pointer items-center rounded-md border px-3 text-xs hover:bg-muted">
                    选择图片
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(event) => handleAvatarFile(event.target.files?.[0] || null)}
                    />
                  </label>
                </div>
                {userAvatar && (
                  <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setUserAvatar('')}>
                    清除头像
                  </Button>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-lg border border-input px-4 py-3">
            <div className="space-y-0.5">
              <Label>监控模式</Label>
              <p className="text-xs text-muted-foreground">用 2x3 网格展示最近会话，而不是列表。</p>
            </div>
            <Switch checked={monitorMode} onCheckedChange={setMonitorMode} size="sm" />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-lg border border-input px-4 py-3">
            <div className="space-y-0.5">
              <Label>通知音效</Label>
              <p className="text-xs text-muted-foreground">Agent 完成任务时播放提示音。</p>
            </div>
            <Switch checked={notificationSound} onCheckedChange={setNotificationSound} size="sm" />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-lg border border-input px-4 py-3">
            <div className="space-y-0.5">
              <Label>分屏浏览器</Label>
              <p className="text-xs text-muted-foreground">查看会话时让浏览器标签与聊天并排显示。</p>
            </div>
            <Switch checked={splitBrowser} onCheckedChange={setSplitBrowser} size="sm" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={handleSave} disabled={saving || !name.trim() || !userName.trim()}>{saving ? '保存中...' : '保存'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
