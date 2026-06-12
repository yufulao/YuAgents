'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import {
  Bot, Plus, LogOut, Users, Clock, Archive, Loader2,
  Terminal, Copy, Check, ArrowRight, Download,
  Network, Zap, Shield, MonitorSmartphone,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/lib/auth-context';
import { useOpenAgentsAuth } from '@/lib/openagents-auth-context';
import {
  listMyWorkspaces,
  createWorkspace,
  listLocalWorkspaces,
  createLocalWorkspace,
  getLocalWorkspaceTokens,
  rememberLocalWorkspaceToken,
  type WorkspaceSummary,
} from '@/lib/dashboard-api';
import type { Workspace } from '@/lib/types';
import { timeAgo } from '@/lib/helpers';
import { capture } from '@/lib/analytics';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { workspaceCreationEnabled, workspaceDirectoryEnabled } from '@/lib/workspace-policy';

// ---------------------------------------------------------------------------
// Copyable Code Block
// ---------------------------------------------------------------------------

function CodeBlock({ code, className = '' }: { code: string; className?: string }) {
  const { isCopied, copyToClipboard } = useCopyToClipboard();

  return (
    <div className={`relative group ${className}`}>
      <pre className="bg-zinc-900 text-zinc-100 rounded-lg px-4 py-3 text-sm font-mono leading-relaxed overflow-x-auto">
        <code>{code}</code>
      </pre>
      <button
        className="absolute top-2 right-2 size-7 flex items-center justify-center rounded-md bg-zinc-700/80 hover:bg-zinc-600 text-zinc-300 hover:text-white opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity"
        title="Copy"
        onClick={() => copyToClipboard(code)}
      >
        {isCopied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Landing Page (unauthenticated)
// ---------------------------------------------------------------------------

function LandingPage() {
  const { isOpenAgentsDomain, signIn } = useOpenAgentsAuth();
  const router = useRouter();
  const [workspaceSlug, setWorkspaceSlug] = useState('');
  const [workspaceToken, setWorkspaceToken] = useState('');
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newAgent, setNewAgent] = useState('');
  const [createdWorkspace, setCreatedWorkspace] = useState<{ workspaceId: string; slug: string; name: string; token: string } | null>(null);

  const loadLocalWorkspaces = useCallback(async () => {
    if (!workspaceDirectoryEnabled) {
      setWorkspaces([]);
      setTokens(getLocalWorkspaceTokens());
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const items = await listLocalWorkspaces();
      setWorkspaces(items);
      setTokens(getLocalWorkspaceTokens());
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取本机工作区失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadLocalWorkspaces();
  }, [loadLocalWorkspaces]);

  const openWorkspace = (e: React.FormEvent) => {
    e.preventDefault();
    const slug = workspaceSlug.trim();
    const token = workspaceToken.trim();
    if (!slug) return;
    if (token) rememberLocalWorkspaceToken(slug, token);
    router.push(token ? `/${slug}?token=${encodeURIComponent(token)}` : `/${slug}`);
  };

  const openListedWorkspace = (workspace: Workspace) => {
    const token = tokens[workspace.slug];
    if (token) {
      router.push(`/${workspace.slug}?token=${encodeURIComponent(token)}`);
      return;
    }
    setWorkspaceSlug(workspace.slug);
    setWorkspaceToken('');
  };

  const createLocal = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setError('');
    try {
      const ws = await createLocalWorkspace({
        name,
        agentName: newAgent.trim() || undefined,
        agentType: newAgent.trim() ? 'codex' : undefined,
      });
      setCreatedWorkspace(ws);
      setWorkspaceSlug(ws.slug);
      setWorkspaceToken(ws.token);
      setTokens(getLocalWorkspaceTokens());
      await loadLocalWorkspaces();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建本机工作区失败');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-50 border-b bg-background/80 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Image src="/logo-icon.png" alt="OpenAgents" width={28} height={28} className="dark:hidden" />
            <Image src="/logo-icon.png" alt="OpenAgents" width={28} height={28} className="hidden dark:block" />
            <span className="font-semibold text-lg">OpenAgents 本地工作台</span>
          </div>
          <div className="flex items-center gap-3">
            {isOpenAgentsDomain && (
              <Button size="sm" variant="outline" onClick={signIn}>
                登录
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8 sm:py-10">
        <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr] items-start">
          <section className="space-y-6">
            <div className="space-y-3">
              <Badge variant="secondary" className="w-fit">{workspaceDirectoryEnabled ? '本机主控' : '远端入口'}</Badge>
              <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">
                {workspaceDirectoryEnabled ? '本机 Workspace' : '打开 Workspace'}
              </h1>
              <p className="text-muted-foreground leading-relaxed max-w-2xl">
                {workspaceDirectoryEnabled
                  ? 'Workspace 由本机主控保存和管理。服务器、Web 页面、其他设备只是通过网络入口或 SSH 转发访问本机主控，不把 workspace 放到云端。'
                  : '远端 Web 只作为访问入口。请输入已有 workspace slug 和 token/password 进入，不在公开入口创建或枚举 workspace。'}
              </p>
            </div>

            {workspaceDirectoryEnabled && (
            <div className="rounded-lg border bg-card">
              <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
                <div>
                  <h2 className="text-sm font-semibold">工作区</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {loading ? '读取中...' : `${workspaces.length} 个本机 workspace`}
                  </p>
                </div>
                <Button size="sm" variant="outline" onClick={loadLocalWorkspaces} disabled={loading}>
                  {loading ? <Loader2 className="size-3.5 animate-spin" /> : '刷新'}
                </Button>
              </div>
              <div className="p-4">
                {error && (
                  <div className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {error}
                  </div>
                )}
                {loading ? (
                  <div className="flex items-center justify-center py-14 text-muted-foreground">
                    <Loader2 className="size-5 animate-spin" />
                  </div>
                ) : workspaces.length === 0 ? (
                  <div className="rounded-md border border-dashed px-4 py-8 text-center">
                    <p className="text-sm font-medium">还没有本机 workspace</p>
                    <p className="text-xs text-muted-foreground mt-1">{workspaceCreationEnabled ? '在右侧创建一个，或填入已有 slug/token 打开。' : '填入已有 slug/token 打开。'}</p>
                  </div>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {workspaces.map((workspace) => (
                      <button
                        key={workspace.workspaceId}
                        onClick={() => openListedWorkspace(workspace)}
                        className="rounded-lg border p-3 text-left hover:border-primary/40 hover:bg-accent/30 transition-colors"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-sm font-medium truncate">{workspace.name}</div>
                            <div className="mt-0.5 text-xs text-muted-foreground font-mono truncate">{workspace.slug}</div>
                          </div>
                          <Badge variant={tokens[workspace.slug] ? 'primary' : 'secondary'} className="shrink-0 text-[10px]">
                            {tokens[workspace.slug] ? '可进入' : '需 token'}
                          </Badge>
                        </div>
                        <div className="mt-3 flex items-center gap-4 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Users className="size-3" />
                            {workspace.agents.length} Agent
                          </span>
                          {workspace.lastActivityAt && (
                            <span className="flex items-center gap-1">
                              <Clock className="size-3" />
                              {timeAgo(workspace.lastActivityAt)}
                            </span>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            )}
          </section>

          <section className="space-y-4">
            {workspaceCreationEnabled && (
            <form onSubmit={createLocal} className="rounded-lg border bg-card p-4 sm:p-5 space-y-4">
              <div>
                <h2 className="text-sm font-semibold">创建 Workspace</h2>
                <p className="text-xs text-muted-foreground mt-1">创建后会显示 token，并保存在当前浏览器。</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-workspace-name">名称</Label>
                <Input
                  id="new-workspace-name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="例如 主控室"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-workspace-agent">初始 Agent（可选）</Label>
                <Input
                  id="new-workspace-agent"
                  value={newAgent}
                  onChange={(e) => setNewAgent(e.target.value)}
                  placeholder="例如 yukari"
                />
              </div>
              <Button type="submit" disabled={!newName.trim() || creating} className="w-full">
                {creating ? <Loader2 className="size-4 animate-spin mr-1" /> : <Plus className="size-4 mr-1" />}
                创建 Workspace
              </Button>
              {createdWorkspace && (
                <div className="rounded-md border bg-muted/40 p-3 space-y-3">
                  <div>
                    <p className="text-xs font-medium">已创建：{createdWorkspace.name}</p>
                    <p className="text-[11px] text-muted-foreground font-mono mt-0.5">{createdWorkspace.slug}</p>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[11px]">管理 Token</Label>
                    <div className="flex gap-2">
                      <Input value={createdWorkspace.token} readOnly className="h-8 text-xs font-mono" />
                      <Button
                        type="button"
                        size="icon"
                        variant="outline"
                        className="size-8 shrink-0"
                        title="复制 token"
                        onClick={() => navigator.clipboard?.writeText(createdWorkspace.token)}
                      >
                        <Copy className="size-3.5" />
                      </Button>
                    </div>
                    <p className="text-[10px] text-muted-foreground">如果自动进入失败，用这个 slug/token 在下方打开。</p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    className="w-full"
                    onClick={() => router.push(`/${createdWorkspace.slug}?token=${encodeURIComponent(createdWorkspace.token)}`)}
                  >
                    进入工作区
                    <ArrowRight className="size-4 ml-1" />
                  </Button>
                </div>
              )}
            </form>
            )}

            <form onSubmit={openWorkspace} className="rounded-lg border bg-card p-4 sm:p-5 space-y-4">
              <div>
                <h2 className="text-sm font-semibold">打开指定 Workspace</h2>
                <p className="text-xs text-muted-foreground mt-1">
                  {workspaceDirectoryEnabled ? '选择左侧无 token 的 workspace 时，也会填到这里。' : '远端入口只接受已有 workspace slug 和 token/password。'}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="workspace-slug">工作区 slug</Label>
                <Input
                  id="workspace-slug"
                  value={workspaceSlug}
                  onChange={(e) => setWorkspaceSlug(e.target.value)}
                  placeholder="例如 0048fff6"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="workspace-token">管理 Token</Label>
                <Input
                  id="workspace-token"
                  value={workspaceToken}
                  onChange={(e) => setWorkspaceToken(e.target.value)}
                  placeholder="粘贴 token 后进入"
                  type="password"
                />
              </div>
              <Button type="submit" disabled={!workspaceSlug.trim()} className="w-full">
                打开工作区
                <ArrowRight className="size-4 ml-1" />
              </Button>
            </form>

            <div className="rounded-lg border bg-card p-4 sm:p-5 space-y-4">
            <div>
              <h2 className="text-sm font-semibold">访问关系</h2>
              <p className="text-xs text-muted-foreground mt-1">
                其他设备打开 Web；Agent 设备连接本机主控 API。
              </p>
            </div>
            <CodeBlock code={`Web: http://<你的入口>:3000\nAPI: http://<你的入口>:8000`} />
            <div className="rounded-md bg-muted/60 p-3 text-xs text-muted-foreground leading-relaxed">
              如果部署在 Linux 服务器，Linux 只做入口或 SSH 转发；workspace 数据和 Agent CLI 配置仍归本机主控。
            </div>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

function FeatureCard({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return (
    <div className="rounded-lg border bg-card p-5 space-y-3">
      <div className="size-10 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
        {icon}
      </div>
      <h3 className="font-semibold">{title}</h3>
      <p className="text-sm text-muted-foreground leading-relaxed">{description}</p>
    </div>
  );
}

function CLIGroup({ title, commands }: { title: string; commands: { cmd: string; desc: string }[] }) {
  return (
    <div>
      <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider mb-3">{title}</h3>
      <div className="rounded-lg border bg-card overflow-hidden divide-y">
        {commands.map((c) => (
          <div key={c.cmd} className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 px-4 py-2.5">
            <code className="text-sm font-mono text-foreground whitespace-nowrap">{c.cmd}</code>
            <span className="text-sm text-muted-foreground">{c.desc}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create Workspace Dialog (inline)
// ---------------------------------------------------------------------------

function CreateWorkspaceForm({
  onCreated,
  onCancel,
}: {
  onCreated: () => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const [agentName, setAgentName] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!agentName.trim()) return;
    setError('');
    setLoading(true);
    try {
      const ws = await createWorkspace(agentName.trim(), name.trim() || undefined);
      capture('workspace_created', { agent_name: agentName.trim() });
      onCreated();
      router.push(`/${ws.slug}?token=${ws.token}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '创建工作区失败');
      setLoading(false);
    }
  };

  return (
    <Card className="border-dashed">
      <CardContent className="p-4">
        <form onSubmit={handleSubmit} className="space-y-3">
          <h3 className="font-medium text-sm">新建工作区</h3>
          <div className="space-y-2">
            <Input
              placeholder="Agent 名称（必填）"
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
              required
              autoFocus
            />
            <Input
              placeholder="工作区名称（可选）"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={loading}>
              {loading ? <Loader2 className="size-3 animate-spin mr-1" /> : <Plus className="size-3 mr-1" />}
              创建
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
              取消
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Workspace Card
// ---------------------------------------------------------------------------

function WorkspaceCard({ workspace }: { workspace: WorkspaceSummary }) {
  const router = useRouter();

  return (
    <Card
      className="cursor-pointer transition-colors hover:border-primary/30 hover:bg-accent/5"
      onClick={() => router.push(`/${workspace.slug}?token=${workspace.token}`)}
    >
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="font-medium truncate">{workspace.name}</h3>
            <p className="text-xs text-muted-foreground font-mono">{workspace.slug}</p>
          </div>
          <Badge variant={workspace.status === 'active' ? 'primary' : 'secondary'} className="shrink-0 text-xs">
            {workspace.status === 'archived' && <Archive className="size-3 mr-1" />}
            {workspace.status === 'active' ? '活跃' : workspace.status === 'archived' ? '已归档' : workspace.status}
          </Badge>
        </div>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Users className="size-3" />
            {workspace.agentCount} 个 Agent
          </span>
          {workspace.lastActivityAt && (
            <span className="flex items-center gap-1">
              <Clock className="size-3" />
              {timeAgo(workspace.lastActivityAt)}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function Dashboard() {
  const { user, logout } = useAuth();
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await listMyWorkspaces();
      setWorkspaces(data.items);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '加载工作区失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-card">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Bot className="size-5 text-primary" />
            <h1 className="font-semibold">工作区</h1>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground hidden sm:inline">{user?.email}</span>
            <Button variant="ghost" size="sm" onClick={logout}>
              <LogOut className="size-4" />
            </Button>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-5xl mx-auto px-4 py-6">
        {/* Actions bar */}
        <div className="flex items-center justify-between mb-6">
          <p className="text-sm text-muted-foreground">
            {loading ? '加载中...' : `${workspaces.length} 个工作区`}
          </p>
          {workspaceCreationEnabled && !showCreate && (
            <Button size="sm" onClick={() => setShowCreate(true)}>
              <Plus className="size-4 mr-1" />
              新建工作区
            </Button>
          )}
        </div>

        {error && (
          <div className="mb-6 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
            {error}
          </div>
        )}

        {/* Create form */}
        {workspaceCreationEnabled && showCreate && (
          <div className="mb-6">
            <CreateWorkspaceForm
              onCreated={() => {
                setShowCreate(false);
                load();
              }}
              onCancel={() => setShowCreate(false)}
            />
          </div>
        )}

        {/* Workspace grid */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : workspaces.length === 0 ? (
          <div className="text-center py-20 space-y-3">
            <Bot className="size-10 mx-auto text-muted-foreground/40" />
            <p className="text-muted-foreground">还没有工作区</p>
            <p className="text-sm text-muted-foreground/70">
              可以新建一个，或从本地启动脚本创建后在首页打开。
            </p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {workspaces.map((ws) => (
              <WorkspaceCard key={ws.workspaceId} workspace={ws} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page Root
// ---------------------------------------------------------------------------

export default function HomePage() {
  const { user, loading } = useAuth();
  const openAgentsAuth = useOpenAgentsAuth();

  if (loading || openAgentsAuth.loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Logged in via either auth system → show dashboard
  if (user || openAgentsAuth.user) return <Dashboard />;

  // Not logged in → show landing page
  return <LandingPage />;
}
