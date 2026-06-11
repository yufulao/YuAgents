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
import { listMyWorkspaces, createWorkspace, type WorkspaceSummary } from '@/lib/dashboard-api';
import { timeAgo } from '@/lib/helpers';
import { capture } from '@/lib/analytics';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';

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

  const openWorkspace = (e: React.FormEvent) => {
    e.preventDefault();
    const slug = workspaceSlug.trim();
    const token = workspaceToken.trim();
    if (!slug) return;
    router.push(token ? `/${slug}?token=${encodeURIComponent(token)}` : `/${slug}`);
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

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-10 sm:py-14">
        <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr] items-start">
          <section className="space-y-6">
            <div className="space-y-3">
              <Badge variant="secondary" className="w-fit">本机主控</Badge>
              <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">
                打开你的本地 Agent 工作区
              </h1>
              <p className="text-muted-foreground leading-relaxed max-w-2xl">
                这里是 Web 控制台入口，不是安装教程。后端、前端、Agent 守护进程启动后，在右侧填入工作区信息即可进入聊天、任务、文件和 Agent 管理界面。
              </p>
            </div>

            <form onSubmit={openWorkspace} className="rounded-lg border bg-card p-4 sm:p-5 space-y-4 max-w-xl">
              <div className="space-y-1.5">
                <Label htmlFor="workspace-slug">工作区 ID / slug</Label>
                <Input
                  id="workspace-slug"
                  value={workspaceSlug}
                  onChange={(e) => setWorkspaceSlug(e.target.value)}
                  placeholder="例如 0048fff6"
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="workspace-token">工作区 Token（本地 token 模式需要）</Label>
                <Input
                  id="workspace-token"
                  value={workspaceToken}
                  onChange={(e) => setWorkspaceToken(e.target.value)}
                  placeholder="粘贴 token；已登录或公开入口可留空"
                  type="password"
                />
              </div>
              <Button type="submit" disabled={!workspaceSlug.trim()} className="w-full sm:w-auto">
                打开工作区
                <ArrowRight className="size-4 ml-1" />
              </Button>
            </form>
          </section>

          <section className="rounded-lg border bg-card p-4 sm:p-5 space-y-4">
            <div>
              <h2 className="text-sm font-semibold">本机启动</h2>
              <p className="text-xs text-muted-foreground mt-1">
                从仓库根目录执行。完整启动用第一条；只调前端时用第二条。
              </p>
            </div>
            <CodeBlock code={`cd workspace\nmake dev`} />
            <CodeBlock code={`cd workspace/frontend\nnpm run dev`} />
            <div className="rounded-md bg-muted/60 p-3 text-xs text-muted-foreground leading-relaxed">
              前端默认地址是 <span className="font-mono text-foreground">http://localhost:3001</span>。进入工作区后，左侧「连接 Agent」负责创建和管理 Agent 配置。
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
          {!showCreate && (
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
        {showCreate && (
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
