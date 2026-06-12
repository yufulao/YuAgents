'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import {
  ArrowRight,
  Clock,
  Copy,
  Loader2,
  Plus,
  Settings,
  Trash2,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  createLocalWorkspace,
  deleteLocalWorkspace,
  getLocalWorkspaceToken,
  getLocalWorkspaceTokens,
  listLocalWorkspaces,
  rememberLocalWorkspaceToken,
  verifyWorkspaceAccess,
} from '@/lib/dashboard-api';
import type { Workspace } from '@/lib/types';
import { timeAgo } from '@/lib/helpers';
import { workspaceCreationEnabled, workspaceDirectoryEnabled } from '@/lib/workspace-policy';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export default function HomePage() {
  const router = useRouter();
  const [workspaceNameOrSlug, setWorkspaceNameOrSlug] = useState('');
  const [workspaceToken, setWorkspaceToken] = useState('');
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [entryError, setEntryError] = useState('');
  const [openingWorkspace, setOpeningWorkspace] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [createError, setCreateError] = useState('');
  const [createdWorkspace, setCreatedWorkspace] = useState<{ workspaceId: string; slug: string; name: string; token: string } | null>(null);
  const [managedWorkspace, setManagedWorkspace] = useState<Workspace | null>(null);
  const [managedToken, setManagedToken] = useState('');
  const [manageError, setManageError] = useState('');
  const [loadingToken, setLoadingToken] = useState(false);
  const [deletingWorkspace, setDeletingWorkspace] = useState(false);

  const trimmedNewName = newName.trim();
  const duplicateWorkspaceName = useMemo(
    () => Boolean(trimmedNewName && workspaces.some((workspace) => workspace.name === trimmedNewName)),
    [trimmedNewName, workspaces],
  );

  const loadLocalWorkspaces = useCallback(async () => {
    if (!workspaceDirectoryEnabled) {
      setWorkspaces([]);
      setTokens(getLocalWorkspaceTokens());
      setLoading(false);
      return;
    }
    setLoading(true);
    setListError('');
    try {
      const items = await listLocalWorkspaces();
      setWorkspaces(items);
      setTokens(getLocalWorkspaceTokens());
    } catch (err) {
      setListError(err instanceof Error ? err.message : '读取本机 workspace 失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadLocalWorkspaces();
  }, [loadLocalWorkspaces]);

  const openWorkspace = async (e: React.FormEvent) => {
    e.preventDefault();
    const slug = workspaceNameOrSlug.trim();
    const token = workspaceToken.trim();
    if (!slug) return;
    if (!workspaceDirectoryEnabled && !token) {
      setEntryError('远端入口必须填写 workspace token/password');
      return;
    }
    setOpeningWorkspace(true);
    setEntryError('');
    try {
      const workspace = await verifyWorkspaceAccess(slug, token);
      if (token) rememberLocalWorkspaceToken(workspace.slug, token);
      router.push(token ? `/${workspace.slug}?token=${encodeURIComponent(token)}` : `/${workspace.slug}`);
    } catch (err) {
      setEntryError(err instanceof Error ? err.message : 'workspace 名称/slug 或 token 不正确');
    } finally {
      setOpeningWorkspace(false);
    }
  };

  const openListedWorkspace = (workspace: Workspace) => {
    const token = tokens[workspace.slug];
    if (token) {
      router.push(`/${workspace.slug}?token=${encodeURIComponent(token)}`);
      return;
    }
    setWorkspaceNameOrSlug(workspace.name || workspace.slug);
    setWorkspaceToken('');
  };

  const manageWorkspace = async (workspace: Workspace) => {
    setManagedWorkspace(workspace);
    setManagedToken(tokens[workspace.slug] || '');
    setManageError('');
    setLoadingToken(!tokens[workspace.slug]);
    if (!tokens[workspace.slug]) {
      try {
        const token = await getLocalWorkspaceToken(workspace.slug);
        setManagedToken(token);
        setTokens(getLocalWorkspaceTokens());
      } catch (err) {
        setManageError(err instanceof Error ? err.message : '读取 workspace token 失败');
      } finally {
        setLoadingToken(false);
      }
    }
  };

  const deleteManagedWorkspace = async () => {
    if (!managedWorkspace) return;
    const token = managedToken || tokens[managedWorkspace.slug] || '';
    if (!token) {
      setManageError('缺少 token，无法删除 workspace');
      return;
    }
    if (!window.confirm(`删除 workspace "${managedWorkspace.name}"？这会把它从本机列表移除。`)) return;
    setDeletingWorkspace(true);
    setManageError('');
    try {
      await deleteLocalWorkspace(managedWorkspace.slug, token);
      setManagedWorkspace(null);
      setManagedToken('');
      await loadLocalWorkspaces();
    } catch (err) {
      setManageError(err instanceof Error ? err.message : '删除 workspace 失败');
    } finally {
      setDeletingWorkspace(false);
    }
  };

  const createLocal = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    if (duplicateWorkspaceName) {
      setCreateError('已存在同名 workspace，请换一个名称。');
      return;
    }
    setCreating(true);
    setCreateError('');
    try {
      const ws = await createLocalWorkspace({ name });
      setCreatedWorkspace(ws);
      setWorkspaceNameOrSlug(ws.name);
      setWorkspaceToken(ws.token);
      setTokens(getLocalWorkspaceTokens());
      setNewName('');
      await loadLocalWorkspaces();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : '创建本机 workspace 失败');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-50 border-b bg-background/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2.5">
            <Image src="/logo-icon.png" alt="OpenAgents" width={28} height={28} />
            <span className="text-lg font-semibold">OpenAgents 本地工作台</span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
        <div className="grid items-start gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <section className="space-y-6">
            <div className="space-y-3">
              <Badge variant="secondary" className="w-fit">
                {workspaceDirectoryEnabled ? '本机主控' : '远端入口'}
              </Badge>
              <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
                {workspaceDirectoryEnabled ? '本机 Workspace' : '打开 Workspace'}
              </h1>
              <p className="max-w-2xl leading-relaxed text-muted-foreground">
                {workspaceDirectoryEnabled
                  ? 'Workspace 由本机主控保存和管理。服务器、Web 页面、其他设备只是通过网络入口或 SSH 转发访问本机主控，不把 workspace 放到外部服务。'
                  : '远端 Web 只作为访问入口。请输入已有 workspace 名称/slug 和 token/password 进入，不在公开入口创建或枚举 workspace。'}
              </p>
            </div>

            {workspaceDirectoryEnabled && (
              <div className="rounded-lg border bg-card">
                <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
                  <div>
                    <h2 className="text-sm font-semibold">工作区</h2>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {loading ? '读取中...' : `${workspaces.length} 个本机 workspace`}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" onClick={loadLocalWorkspaces} disabled={loading}>
                    {loading ? <Loader2 className="size-3.5 animate-spin" /> : '刷新'}
                  </Button>
                </div>
                <div className="p-4">
                  {listError && (
                    <div className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                      {listError}
                    </div>
                  )}
                  {loading ? (
                    <div className="flex items-center justify-center py-14 text-muted-foreground">
                      <Loader2 className="size-5 animate-spin" />
                    </div>
                  ) : workspaces.length === 0 ? (
                    <div className="rounded-md border border-dashed px-4 py-8 text-center">
                      <p className="text-sm font-medium">还没有本机 workspace</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {workspaceCreationEnabled ? '在右侧创建一个，或填入已有名称/slug 和 token 打开。' : '填入已有名称/slug 和 token 打开。'}
                      </p>
                    </div>
                  ) : (
                    <div className="grid gap-3 sm:grid-cols-2">
                      {workspaces.map((workspace) => (
                        <div
                          key={workspace.workspaceId}
                          className="rounded-lg border p-3 text-left transition-colors hover:border-primary/40 hover:bg-accent/30"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium">{workspace.name}</div>
                              <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{workspace.slug}</div>
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
                          <div className="mt-3 grid grid-cols-2 gap-2">
                            <Button type="button" size="sm" variant="outline" onClick={() => manageWorkspace(workspace)}>
                              <Settings className="mr-1 size-3.5" />
                              管理
                            </Button>
                            <Button type="button" size="sm" onClick={() => openListedWorkspace(workspace)}>
                              进入
                              <ArrowRight className="ml-1 size-3.5" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>

          <section className="space-y-4">
            {workspaceCreationEnabled && (
              <form onSubmit={createLocal} className="space-y-4 rounded-lg border bg-card p-4 sm:p-5">
                <div>
                  <h2 className="text-sm font-semibold">创建 Workspace</h2>
                  <p className="mt-1 text-xs text-muted-foreground">创建后会显示 token，并保存在当前浏览器。</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="new-workspace-name">名称</Label>
                  <Input
                    id="new-workspace-name"
                    value={newName}
                    onChange={(e) => {
                      setNewName(e.target.value);
                      setCreateError('');
                    }}
                    placeholder="例如 主控室"
                    className={duplicateWorkspaceName ? 'border-destructive focus-visible:ring-destructive/30' : undefined}
                  />
                  {duplicateWorkspaceName && (
                    <p className="text-xs text-destructive">已存在同名 workspace，请换一个名称。</p>
                  )}
                </div>
                {createError && (
                  <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {createError}
                  </div>
                )}
                <Button type="submit" disabled={!trimmedNewName || duplicateWorkspaceName || creating} className="w-full">
                  {creating ? <Loader2 className="mr-1 size-4 animate-spin" /> : <Plus className="mr-1 size-4" />}
                  创建 Workspace
                </Button>
                {createdWorkspace && (
                  <div className="space-y-3 rounded-md border bg-muted/40 p-3">
                    <div>
                      <p className="text-xs font-medium">已创建：{createdWorkspace.name}</p>
                      <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{createdWorkspace.slug}</p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[11px]">管理 Token</Label>
                      <div className="flex gap-2">
                        <Input value={createdWorkspace.token} readOnly className="h-8 font-mono text-xs" />
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
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      className="w-full"
                      onClick={() => router.push(`/${createdWorkspace.slug}?token=${encodeURIComponent(createdWorkspace.token)}`)}
                    >
                      进入工作区
                      <ArrowRight className="ml-1 size-4" />
                    </Button>
                  </div>
                )}
              </form>
            )}

            <form onSubmit={openWorkspace} className="space-y-4 rounded-lg border bg-card p-4 sm:p-5">
              <div>
                <h2 className="text-sm font-semibold">打开指定 Workspace</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {workspaceDirectoryEnabled ? '可填写 workspace 名称或 slug。' : '远端入口只接受已有 workspace 名称/slug 和 token/password。'}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="workspace-slug">工作区名称或 slug</Label>
                <Input
                  id="workspace-slug"
                  value={workspaceNameOrSlug}
                  onChange={(e) => setWorkspaceNameOrSlug(e.target.value)}
                  placeholder="例如 TestSpace 或 0048fff6"
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
              {entryError && (
                <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {entryError}
                </div>
              )}
              <Button type="submit" disabled={!workspaceNameOrSlug.trim() || openingWorkspace} className="w-full">
                {openingWorkspace ? <Loader2 className="mr-1 size-4 animate-spin" /> : null}
                {openingWorkspace ? '验证中...' : '打开工作区'}
                {!openingWorkspace && <ArrowRight className="ml-1 size-4" />}
              </Button>
            </form>

          </section>
        </div>
      </main>

      <Dialog
        open={!!managedWorkspace}
        onOpenChange={(open) => {
          if (!open) {
            setManagedWorkspace(null);
            setManagedToken('');
            setManageError('');
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>管理 Workspace</DialogTitle>
          </DialogHeader>
          {managedWorkspace && (
            <div className="space-y-4">
              <div className="rounded-lg border bg-muted/30 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{managedWorkspace.name}</div>
                    <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
                      {managedWorkspace.slug}
                    </div>
                  </div>
                  <Badge variant={managedWorkspace.status === 'active' ? 'primary' : 'secondary'}>
                    {managedWorkspace.status}
                  </Badge>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-3 text-xs text-muted-foreground">
                  <div>
                    <div className="font-medium text-foreground">{managedWorkspace.agents.length}</div>
                    <div>Agent</div>
                  </div>
                  <div>
                    <div className="font-medium text-foreground">
                      {managedWorkspace.lastActivityAt ? timeAgo(managedWorkspace.lastActivityAt) : '无'}
                    </div>
                    <div>最近活动</div>
                  </div>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="managed-workspace-token">管理 Token</Label>
                <div className="flex gap-2">
                  <Input
                    id="managed-workspace-token"
                    value={loadingToken ? '读取 token...' : managedToken}
                    readOnly
                    className="font-mono text-xs"
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="shrink-0"
                    title="复制 token"
                    disabled={!managedToken || loadingToken}
                    onClick={() => navigator.clipboard?.writeText(managedToken)}
                  >
                    <Copy className="size-4" />
                  </Button>
                </div>
              </div>

              {manageError && (
                <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {manageError}
                </div>
              )}

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
                <Button
                  type="button"
                  variant="destructive"
                  onClick={deleteManagedWorkspace}
                  disabled={loadingToken || deletingWorkspace}
                >
                  {deletingWorkspace ? <Loader2 className="mr-1 size-4 animate-spin" /> : <Trash2 className="mr-1 size-4" />}
                  删除 Workspace
                </Button>
                <Button
                  type="button"
                  disabled={!managedToken || loadingToken}
                  onClick={() => {
                    if (!managedWorkspace || !managedToken) return;
                    router.push(`/${managedWorkspace.slug}?token=${encodeURIComponent(managedToken)}`);
                  }}
                >
                  进入工作区
                  <ArrowRight className="ml-1 size-4" />
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
