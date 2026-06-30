'use client';

import { useEffect, useMemo, useState, useCallback, type ReactNode } from 'react';
import { Circle, Loader2, Timer, MessageSquareMore, X } from 'lucide-react';
import { useLayout } from '@/components/layout/layout-context';
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

function intervalLabel(seconds?: number | null): string {
  if (!seconds) return '';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
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

const cancelButtonClass =
  'inline-flex size-5 shrink-0 items-center justify-center rounded border border-zinc-300 bg-background text-muted-foreground shadow-sm transition-colors hover:border-destructive/50 hover:bg-destructive/10 hover:text-destructive dark:border-zinc-700';

export function ThreadStatusBar({
  channelName,
  messages = [],
  variant = 'inline',
  emptyLabel,
  className,
  refreshKey,
}: {
  channelName: string;
  messages?: WorkspaceMessage[];
  variant?: 'inline' | 'sidebar';
  emptyLabel?: string;
  className?: string;
  refreshKey?: number;
}) {
  const { todos, refreshTodos } = useWorkspace();
  const { selectedQueueItem, setSelectedQueueItem, selectedStatusItem, setSelectedStatusItem } = useLayout();
  const [timers, setTimers] = useState<TimerItem[]>([]);
  const [cancelledTodoIds, setCancelledTodoIds] = useState<Set<string>>(new Set());
  const [cancelledQueueIds, setCancelledQueueIds] = useState<Set<string>>(new Set());
  const [editedQueueContent, setEditedQueueContent] = useState<Record<string, string>>({});

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
  }, [channelName, refreshKey]);

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

  useEffect(() => {
    const handleCancelled = (event: Event) => {
      const detail = (event as CustomEvent<{ channelName?: string; queueId?: string }>).detail;
      if (detail?.channelName !== channelName || !detail.queueId) return;
      setCancelledQueueIds((prev) => new Set(prev).add(detail.queueId as string));
    };
    const handleUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ channelName?: string; queueId?: string; content?: string }>).detail;
      if (detail?.channelName !== channelName || !detail.queueId || typeof detail.content !== 'string') return;
      setEditedQueueContent((prev) => ({ ...prev, [detail.queueId as string]: detail.content as string }));
    };
    document.addEventListener('queue-item-cancelled', handleCancelled);
    document.addEventListener('queue-item-updated', handleUpdated);
    return () => {
      document.removeEventListener('queue-item-cancelled', handleCancelled);
      document.removeEventListener('queue-item-updated', handleUpdated);
    };
  }, [channelName]);

  useEffect(() => {
    const handleTimerCancelled = (event: Event) => {
      const detail = (event as CustomEvent<{ channelName?: string; timerId?: string }>).detail;
      if (detail?.channelName !== channelName || !detail.timerId) return;
      setTimers((prev) => prev.filter((timer) => timer.id !== detail.timerId));
    };
    const handleTimerUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ channelName?: string; timer?: TimerItem }>).detail;
      if (detail?.channelName !== channelName || !detail.timer) return;
      setTimers((prev) => prev.map((timer) => (
        timer.id === detail.timer?.id ? detail.timer : timer
      )));
    };
    const handleTodoCancelled = (event: Event) => {
      const detail = (event as CustomEvent<{ channelName?: string; todoId?: string }>).detail;
      if (detail?.channelName !== channelName || !detail.todoId) return;
      setCancelledTodoIds((prev) => new Set(prev).add(detail.todoId as string));
    };
    document.addEventListener('timer-item-cancelled', handleTimerCancelled);
    document.addEventListener('timer-item-updated', handleTimerUpdated);
    document.addEventListener('todo-item-cancelled', handleTodoCancelled);
    return () => {
      document.removeEventListener('timer-item-cancelled', handleTimerCancelled);
      document.removeEventListener('timer-item-updated', handleTimerUpdated);
      document.removeEventListener('todo-item-cancelled', handleTodoCancelled);
    };
  }, [channelName]);

  const [, setTick] = useState(0);
  useEffect(() => {
    if (!timers.length) return;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [timers.length]);

  const channelTodos = useMemo(() =>
    todos.filter((t) =>
      t.channelName === channelName &&
      (t.status === 'pending' || t.status === 'in_progress') &&
      !cancelledTodoIds.has(t.id)
    ),
    [todos, channelName, cancelledTodoIds]
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
      queued.push({
        queueId: qid,
        content: editedQueueContent[qid] ??
          (selectedQueueItem?.channelName === channelName && selectedQueueItem.queueId === qid
          ? selectedQueueItem.content
          : content),
      });
    }
    return queued.reverse();
  }, [messages, cancelledQueueIds, channelName, selectedQueueItem, editedQueueContent]);

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

  const handleCancelTodo = useCallback(async (todo: TodoItem) => {
    setCancelledTodoIds((prev) => new Set(prev).add(todo.id));
    try {
      await workspaceApi.cancelTodo(todo);
    } catch {}
    refreshTodos();
  }, [refreshTodos]);

  const handleCancelQueued = useCallback(async (queueId: string) => {
    setCancelledQueueIds((prev) => new Set(prev).add(queueId));
    try {
      await workspaceApi.cancelQueuedMessage(channelName, queueId);
    } catch {}
    refreshTodos();
  }, [channelName, refreshTodos]);

  const handleOpenQueued = useCallback((queue: QueuedMessage) => {
    setSelectedQueueItem({ channelName, queueId: queue.queueId, content: queue.content });
  }, [channelName, setSelectedQueueItem]);

  const handleOpenTimer = useCallback((timer: TimerItem) => {
    setSelectedStatusItem({ kind: 'timer', channelName, timer });
  }, [channelName, setSelectedStatusItem]);

  const handleOpenTodo = useCallback((todo: TodoItem) => {
    setSelectedStatusItem({ kind: 'todo', channelName, todo });
  }, [channelName, setSelectedStatusItem]);

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
              role="button"
              aria-pressed={selectedStatusItem?.kind === 'todo' && selectedStatusItem.todo.id === todo.id}
              tabIndex={0}
              onClick={() => handleOpenTodo(todo)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  handleOpenTodo(todo);
                }
              }}
              className={cn(
                'grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-start gap-1 rounded-md border border-transparent px-1.5 py-1 text-[11px] leading-snug text-foreground/90 transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                selectedStatusItem?.kind === 'todo' && selectedStatusItem.todo.id === todo.id && 'border-blue-500/50 bg-blue-500/10',
              )}
              title="查看任务详情"
            >
              <div className="min-w-0">
                <div className="line-clamp-2 break-words [overflow-wrap:anywhere]">{truncateTodo(todo.content)}</div>
                <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{todoOwnerLabel(todo)}</div>
              </div>
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  handleCancelTodo(todo);
                }}
                className={cancelButtonClass}
                title="取消此任务"
                aria-label="取消此任务"
              >
                <X className="size-3" />
              </button>
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
        isSidebar ? 'px-2 pb-2' : 'px-1 py-1',
        className,
      )}
    >
      {/* Todos and timers row */}
      {(inProgressCount > 0 || pendingCount > 0 || activeTimers.length > 0) && (
        <div className={cn('flex gap-2.5', isSidebar ? 'flex-col items-stretch' : 'flex-wrap items-center')}>
          {(inProgressCount > 0 || pendingCount > 0) && (
            isSidebar ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Agent todos</span>
                  <button
                    onClick={handleCancelTodos}
                    className={cancelButtonClass}
                    title="取消全部任务"
                    aria-label="取消全部任务"
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
                  <button
                    type="button"
                    onClick={() => handleOpenTodo(inProgressTodos[0])}
                    className={cn(
                      'inline-flex min-w-0 items-center gap-1 rounded border border-transparent px-1 py-0.5 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      selectedStatusItem?.kind === 'todo' && selectedStatusItem.todo.id === inProgressTodos[0]?.id && 'border-blue-500/50 bg-blue-500/10',
                    )}
                    title="查看进行中任务"
                  >
                    <Loader2 className="size-3 text-blue-500 animate-spin" />
                    <span>{inProgressCount} in progress</span>
                  </button>
                )}
                {inProgressCount > 0 && pendingCount > 0 && <span className="text-muted-foreground/30">·</span>}
                {pendingCount > 0 && (
                  <button
                    type="button"
                    onClick={() => handleOpenTodo(pendingTodos[0])}
                    className={cn(
                      'inline-flex min-w-0 items-center gap-1 rounded border border-transparent px-1 py-0.5 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      selectedStatusItem?.kind === 'todo' && selectedStatusItem.todo.id === pendingTodos[0]?.id && 'border-blue-500/50 bg-blue-500/10',
                    )}
                    title="查看等待中任务"
                  >
                    <Circle className="size-3" />
                    <span>{pendingCount} pending</span>
                  </button>
                )}
                <button
                  onClick={handleCancelTodos}
                  className={cn(cancelButtonClass, 'ml-0.5')}
                  title="取消全部任务"
                  aria-label="取消全部任务"
                >
                  <X className="size-3" />
                </button>
              </span>
            )
          )}
          {activeTimers.map((t) => (
            <div
              key={t.id}
              role="button"
              aria-pressed={selectedStatusItem?.kind === 'timer' && selectedStatusItem.timer.id === t.id}
              tabIndex={0}
              onClick={() => handleOpenTimer(t)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  handleOpenTimer(t);
                }
              }}
              className={cn(
                'grid max-w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-1 rounded-md border border-amber-500/20 bg-amber-500/5 px-1.5 py-1 transition-colors hover:bg-amber-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isSidebar ? 'w-full' : 'min-w-0 flex-1 basis-72',
                selectedStatusItem?.kind === 'timer' && selectedStatusItem.timer.id === t.id && 'border-amber-500/70 bg-amber-500/15 shadow-[inset_0_0_0_1px_rgba(245,158,11,0.25)]',
              )}
              title="查看 timer 详情"
            >
              <Timer className="mt-0.5 size-3 shrink-0 text-amber-500" />
              <span className="min-w-0 break-words leading-snug [overflow-wrap:anywhere]">
                {t.targetAgent ? `@${t.targetAgent} ` : ''}
                {t.message.length > 30 ? t.message.slice(0, 30) + '…' : t.message}
              </span>
              <span className="flex shrink-0 items-center gap-1">
                <span className="font-mono text-amber-500">{timeUntil(t.firesAt)}</span>
                {t.repeatIntervalSeconds && (
                  <span className="text-[10px] text-amber-500/80">/{intervalLabel(t.repeatIntervalSeconds)}</span>
                )}
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    handleCancelTimer(t.id);
                  }}
                  className={cancelButtonClass}
                  title="删除 timer"
                  aria-label="删除 timer"
                >
                  <X className="size-3" />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Queued messages */}
      {queuedMessages.map((q) => {
        const isSelected = selectedQueueItem?.channelName === channelName && selectedQueueItem.queueId === q.queueId;

        return (
          <div
            key={q.queueId}
            role="button"
            aria-pressed={isSelected}
            tabIndex={0}
            onClick={() => handleOpenQueued(q)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                handleOpenQueued(q);
              }
            }}
            className={cn(
              'grid w-full max-w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-1.5 rounded-md border border-blue-500/20 bg-blue-500/5 px-1.5 py-1 text-left text-blue-500 transition-colors hover:bg-blue-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-blue-400',
              isSelected && 'border-blue-500/70 bg-blue-500/15 shadow-[inset_0_0_0_1px_rgba(59,130,246,0.25)]',
            )}
            title="查看和编辑队列消息"
          >
            <MessageSquareMore className="mt-0.5 size-3 shrink-0" />
            <span className="min-w-0 break-words leading-snug [overflow-wrap:anywhere]">
              Queued: {q.content.length > 60 ? q.content.slice(0, 60) + '…' : q.content}
            </span>
            <button
              onClick={(event) => {
                event.stopPropagation();
                handleCancelQueued(q.queueId);
              }}
              className={cancelButtonClass}
              title="删除队列消息"
              aria-label="删除队列消息"
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
