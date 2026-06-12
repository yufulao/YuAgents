'use client';

import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Loader2, Terminal, X, Zap } from 'lucide-react';
import { useLayout } from '@/components/layout/layout-context';
import { useWorkspace } from '@/lib/workspace-context';
import { workspaceApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import type { AgentCatalogEntry, CodexLocalCatalog } from '@/lib/types';
import { AgentIcon } from '@/components/icons/agent-icons';
import { DEFAULT_AGENT_CATALOG, withDefaultAgentCatalog } from '@/lib/agent-catalog';

const AGENT_HANDLE_RE = /^[^\s@:/\\]{1,64}$/;
const AGENT_HANDLE_HINT = '名称用于 @mention，支持中文；不要包含空格、@、冒号或斜杠。';
const LOCAL_RUNTIME_ORDER = ['codex', 'claude'];

export function ConnectAgentView() {
  const { setViewMode } = useLayout();
  const [loading, setLoading] = useState(true);
  const [catalog, setCatalog] = useState<AgentCatalogEntry[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    workspaceApi
      .getAgentCatalog()
      .then((entries) => {
        if (cancelled) return;
        setCatalog(withDefaultAgentCatalog(entries));
      })
      .catch(() => {
        if (cancelled) return;
        setCatalog(DEFAULT_AGENT_CATALOG);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const localCatalog = useMemo(() => {
    return LOCAL_RUNTIME_ORDER
      .map((name) => catalog.find((entry) => entry.name === name) || DEFAULT_AGENT_CATALOG.find((entry) => entry.name === name))
      .filter((entry): entry is AgentCatalogEntry => Boolean(entry));
  }, [catalog]);

  const selectedEntry = useMemo(
    () => localCatalog.find((entry) => entry.name === selectedAgent),
    [localCatalog, selectedAgent],
  );

  useEffect(() => {
    if (!selectedAgent && localCatalog.length > 0) {
      setSelectedAgent(localCatalog[0].name);
    }
  }, [localCatalog, selectedAgent]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold">创建 Agent</h2>
        <button
          onClick={() => setViewMode('threads')}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
          title="关闭"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            <span className="text-xs">加载中...</span>
          </div>
        ) : (
          <LocalAgentForm
            catalog={localCatalog}
            selectedAgent={selectedAgent}
            selectedEntry={selectedEntry}
            onSelectAgent={setSelectedAgent}
          />
        )}
      </div>
    </div>
  );
}

function LocalAgentForm({
  catalog,
  selectedAgent,
  selectedEntry,
  onSelectAgent,
}: {
  catalog: AgentCatalogEntry[];
  selectedAgent: string | null;
  selectedEntry: AgentCatalogEntry | undefined;
  onSelectAgent: (name: string | null) => void;
}) {
  const { agents, refreshWorkspace } = useWorkspace();
  const [agentName, setAgentName] = useState('');
  const [workingDir, setWorkingDir] = useState('');
  const [modelName, setModelName] = useState('');
  const [quality, setQuality] = useState('medium');
  const [codexFastMode, setCodexFastMode] = useState(false);
  const [codexCatalog, setCodexCatalog] = useState<CodexLocalCatalog | null>(null);
  const [loadingCodexCatalog, setLoadingCodexCatalog] = useState(false);
  const [codexCatalogError, setCodexCatalogError] = useState('');
  const [createError, setCreateError] = useState('');
  const [createSuccess, setCreateSuccess] = useState('');
  const [creating, setCreating] = useState(false);

  const trimmedName = agentName.trim();
  const existingNames = useMemo(() => new Set(agents.map((agent) => agent.agentName)), [agents]);
  const nameInvalid = Boolean(trimmedName && !AGENT_HANDLE_RE.test(trimmedName));
  const nameExists = Boolean(trimmedName && existingNames.has(trimmedName));

  const codexModelOptions = useMemo(() => {
    const bySlug = new Map<string, string>();
    for (const model of codexCatalog?.models || []) {
      bySlug.set(model.slug, model.display_name || model.slug);
    }
    if (codexCatalog?.config.model) {
      bySlug.set(codexCatalog.config.model, bySlug.get(codexCatalog.config.model) || codexCatalog.config.model);
    }
    if (modelName) {
      bySlug.set(modelName, bySlug.get(modelName) || modelName);
    }
    return Array.from(bySlug, ([slug, label]) => ({ slug, label }));
  }, [codexCatalog, modelName]);

  const selectedCodexModel = useMemo(
    () => codexCatalog?.models.find((model) => model.slug === modelName),
    [codexCatalog, modelName],
  );

  const codexFastAvailable = Boolean(
    selectedEntry?.name === 'codex'
    && (
      selectedCodexModel?.additional_speed_tiers?.includes('fast')
      || selectedCodexModel?.service_tiers?.some((tier) => tier.id === 'fast')
    ),
  );

  useEffect(() => {
    if (!selectedEntry) return;
    setCreateError('');
    setCreateSuccess('');
    setCodexFastMode(false);
    if (selectedEntry.name !== 'codex') {
      setModelName('');
      setQuality('medium');
    }
  }, [selectedEntry]);

  useEffect(() => {
    if (selectedEntry?.name !== 'codex') {
      setCodexCatalogError('');
      setCodexCatalog(null);
      return;
    }
    let cancelled = false;
    setLoadingCodexCatalog(true);
    setCodexCatalogError('');
    workspaceApi.getLocalCodexCatalog()
      .then((data) => {
        if (cancelled) return;
        setCodexCatalog(data);
        setModelName((current) => current || data.config.model || data.models[0]?.slug || '');
        setQuality((current) => current || data.config.model_reasoning_effort || 'medium');
      })
      .catch((err) => {
        if (cancelled) return;
        setCodexCatalog(null);
        setCodexCatalogError(err instanceof Error ? err.message : '读取本机 Codex 模型失败');
      })
      .finally(() => {
        if (!cancelled) setLoadingCodexCatalog(false);
      });
    return () => { cancelled = true; };
  }, [selectedEntry?.name]);

  useEffect(() => {
    if (!codexFastAvailable) {
      setCodexFastMode(false);
    }
  }, [codexFastAvailable]);

  const handleCreateLocalConfig = async () => {
    if (!selectedEntry || !trimmedName) return;
    if (!AGENT_HANDLE_RE.test(trimmedName)) {
      setCreateError(AGENT_HANDLE_HINT);
      toast.error(AGENT_HANDLE_HINT);
      return;
    }
    if (existingNames.has(trimmedName)) {
      const message = `Agent "${trimmedName}" 已存在，请换一个名称。`;
      setCreateError(message);
      toast.error(message);
      return;
    }
    setCreating(true);
    setCreateError('');
    setCreateSuccess('');
    try {
      await workspaceApi.addManagedAgent({
        agentName: trimmedName,
        agentType: selectedEntry.name,
        displayName: trimmedName,
        workingDir: workingDir.trim() || undefined,
        modelProvider: selectedEntry.name === 'codex' ? 'openai' : 'anthropic',
        modelName: modelName.trim() || undefined,
        mode: 'execute',
        quality,
        managedMetadata: {
          local_runtime: selectedEntry.name === 'codex' ? 'codex-cli' : 'claude-code',
          local_config_source: selectedEntry.name === 'codex' ? '~/.codex' : '~/.claude',
          model_source: selectedEntry.name === 'codex' ? 'local-codex-config' : 'local-cli-config',
          codex_service_tier: selectedEntry.name === 'codex' && codexFastMode ? 'fast' : 'default',
        },
        lifecycleStatus: 'active',
      });
      await refreshWorkspace();
      const message = `已创建 Agent "@${trimmedName}" 配置；启动本机 ${selectedEntry.label} 后会变为在线。`;
      setCreateSuccess(message);
      setAgentName('');
      toast.success(message);
    } catch (err) {
      const message = err instanceof Error ? err.message : '创建 Agent 失败';
      setCreateError(message);
      toast.error(message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-4 p-4">
      <div className="space-y-4 rounded-lg border bg-background p-3">
        <div>
          <h4 className="text-xs font-semibold">创建本地 Agent</h4>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            只创建本机 Agent 配置；启动时使用本机 CLI 和工作目录。
          </p>
        </div>

        <div className="space-y-1">
          <Label className="text-[11px]">本地外壳</Label>
          <select
            value={selectedEntry?.name || selectedAgent || ''}
            onChange={(event) => onSelectAgent(event.target.value || null)}
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
          >
            {catalog.map((entry) => (
              <option key={entry.name} value={entry.name}>{entry.label}</option>
            ))}
          </select>
        </div>

        {selectedEntry && (
          <div className="rounded-md bg-muted/50 px-3 py-2 text-[11px] text-muted-foreground">
            <div className="flex items-center gap-2 font-medium text-foreground">
              <AgentIcon name={selectedEntry.name} size={18} />
              <span>{selectedEntry.label}</span>
              {selectedEntry.homepage && (
                <a
                  href={selectedEntry.homepage}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground/60 transition-colors hover:text-foreground"
                  aria-label="打开官网"
                >
                  <ExternalLink className="size-3" />
                </a>
              )}
            </div>
            <p className="mt-1">
              {selectedEntry.name === 'codex'
                ? '启动时走本机 Codex CLI，读取本机 ~/.codex/config.toml 和 CLI 会话配置。'
                : '启动时走本机 Claude Code，读取本机 Claude 配置和 CLI 会话配置。'}
            </p>
          </div>
        )}

        <div className="space-y-1">
          <Label className="text-[11px]">Agent 名称</Label>
          <Input
            value={agentName}
            onChange={(event) => {
              setAgentName(event.target.value);
              setCreateError('');
              setCreateSuccess('');
            }}
            className={cn((nameInvalid || nameExists) && 'border-destructive focus-visible:ring-destructive/30')}
            placeholder="例如 紫、蓝、魔理沙"
          />
          <p className={cn('text-[10px]', nameInvalid || nameExists ? 'text-destructive' : 'text-muted-foreground')}>
            {nameExists
              ? '这个名称已经存在，请换一个。'
              : '名称就是 @ 提及时使用的名字，支持中文；不要包含空格、斜杠、@ 或冒号。'}
          </p>
        </div>

        <div className="space-y-1">
          <Label className="text-[11px]">模型</Label>
          {selectedEntry?.name === 'codex' ? (
            <select
              value={modelName}
              onChange={(event) => setModelName(event.target.value)}
              className="h-9 w-full rounded-md border bg-background px-2 font-mono text-sm"
              disabled={loadingCodexCatalog || codexModelOptions.length === 0}
            >
              {codexModelOptions.length === 0 ? (
                <option value="">未读取到模型缓存</option>
              ) : codexModelOptions.map((model) => (
                <option key={model.slug} value={model.slug}>
                  {model.label}
                </option>
              ))}
            </select>
          ) : (
            <Input
              value={modelName}
              onChange={(event) => setModelName(event.target.value)}
              placeholder="例如 claude-sonnet-4-5"
              className="h-9 font-mono text-xs"
            />
          )}
          <p className="text-[10px] text-muted-foreground">
            {selectedEntry?.name === 'codex'
              ? loadingCodexCatalog
                ? '正在读取本机 Codex 模型列表...'
                : codexCatalogError || '默认读取本机 Codex 配置，也可以手动覆盖。'
              : 'Claude 默认跟随本机 Claude Code 配置，也可以在这里记录模型名。'}
          </p>
        </div>

        {selectedEntry?.name === 'codex' && (
          <div className={cn(
            'flex items-center justify-between gap-4 rounded-lg border px-3 py-2.5',
            codexFastMode ? 'border-primary/40 bg-primary/5' : 'border-input',
            !codexFastAvailable && 'opacity-60',
          )}>
            <div className="space-y-0.5">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <Zap className="size-3.5 text-amber-500" />
                Codex Fast mode
              </div>
              <p className="text-[10px] text-muted-foreground">
                {codexFastAvailable ? '使用当前 Codex 模型的 fast speed tier。' : '当前模型没有本机可用的 fast tier。'}
              </p>
            </div>
            <button
              type="button"
              disabled={!codexFastAvailable}
              onClick={() => setCodexFastMode((value) => !value)}
              className={cn(
                'relative h-6 w-10 rounded-full border transition-colors',
                codexFastMode ? 'border-primary bg-primary' : 'border-input bg-muted',
              )}
              aria-pressed={codexFastMode}
            >
              <span
                className={cn(
                  'absolute top-0.5 size-5 rounded-full bg-background shadow transition-transform',
                  codexFastMode ? 'translate-x-4' : 'translate-x-0.5',
                )}
              />
            </button>
          </div>
        )}

        <div className="space-y-1">
          <Label className="text-[11px]">推理强度</Label>
          <select
            value={quality}
            onChange={(event) => setQuality(event.target.value)}
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
          >
            {['low', 'medium', 'high', 'xhigh', 'max'].map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <Label className="text-[11px]">工作目录</Label>
          <Input value={workingDir} onChange={(event) => setWorkingDir(event.target.value)} placeholder="C:\\path\\to\\project" className="h-9 font-mono text-xs" />
        </div>

        {createError && (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {createError}
          </div>
        )}
        {createSuccess && (
          <div className="rounded-md bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
            {createSuccess}
          </div>
        )}

        <Button size="sm" onClick={handleCreateLocalConfig} disabled={creating || !selectedEntry || !trimmedName || nameInvalid || nameExists} className="w-full">
          {creating && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
          {creating ? '创建中...' : '创建 Agent'}
        </Button>
      </div>
    </div>
  );
}
