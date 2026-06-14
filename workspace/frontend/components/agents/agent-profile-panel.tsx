'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import {
  Check,
  Copy,
  Cpu,
  Folder,
  Monitor,
  Pencil,
  Power,
  RefreshCw,
  Trash2,
  Upload,
  UserRoundCog,
  X,
  Zap,
} from 'lucide-react';
import { useLayout } from '@/components/layout/layout-context';
import { useWorkspace } from '@/lib/workspace-context';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { getAgentModelLabel, getInstalledSkillIds } from '@/lib/agent-display';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { workspaceApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

export function AgentProfilePanel() {
  const { selectedAgentName, setSelectedAgentName, isMobile, agentPanelWidth, setAgentPanelWidth } = useLayout();
  const { agents, refreshWorkspace } = useWorkspace();
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const panelRef = useRef<HTMLDivElement | null>(null);

  const agent = agents.find((item) => item.agentName === selectedAgentName);
  const isDisabled = agent?.lifecycleState === 'stopped' || agent?.status === 'stopped';

  const [editingConfig, setEditingConfig] = useState(false);
  const [displayNameDraft, setDisplayNameDraft] = useState('');
  const [avatarDraft, setAvatarDraft] = useState('');
  const [workingDirDraft, setWorkingDirDraft] = useState('');
  const [modelDraft, setModelDraft] = useState('');
  const [qualityDraft, setQualityDraft] = useState('medium');
  const [codexFastDraft, setCodexFastDraft] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [controlBusy, setControlBusy] = useState<{ agentName: string; action: 'start' | 'restart' | 'stop' } | null>(null);
  const configDraftAgentRef = useRef<string | null>(null);

  useEffect(() => {
    if (!selectedAgentName) {
      configDraftAgentRef.current = null;
      setEditingConfig(false);
      return;
    }
  }, [selectedAgentName]);

  useEffect(() => {
    if (!agent) return;
    const agentChanged = configDraftAgentRef.current !== agent.agentName;
    if (agentChanged) {
      configDraftAgentRef.current = agent.agentName;
      setEditingConfig(false);
    } else if (editingConfig || savingConfig) {
      return;
    }
    setDisplayNameDraft(agent.displayName || agent.agentName);
    setAvatarDraft(agent.avatarUrl || (agent.avatar?.type === 'upload' ? agent.avatar.value : ''));
    setWorkingDirDraft(agent.workingDir || '');
    setModelDraft(agent.modelName || agent.model || '');
    setQualityDraft(agent.quality || 'medium');
    setCodexFastDraft(agent.managedMetadata?.codex_service_tier === 'fast');
  }, [agent, editingConfig, savingConfig]);

  const handleAvatarFile = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('请选择图片文件');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setAvatarDraft(reader.result);
      }
    };
    reader.onerror = () => toast.error('读取头像文件失败');
    reader.readAsDataURL(file);
  };

  const handleSaveConfig = useCallback(async () => {
    if (!agent) return;
    setSavingConfig(true);
    try {
      const nextMetadata = {
        ...(agent.managedMetadata || {}),
        codex_service_tier: agent.agentType === 'codex' && codexFastDraft ? 'fast' : 'default',
      };
      await workspaceApi.updateManagedAgent(agent.agentName, {
        displayName: displayNameDraft.trim() || agent.agentName,
        avatarUrl: avatarDraft.trim(),
        workingDir: workingDirDraft.trim(),
        modelName: modelDraft.trim(),
        quality: qualityDraft,
        managedMetadata: nextMetadata,
      });
      await refreshWorkspace();
      setEditingConfig(false);
      toast.success('Agent 配置已保存');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存 Agent 配置失败');
    } finally {
      setSavingConfig(false);
    }
  }, [agent, displayNameDraft, avatarDraft, workingDirDraft, modelDraft, qualityDraft, codexFastDraft, refreshWorkspace]);

  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [descDirty, setDescDirty] = useState(false);
  const descriptionAgentRef = useRef<string | null>(null);

  useEffect(() => {
    if (!selectedAgentName) {
      descriptionAgentRef.current = null;
      setDescDirty(false);
      return;
    }
  }, [selectedAgentName]);

  useEffect(() => {
    if (!agent) return;
    const agentChanged = descriptionAgentRef.current !== agent.agentName;
    if (agentChanged) {
      descriptionAgentRef.current = agent.agentName;
    } else if (descDirty || saving) {
      return;
    }
    setDescription(agent.description || '');
    setDescDirty(false);
  }, [agent?.agentName, agent?.description, descDirty, saving]);

  const handleSaveDescription = useCallback(async () => {
    if (!agent || !descDirty) return;
    setSaving(true);
    try {
      await workspaceApi.updateMember(agent.agentName, { description });
      await refreshWorkspace();
      setDescDirty(false);
      toast.success('说明已保存');
    } catch {
      toast.error('保存说明失败');
    } finally {
      setSaving(false);
    }
  }, [agent, description, descDirty, refreshWorkspace]);

  const handleLocalAgentControl = useCallback(async (action: 'start' | 'restart' | 'stop') => {
    if (!agent) return;
    const controlledAgentName = agent.agentName;
    setControlBusy({ agentName: controlledAgentName, action });
    try {
      await workspaceApi.controlManagedAgent(controlledAgentName, action);
      const refreshDelays = [1000, 3000, 6000, 10000, 20000];
      const scheduleRefreshes = () => refreshDelays.forEach((delay) => {
        window.setTimeout(() => {
          refreshWorkspace().catch(() => undefined);
        }, delay);
      });
      scheduleRefreshes();
      let refreshDelayed = false;
      try {
        await refreshWorkspace();
      } catch {
        // The control command already succeeded. A transient refresh/network
        // failure should not be shown as a failed start when the daemon may
        // already be joining and subsequent polls will catch up.
        refreshDelayed = true;
      }
      toast.success(
        refreshDelayed
          ? 'Agent 操作已发送，状态稍后自动同步'
          : action === 'restart' ? 'Agent 正在重启' : action === 'stop' ? 'Agent 已停止' : 'Agent 正在启动',
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Agent 操作失败');
    } finally {
      setControlBusy((current) => (
        current?.agentName === controlledAgentName && current.action === action ? null : current
      ));
    }
  }, [agent, refreshWorkspace]);

  const handleRemoveAgent = useCallback(async () => {
    if (!agent) return;
    try {
      await workspaceApi.deleteManagedAgent(agent.agentName);
      toast.success(`已移除 Agent "${agent.agentName}"`);
      setSelectedAgentName(null);
      refreshWorkspace();
    } catch {
      toast.error('移除 Agent 失败');
    }
  }, [agent, setSelectedAgentName, refreshWorkspace]);

  const handleToggleDisabled = useCallback(async () => {
    if (!agent) return;
    const next = isDisabled ? 'active' : 'disabled';
    try {
      await workspaceApi.updateManagedAgent(agent.agentName, { lifecycleStatus: next });
      await refreshWorkspace();
      toast.success(next === 'active' ? 'Agent 已启用' : 'Agent 已停用');
    } catch {
      toast.error('更新 Agent 状态失败');
    }
  }, [agent, isDisabled, refreshWorkspace]);

  const handleResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (isMobile) return;
    event.preventDefault();

    const right = panelRef.current?.getBoundingClientRect().right ?? window.innerWidth;
    const body = document.body;
    const previousCursor = body.style.cursor;
    const previousUserSelect = body.style.userSelect;

    body.style.cursor = 'col-resize';
    body.style.userSelect = 'none';

    const updateWidth = (clientX: number) => {
      setAgentPanelWidth(right - clientX);
    };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      updateWidth(moveEvent.clientX);
    };

    const handlePointerUp = () => {
      body.style.cursor = previousCursor;
      body.style.userSelect = previousUserSelect;
      window.removeEventListener('pointermove', handlePointerMove);
    };

    updateWidth(event.clientX);
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp, { once: true });
  }, [isMobile, setAgentPanelWidth]);

  const handleResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isMobile) return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setAgentPanelWidth(agentPanelWidth + 16);
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      setAgentPanelWidth(agentPanelWidth - 16);
    }
  }, [agentPanelWidth, isMobile, setAgentPanelWidth]);

  if (!agent) return null;

  const isOnline = agent.status === 'online';
  const isStarting = agent.status === 'starting';
  const localPrimaryAction: 'start' | 'restart' = isOnline || isStarting ? 'restart' : 'start';
  const currentControlBusy = controlBusy?.agentName === agent.agentName ? controlBusy.action : null;
  const profileStatus = agent.activityState && agent.activityState !== 'idle'
    ? agent.activityState
    : agent.presenceStatus || agent.status;
  const profileStatusTone = profileStatus === 'online' || profileStatus === 'idle'
    ? 'online'
    : (!profileStatus || profileStatus === 'offline' || profileStatus === 'stopped' || profileStatus === 'disabled') ? 'offline' : 'active';
  const displayType = agent.agentType
    ? agent.agentType.charAt(0).toUpperCase() + agent.agentType.slice(1)
    : '未知';
  const modelLabel = getAgentModelLabel(agent);
  const installedSkillIds = getInstalledSkillIds(agent);

  const infoItems = [
    { icon: <Monitor className="size-3.5" />, label: '类型', value: displayType },
    { icon: <Cpu className="size-3.5" />, label: '模型', value: modelLabel || '—' },
    { icon: <Folder className="size-3.5" />, label: '目录', value: agent.workingDir || '—' },
    { icon: <UserRoundCog className="size-3.5" />, label: 'Agent 名称', value: agent.agentName, copyable: true },
  ];

  return (
    <>
      <div
        className="absolute inset-0 z-10 bg-black/10"
        onClick={() => setSelectedAgentName(null)}
      />

      <div
        ref={panelRef}
        style={isMobile ? undefined : { width: 'var(--agent-panel-width)' }}
        className={cn(
          'absolute bottom-0 right-0 top-0 z-20 flex flex-col border-l bg-background shadow-xl animate-in slide-in-from-right duration-200',
          isMobile ? 'left-0 w-full' : '',
        )}
      >
        {!isMobile && (
          <div
            role="separator"
            aria-label="调整右侧边栏宽度"
            aria-orientation="vertical"
            aria-valuenow={agentPanelWidth}
            tabIndex={0}
            onPointerDown={handleResizePointerDown}
            onKeyDown={handleResizeKeyDown}
            className="group absolute left-0 top-0 bottom-0 z-30 hidden w-2 -translate-x-1/2 cursor-col-resize items-stretch justify-center outline-none hover:bg-primary/10 focus-visible:bg-primary/10 lg:flex"
          >
            <span className="my-2 w-px rounded-full bg-border opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
          </div>
        )}
        <div className="flex items-center justify-end px-3 pt-3">
          <button
            onClick={() => setSelectedAgentName(null)}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-zinc-200/60 dark:hover:bg-zinc-800"
            title="关闭"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="px-5 pb-4">
          <div className="flex items-center gap-3">
            <AgentAvatar
              name={agent.agentName}
              avatar={agent.avatar}
              avatarUrl={agent.avatarUrl}
              size={40}
              status={profileStatus}
              showStatus
            />
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-[15px] font-semibold leading-tight">{agent.displayName || agent.agentName}</h3>
              {agent.displayName && agent.displayName !== agent.agentName && (
                <p className="truncate text-[11px] text-muted-foreground">@{agent.agentName}</p>
              )}
              <div className="mt-1 flex items-center gap-1.5">
                <span className={cn(
                  'inline-flex items-center gap-1 rounded px-1.5 py-px text-[11px] font-medium',
                  profileStatusTone === 'online' && 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400',
                  profileStatusTone === 'offline' && 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
                  profileStatusTone === 'active' && 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
                )}>
                  <span className={cn(
                    'size-1.5 rounded-full',
                    profileStatusTone === 'online' && 'bg-green-500',
                    profileStatusTone === 'offline' && 'bg-zinc-400',
                    profileStatusTone === 'active' && 'bg-amber-500',
                  )} />
                  {profileStatus}
                </span>
                {modelLabel && (
                  <span className="truncate font-mono text-[11px] text-muted-foreground">
                    {modelLabel}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-3.5">
          <div className="overflow-hidden rounded-lg border">
            <div className="border-b px-3.5 py-2.5">
              <span className="text-xs font-medium">说明</span>
            </div>
            <div className="p-3">
              <textarea
                className="min-h-[60px] w-full resize-none bg-transparent text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground/50"
                placeholder={`描述 ${agent.agentName} 擅长什么，方便分派工作...`}
                value={description}
                onChange={(event) => {
                  setDescription(event.target.value);
                  setDescDirty(true);
                }}
                onBlur={handleSaveDescription}
                rows={3}
              />
              {descDirty && (
                <div className="mt-1.5 flex justify-end">
                  <button
                    onClick={handleSaveDescription}
                    disabled={saving}
                    className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                  >
                    {saving ? '保存中...' : '保存'}
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="overflow-hidden rounded-lg border">
            <div className="border-b px-3.5 py-2.5">
              <span className="text-xs font-medium">本地详情</span>
            </div>
            <div className="divide-y">
              {infoItems.map((item) => (
                <div key={item.label} className="flex items-start gap-3 px-3.5 py-3">
                  <div className="flex w-[80px] shrink-0 items-center gap-1.5 pt-px">
                    <span className="text-muted-foreground">{item.icon}</span>
                    <span className="text-xs text-muted-foreground">{item.label}</span>
                  </div>
                  <div className="flex min-w-0 flex-1 items-start gap-1">
                    <span className="break-all font-mono text-[13px] leading-snug">{item.value}</span>
                    {item.copyable && (
                      <button
                        className="mt-px flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
                        title={`复制${item.label}`}
                        onClick={() => copyToClipboard(item.value)}
                      >
                        {isCopied ? <Check className="size-3" /> : <Copy className="size-3" />}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="overflow-hidden rounded-lg border">
            <div className="flex items-center justify-between border-b px-3.5 py-2.5">
              <span className="text-xs font-medium">Agent 配置</span>
              {!editingConfig && (
                <button onClick={() => setEditingConfig(true)} className="text-muted-foreground hover:text-foreground" title="编辑 Agent 配置">
                  <Pencil className="size-3.5" />
                </button>
              )}
            </div>
            <div className="space-y-2 p-3">
              {editingConfig ? (
                <>
                  <input className="h-8 w-full rounded border bg-transparent px-2 text-xs" value={displayNameDraft} onChange={(event) => setDisplayNameDraft(event.target.value)} placeholder="显示名称" />
                  <div className="space-y-2 rounded-md border p-2">
                    <div className="flex items-center gap-2">
                      <AgentAvatar
                        name={agent.agentName}
                        avatar={avatarDraft ? { type: 'upload', value: avatarDraft } : agent.avatar}
                        size={32}
                      />
                      <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded border px-2 text-xs hover:bg-muted">
                        <Upload className="size-3.5" />
                        选择头像
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={(event) => handleAvatarFile(event.target.files?.[0])}
                        />
                      </label>
                      {avatarDraft && (
                        <button type="button" className="h-8 rounded border px-2 text-xs hover:bg-muted" onClick={() => setAvatarDraft('')}>
                          清除
                        </button>
                      )}
                    </div>
                  </div>
                  <input className="h-8 w-full rounded border bg-transparent px-2 font-mono text-xs" value={workingDirDraft} onChange={(event) => setWorkingDirDraft(event.target.value)} placeholder="工作目录" />
                  <input className="h-8 w-full rounded border bg-transparent px-2 font-mono text-xs" value={modelDraft} onChange={(event) => setModelDraft(event.target.value)} placeholder="模型" />
                  {agent.agentType === 'codex' && (
                    <button
                      type="button"
                      onClick={() => setCodexFastDraft((value) => !value)}
                      className={cn(
                        'flex w-full items-center justify-between rounded border px-2 py-2 text-left',
                        codexFastDraft ? 'border-primary/40 bg-primary/5' : 'hover:bg-muted',
                      )}
                    >
                      <span className="flex items-center gap-1.5 text-xs font-medium">
                        <Zap className="size-3.5 text-amber-500" />
                        Codex Fast mode
                      </span>
                      <span className={cn('h-5 w-9 rounded-full border transition-colors', codexFastDraft ? 'border-primary bg-primary' : 'bg-muted')} />
                    </button>
                  )}
                  <select className="h-8 w-full rounded border bg-background px-2 text-xs" value={qualityDraft} onChange={(event) => setQualityDraft(event.target.value)}>
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                    <option value="xhigh">xhigh</option>
                    <option value="max">max</option>
                  </select>
                  <div className="flex justify-end gap-1.5">
                    <button onClick={() => setEditingConfig(false)} className="rounded border px-2 py-1 text-[10px]">取消</button>
                    <button onClick={handleSaveConfig} disabled={savingConfig} className="rounded bg-primary px-2 py-1 text-[10px] text-primary-foreground disabled:opacity-50">
                      {savingConfig ? '保存中...' : '保存'}
                    </button>
                  </div>
                </>
              ) : (
                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                  <span className="text-muted-foreground">推理强度</span><span>{agent.quality || '—'}</span>
                  {agent.agentType === 'codex' && (
                    <>
                      <span className="text-muted-foreground">Codex Fast</span><span>{agent.managedMetadata?.codex_service_tier === 'fast' ? '开启' : '关闭'}</span>
                    </>
                  )}
                  <span className="text-muted-foreground">模型</span><span className="truncate">{modelLabel || '—'}</span>
                  <span className="text-muted-foreground">工作目录</span><span className="truncate">{agent.workingDir || '—'}</span>
                </div>
              )}
            </div>
          </div>

          <div className="overflow-hidden rounded-lg border">
            <div className="flex items-center justify-between border-b px-3.5 py-2.5">
              <span className="text-xs font-medium">已装载 Skills</span>
              <span className="text-[11px] text-muted-foreground">{installedSkillIds.length}</span>
            </div>
            <div className="p-3">
              {installedSkillIds.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {installedSkillIds.map((skillId) => (
                    <span
                      key={skillId}
                      className="max-w-full truncate rounded-md border bg-muted/50 px-2 py-1 font-mono text-[11px] text-foreground"
                      title={skillId}
                    >
                      {skillId}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">暂无已装载 skill</p>
              )}
            </div>
          </div>
        </div>

        <div className="border-t px-3.5 py-3">
          <div className="flex gap-2">
            {!isDisabled && (
              <button
                onClick={() => handleLocalAgentControl(localPrimaryAction)}
                disabled={currentControlBusy !== null}
                className="flex items-center justify-center gap-1.5 rounded-lg border border-emerald-200 px-3 py-2 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-900/50 dark:text-emerald-300 dark:hover:bg-emerald-900/20"
                title={localPrimaryAction === 'restart' ? '重启本机 Agent' : '启动本机 Agent'}
              >
                {currentControlBusy === localPrimaryAction ? <RefreshCw className="size-3 animate-spin" /> : <Power className="size-3" />}
                {localPrimaryAction === 'restart' ? '重启' : '启动'}
              </button>
            )}
            <button
              onClick={handleRemoveAgent}
              className="flex items-center justify-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 dark:border-red-900/50 dark:text-red-400 dark:hover:bg-red-900/20"
              title="移除 Agent"
            >
              <Trash2 className="size-3" />
              移除
            </button>
            <button
              onClick={handleToggleDisabled}
              className="flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800"
              title={isDisabled ? '启用 Agent' : '停用 Agent'}
            >
              <Power className="size-3" />
              {isDisabled ? '启用' : '停用'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
