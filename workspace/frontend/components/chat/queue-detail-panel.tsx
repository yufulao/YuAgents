'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { ChevronLeft, MessageSquareMore, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useLayout } from '@/components/layout/layout-context';
import { workspaceApi } from '@/lib/api';
import { cn } from '@/lib/utils';

export function QueueDetailPanel() {
  const {
    selectedQueueItem,
    setSelectedQueueItem,
    isMobile,
    openMobileList,
    agentPanelWidth,
    setAgentPanelWidth,
  } = useLayout();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(selectedQueueItem?.content || '');
  }, [selectedQueueItem]);

  const handleClose = useCallback(() => {
    setSelectedQueueItem(null);
    if (isMobile) openMobileList();
  }, [isMobile, openMobileList, setSelectedQueueItem]);

  const handleSave = useCallback(async () => {
    if (!selectedQueueItem) return;
    const content = draft.trim();
    if (!content) {
      toast.error('队列消息不能为空');
      return;
    }
    setSaving(true);
    try {
      await workspaceApi.updateQueuedMessage(selectedQueueItem.channelName, selectedQueueItem.queueId, content);
      setSelectedQueueItem({ ...selectedQueueItem, content });
      document.dispatchEvent(new CustomEvent('queue-item-updated', {
        detail: { channelName: selectedQueueItem.channelName, queueId: selectedQueueItem.queueId, content },
      }));
      toast.success('队列消息已保存');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存队列消息失败');
    } finally {
      setSaving(false);
    }
  }, [draft, selectedQueueItem, setSelectedQueueItem]);

  const handleDelete = useCallback(async () => {
    if (!selectedQueueItem) return;
    setSaving(true);
    try {
      await workspaceApi.cancelQueuedMessage(selectedQueueItem.channelName, selectedQueueItem.queueId);
      document.dispatchEvent(new CustomEvent('queue-item-cancelled', {
        detail: { channelName: selectedQueueItem.channelName, queueId: selectedQueueItem.queueId },
      }));
      toast.success('队列消息已删除');
      setSelectedQueueItem(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除队列消息失败');
    } finally {
      setSaving(false);
    }
  }, [selectedQueueItem, setSelectedQueueItem]);

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

  if (!selectedQueueItem) return null;

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
              title="关闭队列消息"
              aria-label="关闭队列消息"
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
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-500">
              <MessageSquareMore className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-[15px] font-semibold leading-tight">队列消息</h3>
              <p className="truncate font-mono text-[11px] text-muted-foreground">{selectedQueueItem.queueId}</p>
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
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                className="min-h-[260px] resize-y text-sm"
                aria-label="队列消息内容"
              />
            </div>
          </div>
        </div>

        <div className="shrink-0 border-t px-3.5 py-3">
          <div className="flex gap-2">
            <Button
              variant="destructive"
              className="flex-1"
              onClick={handleDelete}
              disabled={saving}
            >
              <Trash2 className="size-4" />
              删除
            </Button>
            <Button
              className="flex-1"
              onClick={handleSave}
              disabled={saving || !draft.trim() || draft.trim() === selectedQueueItem.content.trim()}
            >
              {saving ? '保存中...' : '保存'}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
