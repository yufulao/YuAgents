'use client';

import { PlusSquare, Rocket } from 'lucide-react';
import { useWorkspace } from '@/lib/workspace-context';
import { useLayout } from '@/components/layout/layout-context';

export function EmptyState() {
  const { agents } = useWorkspace();
  const { setViewMode } = useLayout();
  const hasOnlineAgent = agents.some((agent) => agent.status === 'online');

  if (hasOnlineAgent) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <div className="flex rounded-full bg-emerald-500/10 p-4">
          <Rocket className="size-8 text-emerald-500" />
        </div>
        <div className="space-y-2">
          <h3 className="text-lg font-semibold">Agent 已就绪</h3>
          <p className="max-w-sm text-sm text-muted-foreground">
            在线 Agent 会显示在侧栏。直接输入消息，或使用 @名称 指派任务。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="flex rounded-full bg-primary/10 p-4">
        <PlusSquare className="size-8 text-primary" />
      </div>
      <div className="space-y-2">
        <h3 className="text-lg font-semibold">还没有 Agent</h3>
        <p className="max-w-sm text-sm text-muted-foreground">
          创建一个本地 Agent 后，它会出现在侧栏；启动后即可参与会话。
        </p>
      </div>
      <button
        type="button"
        onClick={() => setViewMode('connect')}
        className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        创建 Agent
      </button>
    </div>
  );
}
