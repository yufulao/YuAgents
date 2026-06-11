'use client';

import { useState, useEffect, useMemo } from 'react';
import { Rocket, Cloud, ExternalLink, Loader2, ChevronRight } from 'lucide-react';
import { useWorkspace } from '@/lib/workspace-context';
import { useLayout } from '@/components/layout/layout-context';
import { workspaceApi } from '@/lib/api';
import { AgentIcon } from '@/components/icons/agent-icons';
import { cn } from '@/lib/utils';
import type { AgentCatalogEntry } from '@/lib/types';
import { DEFAULT_AGENT_CATALOG, withDefaultAgentCatalog } from '@/lib/agent-catalog';

export function EmptyState() {
  const { agents } = useWorkspace();
  const { setViewMode } = useLayout();
  const hasOnlineAgent = agents.some((a) => a.status === 'online');

  const [catalog, setCatalog] = useState<AgentCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    workspaceApi
      .getAgentCatalog()
      .then((entries) => { if (!cancelled) setCatalog(withDefaultAgentCatalog(entries)); })
      .catch(() => { if (!cancelled) setCatalog(DEFAULT_AGENT_CATALOG); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const selectedEntry = useMemo(
    () => catalog.find((e) => e.name === selectedAgent),
    [catalog, selectedAgent],
  );

  if (hasOnlineAgent) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-center p-8">
        <div className="flex items-center p-4 rounded-full bg-emerald-500/10">
          <Rocket className="size-8 text-emerald-500" />
        </div>
        <div className="space-y-2">
          <h3 className="text-lg font-semibold">Agent 已就绪</h3>
          <p className="text-sm text-muted-foreground max-w-sm">
            在线 Agent 会显示在侧栏。直接输入消息，或使用 <span className="font-medium text-foreground">@紫</span> 这样的名称指派任务。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center h-full overflow-y-auto p-6 sm:p-8">
      <div className="w-full max-w-2xl space-y-6 py-8">
        {/* Header */}
        <div className="text-center space-y-2">
          <h2 className="text-2xl font-bold tracking-tight">连接第一个 Agent</h2>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            从本机 Codex 或 Claude 创建一个本地 Agent。
          </p>
        </div>

        {/* Agent catalog grid */}
        {loading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="size-4 animate-spin mr-2" />
            <span className="text-sm">正在加载 Agent...</span>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2.5">
            {catalog.map((entry) => {
              const isSelected = selectedAgent === entry.name;
              return (
                <button
                  key={entry.name}
                  onClick={() => setSelectedAgent(isSelected ? null : entry.name)}
                  className={cn(
                    'flex flex-col items-center gap-2 px-3 py-4 rounded-xl border text-center transition-all',
                    isSelected
                      ? 'border-primary/30 bg-primary/[0.04] ring-1 ring-primary/10 shadow-sm'
                      : 'border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700 hover:bg-zinc-50/50 dark:hover:bg-zinc-800/30',
                  )}
                >
                  <div className="size-10 flex items-center justify-center">
                    <AgentIcon name={entry.name} size={40} />
                  </div>
                  <div className="min-w-0 w-full">
                    <div className="text-sm font-medium leading-tight truncate">{entry.label}</div>
                    <div className="text-[10px] text-muted-foreground mt-0.5 truncate">
                      {entry.tags?.[0] || 'Agent'}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {/* Selected agent — short connection entry */}
        {selectedEntry && (
          <div className="rounded-xl border bg-card overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
            {/* Agent header */}
            <div className="px-5 py-4 border-b bg-muted/30">
              <div className="flex items-center gap-3">
                <div className="size-10 flex items-center justify-center shrink-0">
                  <AgentIcon name={selectedEntry.name} size={40} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-semibold">{selectedEntry.label}</h3>
                    {selectedEntry.homepage && (
                      <a
                        href={selectedEntry.homepage}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                      >
                        <ExternalLink className="size-3.5" />
                      </a>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">{selectedEntry.description}</p>
                </div>
              </div>
            </div>

            <div className="p-5 space-y-3">
              <button
                onClick={() => setViewMode('connect')}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
              >
                去连接 Agent
              </button>
              <p className="text-xs text-muted-foreground text-center">
                在连接页只需要选择本地外壳、填写 Agent 名称和工作目录；模型读取本机 CLI 配置。
              </p>
            </div>
          </div>
        )}

        {/* Cloud agents fallback */}
        <div className="text-center space-y-2 pt-2">
          <div className="flex items-center gap-3 justify-center">
            <div className="w-16 border-t" />
            <span className="text-[11px] text-muted-foreground">或</span>
            <div className="w-16 border-t" />
          </div>
          <button
            onClick={() => setViewMode('connect')}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg border hover:bg-accent transition-colors text-sm group"
          >
            <Cloud className="size-4 text-muted-foreground" />
          <span className="font-medium">进入连接页</span>
          <span className="text-xs text-muted-foreground">— 本地 Agent 只保留 Codex/Claude</span>
            <ChevronRight className="size-3.5 text-muted-foreground group-hover:translate-x-0.5 transition-transform" />
          </button>
        </div>
      </div>
    </div>
  );
}
