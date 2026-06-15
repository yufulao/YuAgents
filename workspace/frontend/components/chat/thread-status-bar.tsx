'use client';

import { useEffect, useMemo, useState, useCallback, type ReactNode } from 'react';
import { Circle, Loader2, Timer, MessageSquareMore, X } from 'lucide-react';
import { useWorkspace } from '@/lib/workspace-context';
import { workspaceApi } from '@/lib/api';
import type { TimerItem, TodoItem, WorkspaceMessage } from '@/lib/types';
import { cn } from '@/lib/utils';

function timeUntil(dateStr: string): string {
  const diff = new Date(dateStr).getTime() - Date.now();
  if (diff <= 0) return 'now';
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h`;
}

interface QueuedMessage {
  queueId: string;
  content: string;
}

function normalizeQueuedContent(content: string): string {
  return String(content || '').replace(/@openagents:/g, '@').trim();
}

function todoOwnerLabel(todo: TodoItem): string {
  const source = todo.assignee || todo.createdBy || '';
  return source.replace(/^(openagents:|human:)/, '') || 'unknown';
}

function truncateTodo(content: string, max = 72): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

export function ThreadStatusBar({
  channelName,
  messages = [],
  variant = 'inline',
  emptyLabel,
  className,
}: {
  channelName: string;
  messages?: WorkspaceMessage[];
  variant?: 'inline' | 'sidebar';
  emptyLabel?: string;
  className?: string;
}) {
  const { todos, refreshTodos } = useWorkspace();
  const [timers, setTimers] = useState<TimerItem[]>([]);
  const [cancelledQueueIds, setCancelledQueueIds] = useState<Set<string>>(new Set());

  const todoRefreshSignal = useMemo(() => {
    const relevant = messages.filter((m) =>
      m.messageType === 'todos' ||
      (m.messageType === 'status' && (m.metadata as Record<string, unknown> | undefined)?.queue_id)
    );
    return relevant[relevant.length - 1]?.messageId || '';
  }, [messages]);

  const pollTimers = useCallback(async () => {
    try {
      const result = await workspaceApi.listTimers(channelName);
      setTimers(result.timers);
    } catch {}
  }, [channelName]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const result = await workspaceApi.listTimers(channelName).catch(() => null);
      if (!cancelled && result) setTimers(result.timers);
    };
    poll();
    const interval = setInterval(poll, 15000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [channelName]);

  useEffect(() => {
    if (!todoRefreshSignal) return;
    const quickRefresh = setTimeout(() => {
      refreshTodos();
    }, 300);
    const committedRefresh = setTimeout(() => {
      refreshTodos();
    }, 1500);
    return () => {
      clearTimeout(quickRefresh);
      clearTimeout(committedRefresh);
    };
  }, [todoRefreshSignal, refreshTodos]);

  const [, setTick] = useState(0);
  useEffect(() => {
    if (!timers.length) return;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [timers.length]);

  const channelTodos = useMemo(() =>
    todos.filter((t) => t.channelName === channelName && (t.status === 'pending' || t.status === 'in_progress')),
    [todos, channelName]
  );

  // Extract queued messages from status messages with queue metadata
  const queuedMessages = useMemo(() => {
    // First pass: collect queue IDs that have been processed
    const processedIds = new Set<string>();
    for (const msg of messages) {
      if (msg.messageType !== 'status') continue;
      const meta = msg.metadata as Record<string, unknown> | undefined;
      if (meta?.queue_id && meta?.queue_status === 'processed') {
        processedIds.add(meta.queue_id as string);
      }
    }

    const queued: QueuedMessage[] = [];
    const seen = new Set<string>();
    const seenContent = new Set<string>();
    // Walk messages in reverse to get latest state per queue_id
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.messageType !== 'status') continue;
      const meta = msg.metadata as Record<string, unknown> | undefined;
      if (!meta?.queue_id || !meta?.queued_message) continue;
      const qid = meta.queue_id as string;
      if (seen.has(qid) || cancelledQueueIds.has(qid) || processedIds.has(qid)) continue;
      const content = normalizeQueuedContent(meta.queued_message as string);
      const contentKey = content.replace(/\s+/g, ' ');
      if (seenContent.has(contentKey)) continue;
      seen.add(qid);
      seenContent.add(contentKey);
      queued.push({ queueId: qid, content });
    }
    return queued.reverse();
  }, [messages, cancelledQueueIds]);

  const pendingCount = channelTodos.filter((t) => t.status === 'pending').length;
  const inProgressCount = channelTodos.filter((t) => t.status === 'in_progress').length;
  const inProgressTodos = channelTodos.filter((t) => t.status === 'in_progress');
  const pendingTodos = channelTodos.filter((t) => t.status === 'pending');
  const activeTimers = timers.filter((t) => t.status === 'active');

  const handleCancelTimer = useCallback(async (timerId: string) => {
    setTimers((prev) => prev.filter((t) => t.id !== timerId));
    try {
      await workspaceApi.cancelTimer(timerId);
    } catch {}
    pollTimers();
  }, [pollTimers]);

  const handleCancelTodos = useCallback(async () => {
    const agents = Array.from(new Set(channelTodos.map((t) => t.createdBy)));
    for (const source of agents) {
      try {
        await workspaceApi.cancelChannelTodos(channelName, source);
      } catch {}
    }
    refreshTodos();
  }, [channelTodos, channelName, refreshTodos]);

  const handleCancelQueued = useCallback(async (queueId: string) => {
    setCancelledQueueIds((prev) => new Set(prev).add(queueId));
    try {
      await workspaceApi.cancelQueuedMessage(channelName, queueId);
    } catch {}
    refreshTodos();
  }, [channelName, refreshTodos]);

  const hasContent = pendingCount > 0 || inProgressCount > 0 || activeTimers.length > 0 || queuedMessages.length > 0;
  if (!hasContent) {
    if (!emptyLabel) return null;
    return (
      <div className={cn('px-2 py-1.5 text-[11px] text-muted-foreground', className)}>
        {emptyLabel}
      </div>
    );
  }

  const isSidebar = variant === 'sidebar';

  const renderTodoSection = (
    label: string,
    items: TodoItem[],
    icon: ReactNode,
    tone: string,
  ) => {
    if (items.length === 0) return null;
    return (
      <div className="space-y-1">
        <div className={cn('flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide', tone)}>
          {icon}
          <span>{label}</span>
          <span className="text-muted-foreground">({items.length})</span>
        </div>
        <div className="space-y-0.5">
          {items.map((todo) => (
            <div
              key={todo.id}
              className="rounded-md px-1.5 py-1 text-[11px] leading-snug text-foreground/90 transition-colors hover:bg-muted/60"
              title={todo.content}
            >
              <div className="line-clamp-2 break-words">{truncateTodo(todo.content)}</div>
              <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{todoOwnerLabel(todo)}</div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div
      className={cn(
        'flex flex-col gap-0.5 text-[11px] text-muted-foreground',
        isSidebar ? 'max-h-64 overflow-y-auto px-2 pb-2' : 'px-1 py-1',
        className,
      )}
    >
      {/* Todos and timers row */}
      {(inProgressCount > 0 || pendingCount > 0 || activeTimers.length > 0) && (
        <div className={cn('flex gap-2.5', isSidebar ? 'flex-col items-stretch' : 'items-center')}>
          {(inProgressCount > 0 || pendingCount > 0) && (
            isSidebar ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Agent todos</span>
                  <button
                    onClick={handleCancelTodos}
                    className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-zinc-200 hover:text-foreground dark:hover:bg-zinc-700"
                    title="Cancel all tasks"
                  >
                    <X className="size-3" />
                  </button>
                </div>
                {renderTodoSection(
                  'In progress',
                  inProgressTodos,
                  <Loader2 className="size-3 animate-spin" />,
                  'text-blue-500',
                )}
                {renderTodoSection(
                  'Pending',
                  pendingTodos,
                  <Circle className="size-3" />,
                  'text-muted-foreground',
                )}
              </div>
            ) : (
              <span className="flex min-w-0 items-center gap-1">
                {inProgressCount > 0 && (
                  <>
                    <Loader2 className="size-3 text-blue-500 animate-spin" />
                    <span>{inProgressCount} in progress</span>
                  </>
                )}
                {inProgressCount > 0 && pendingCount > 0 && <span className="text-muted-foreground/30">·</span>}
                {pendingCount > 0 && (
                  <>
                    <Circle className="size-3" />
                    <span>{pendingCount} pending</span>
                  </>
                )}
                <button
                  onClick={handleCancelTodos}
                  className="ml-0.5 p-0.5 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
                  title="Cancel all tasks"
                >
                  <X className="size-3" />
                </button>
              </span>
            )
          )}
          {activeTimers.map((t) => (
            <span key={t.id} className="flex min-w-0 items-center gap-1">
              <Timer className="size-3 text-amber-500" />
              <span className="min-w-0 truncate">{t.message.length > 30 ? t.message.slice(0, 30) + '…' : t.message}</span>
              <span className="text-amber-500 font-mono">{timeUntil(t.firesAt)}</span>
              <button
                onClick={() => handleCancelTimer(t.id)}
                className="p-0.5 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
                title="Cancel timer"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Queued messages */}
      {queuedMessages.map((q) => (
        <div
          key={q.queueId}
          className={cn(
            'flex min-w-0 items-start gap-1.5 text-blue-500 dark:text-blue-400',
            isSidebar && 'rounded-md px-1 py-1 transition-colors hover:bg-muted/60',
          )}
        >
          <MessageSquareMore className="size-3 shrink-0" />
          <span className={cn('min-w-0 flex-1', isSidebar ? 'line-clamp-2 break-words leading-snug' : 'truncate')}>
            Queued: {q.content.length > 60 ? q.content.slice(0, 60) + '…' : q.content}
          </span>
          <button
            onClick={() => handleCancelQueued(q.queueId)}
            className="shrink-0 p-0.5 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
            title="Cancel queued message"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
