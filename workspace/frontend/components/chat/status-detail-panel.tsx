'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { ChevronLeft, Circle, Loader2, Timer, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { useLayout } from '@/components/layout/layout-context';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useWorkspace } from '@/lib/workspace-context';
import { workspaceApi } from '@/lib/api';
import { cn } from '@/lib/utils';

function sourceLabel(value: string | null | undefined) {
  return (value || '').replace(/^(openagents:|human:)/, '') || 'unknown';
}

function dateLabel(value: string | null | undefined) {
  if (!value) return '未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function timerRemaining(firesAt: string) {
  const diff = new Date(firesAt).getTime() - Date.now();
  if (!Number.isFinite(diff)) return '未知';
  if (diff <= 0) return 'now';
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

function statusLabel(status: string) {
  if (status === 'in_progress') return '进行中';
  if (status === 'pending') return '等待中';
  if (status === 'completed') return '已完成';
  if (status === 'cancelled') return '已取消';
  if (status === 'active') return '活跃';
  return status || '未知';
}

export function StatusDetailPanel() {
  const {
    selectedStatusItem,
    setSelectedStatusItem,
    isMobile,
    openMobileList,
    agentPanelWidth,
    setAgentPanelWidth,
  } = useLayout();
  const { refreshTodos } = useWorkspace();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [saving, setSaving] = useState(false);

  const handleClose = useCallback(() => {
    setSelectedStatusItem(null);
    if (isMobile) openMobileList();
  }, [isMobile, openMobileList, setSelectedStatusItem]);

  const handleDelete = useCallback(async () => {
    if (!selectedStatusItem) return;
    setSaving(true);
    try {
      if (selectedStatusItem.kind === 'timer') {
        await workspaceApi.cancelTimer(selectedStatusItem.timer.id);
        document.dispatchEvent(new CustomEvent('timer-item-cancelled', {
          detail: { channelName: selectedStatusItem.channelName, timerId: selectedStatusItem.timer.id },
        }));
        toast.success('Timer 已删除');
      } else {
        await workspaceApi.cancelTodo(selectedStatusItem.todo);
        document.dispatchEvent(new CustomEvent('todo-item-cancelled', {
          detail: { channelName: selectedStatusItem.channelName, todoId: selectedStatusItem.todo.id },
        }));
        refreshTodos();
        toast.success('任务已取消');
      }
      setSelectedStatusItem(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败');
    } finally {
      setSaving(false);
    }
  }, [refreshTodos, selectedStatusItem, setSelectedStatusItem]);

  const handleResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (isMobile) return;
    event.preventDefault();

    const panel = panelRef.current;
    const right = panel?.getBoundingClientRect().right ?? window.innerWidth;
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

  const detail = useMemo(() => {
    if (!selectedStatusItem) return null;
    if (selectedStatusItem.kind === 'timer') {
      const timer = selectedStatusItem.timer;
      return {
        icon: <Timer className="size-5" />,
        title: 'Timer',
        id: timer.id,
        content: timer.message,
        toneClass: 'bg-amber-500/10 text-amber-500',
        deleteLabel: '删除 Timer',
        fields: [
          ['状态', statusLabel(timer.status)],
          ['剩余', timerRemaining(timer.firesAt)],
          ['触发时间', dateLabel(timer.firesAt)],
          ['目标 Agent', timer.targetAgent ? `@${timer.targetAgent}` : '未指定'],
          ['创建者', sourceLabel(timer.createdBy)],
          ['重复', timer.repeatIntervalSeconds ? `${timer.repeatIntervalSeconds}s` : '否'],
          ['已触发', String(timer.fireCount)],
        ],
      };
    }

    const todo = selectedStatusItem.todo;
    return {
      icon: todo.status === 'in_progress' ? <Loader2 className="size-5 animate-spin" /> : <Circle className="size-5" />,
      title: todo.status === 'in_progress' ? 'In progress' : 'Pending',
      id: todo.id,
      content: todo.content,
      toneClass: todo.status === 'in_progress' ? 'bg-blue-500/10 text-blue-500' : 'bg-muted text-muted-foreground',
      deleteLabel: '取消任务',
      fields: [
        ['状态', statusLabel(todo.status)],
        ['负责人', sourceLabel(todo.assignee || todo.createdBy)],
        ['创建者', sourceLabel(todo.createdBy)],
        ['Channel', todo.channelName],
        ['Thread', todo.threadId || '无'],
        ['更新时间', dateLabel(todo.updatedAt)],
        ['创建时间', dateLabel(todo.createdAt)],
      ],
    };
  }, [selectedStatusItem]);

  if (!selectedStatusItem || !detail) return null;

  return (
    <>
      <div className="absolute inset-0 z-10 bg-black/10" onClick={handleClose} />
      <div
        ref={panelRef}
        style={isMobile ? undefined : { width: 'var(--agent-panel-width)' }}
        className={cn(
          'absolute bottom-0 right-0 top-0 z-20 flex min-h-0 flex-col overflow-hidden border-l bg-background shadow-xl animate-in slide-in-from-right duration-200',
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

        {isMobile ? (
          <div className="sticky top-0 z-10 flex h-12 shrink-0 items-center justify-between border-b bg-background px-3">
            <button
              onClick={handleClose}
              className="flex h-9 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
              title="返回列表"
            >
              <ChevronLeft className="size-4" />
              返回
            </button>
            <button
              onClick={handleClose}
              className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title="关闭详情"
              aria-label="关闭详情"
            >
              <X className="size-4" />
            </button>
          </div>
        ) : (
          <div className="flex shrink-0 items-center justify-end px-3 pt-3">
            <button
              onClick={handleClose}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-zinc-200/60 dark:hover:bg-zinc-800"
              title="关闭"
            >
              <X className="size-4" />
            </button>
          </div>
        )}

        <div className="shrink-0 px-5 pb-4">
          <div className="flex items-center gap-3">
            <div className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg', detail.toneClass)}>
              {detail.icon}
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-[15px] font-semibold leading-tight">{detail.title}</h3>
              <p className="truncate font-mono text-[11px] text-muted-foreground">{detail.id}</p>
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3.5">
          <div className="overflow-hidden rounded-lg border">
            <div className="border-b px-3.5 py-2.5">
              <span className="text-xs font-medium">内容</span>
            </div>
            <div className="space-y-3 p-3">
              <Textarea
                value={detail.content}
                readOnly
                className="min-h-[220px] resize-y text-sm"
                aria-label="状态内容"
              />
            </div>
          </div>

          <div className="overflow-hidden rounded-lg border">
            <div className="border-b px-3.5 py-2.5">
              <span className="text-xs font-medium">详情</span>
            </div>
            <dl className="divide-y text-xs">
              {detail.fields.map(([label, value]) => (
                <div key={label} className="grid grid-cols-[84px_minmax(0,1fr)] gap-2 px-3.5 py-2.5">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="min-w-0 break-words text-foreground [overflow-wrap:anywhere]">{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>

        <div className="shrink-0 border-t px-3.5 py-3">
          <Button
            variant="destructive"
            className="w-full"
            onClick={handleDelete}
            disabled={saving}
          >
            <Trash2 className="size-4" />
            {saving ? '处理中...' : detail.deleteLabel}
          </Button>
        </div>
      </div>
    </>
  );
}
