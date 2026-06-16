'use client';

import { cn } from '@/lib/utils';
import { ChatMessage } from './chat-message';
import { IntermediateSteps } from './intermediate-steps';
import { Button } from '@/components/ui/button';
import { ArrowDown } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { WorkspaceMessage, WorkspaceAgent } from '@/lib/types';

// ── Message Grouping ──

type MessageGroup =
  | { type: 'chat'; message: WorkspaceMessage; processSteps: WorkspaceMessage[] }
  | { type: 'steps'; messages: WorkspaceMessage[] };

function groupMessages(messages: WorkspaceMessage[], showAllSteps: boolean): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let currentSteps: WorkspaceMessage[] = [];
  let pendingTriggerIndex: number | null = null;

  const flushSteps = () => {
    if (currentSteps.length > 0) {
      groups.push({ type: 'steps', messages: [...currentSteps] });
      currentSteps = [];
    }
  };

  messages.forEach((msg) => {
    if (msg.messageType === 'status' || msg.messageType === 'thinking' || msg.messageType === 'todos') {
      currentSteps.push(msg);
    } else {
      const processSteps = [...currentSteps];
      if (pendingTriggerIndex !== null && currentSteps.length > 0) {
        const trigger = groups[pendingTriggerIndex];
        if (trigger && trigger.type === 'chat') {
          trigger.processSteps = [...trigger.processSteps, ...currentSteps];
        }
      }
      if (showAllSteps) {
        flushSteps();
      } else {
        currentSteps = [];
      }
      groups.push({ type: 'chat', message: msg, processSteps });
      pendingTriggerIndex = groups.length - 1;
    }
  });

  flushSteps();
  return groups;
}

// Stable key for a group
function groupKey(group: MessageGroup): string {
  return group.type === 'chat'
    ? group.message.messageId
    : `steps-${group.messages[0].messageId}`;
}

function isTerminalStatus(msg: WorkspaceMessage) {
  return (
    msg.messageType === 'status' &&
    /stopped|stopping failed/i.test(msg.content)
  );
}

// ── Component ──

interface ChatMessagesProps {
  sessionId?: string | null;
  messages: WorkspaceMessage[];
  agents?: WorkspaceAgent[];
  showAllSteps: boolean;
  className?: string;
  /** Increment to force scroll to bottom after explicit user actions. */
  scrollKey?: number;
  /** Callback to load older messages (infinite scroll upward). */
  loadOlder?: () => Promise<void>;
  /** Whether there are older messages available to load. */
  hasOlder?: boolean;
  /** Whether older messages are currently being loaded. */
  loadingOlder?: boolean;
}

export function ChatMessages({ sessionId, messages, agents, showAllSteps, className, scrollKey, loadOlder, hasOlder, loadingOlder }: ChatMessagesProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  // Track session identity to reset scroll state on thread switch
  const prevSessionRef = useRef<string | null>(null);
  const pendingInitialScrollRef = useRef<string | null>(null);
  // Auto-follow is enabled only while the viewport is actually at the live end,
  // or after explicit actions such as sending a message / pressing the button.
  const autoFollowRef = useRef(true);
  const scrollIntentRef = useRef(0);
  const programmaticBottomScrollRef = useRef(false);
  const previousContentKeyRef = useRef('');

  // Separate loading indicators (optimistic) from real messages
  const loadingMessages = useMemo(() => messages.filter((m) => m.messageType === 'loading'), [messages]);
  const realMessages = useMemo(() => messages.filter((m) => m.messageType !== 'loading'), [messages]);

  // Filter: skip empty status messages. Step groups remain in this list
  // even when the toggle is off, because completed steps are attached to
  // the next chat message's "详情" panel instead of being rendered inline.
  const filteredMessages = useMemo(() => {
    const isStep = (msg: WorkspaceMessage) => msg.messageType === 'status' || msg.messageType === 'thinking' || msg.messageType === 'todos';

    // Deduplicate: if a chat message follows thinking from the same agent
    // with matching content, hide the thinking (it was the final answer
    // streamed early as "thinking" before being posted as "chat").
    const deduped = realMessages.filter((msg, i) => {
      if (msg.messageType !== 'thinking') return true;
      // Look ahead for a chat message from the same agent
      for (let j = i + 1; j < realMessages.length; j++) {
        const next = realMessages[j];
        if (next.senderName !== msg.senderName) continue;
        if (next.messageType === 'status' || next.messageType === 'thinking') continue;
        // Found a chat message from the same agent — check content overlap.
        // Thinking is truncated to 500 chars + "...", so check if chat
        // starts with the thinking text (minus trailing "...").
        const thinkText = msg.content.replace(/\.\.\.$/,'').trim();
        if (thinkText && next.content.startsWith(thinkText)) return false;
        break;
      }
      return true;
    });

    const nonEmpty = deduped.filter((msg) => !isStep(msg) || msg.content.trim());
    return nonEmpty;
  }, [realMessages]);

  // Group into chat messages and intermediate step clusters
  const groups = useMemo(() => groupMessages(filteredMessages, showAllSteps), [filteredMessages, showAllSteps]);

  const hasTerminalStatus = realMessages.some(isTerminalStatus);

  // Loading indicator counts as a virtual row when present
  const hasLoading = loadingMessages.length > 0 && !hasTerminalStatus;
  const totalCount = groups.length + (hasLoading ? 1 : 0);
  const lastMessage = messages[messages.length - 1];
  const contentKey = `${sessionId ?? ''}:${messages.length}:${totalCount}:${lastMessage?.messageId ?? ''}:${lastMessage?.content?.length ?? 0}`;

  // ── Virtualizer ──
  const virtualizer = useVirtualizer({
    count: totalCount,
    getScrollElement: () => containerRef.current,
    estimateSize: () => 80, // rough estimate; dynamic measurement corrects it
    overscan: 10,
    getItemKey: (index) => {
      if (index < groups.length) return groupKey(groups[index]);
      return 'loading-indicator';
    },
  });

  const stopAutoFollow = useCallback(() => {
    autoFollowRef.current = false;
    programmaticBottomScrollRef.current = false;
    scrollIntentRef.current += 1;
  }, []);

  const scrollToBottom = useCallback(() => {
    if (totalCount > 0) {
      autoFollowRef.current = true;
      programmaticBottomScrollRef.current = true;
      const intent = ++scrollIntentRef.current;
      virtualizer.scrollToIndex(totalCount - 1, { align: 'end' });
      // Also nudge the native scroll in case the virtualizer hasn't measured the last item yet
      requestAnimationFrame(() => {
        if (intent !== scrollIntentRef.current || !autoFollowRef.current) {
          if (intent === scrollIntentRef.current) {
            programmaticBottomScrollRef.current = false;
          }
          return;
        }
        if (containerRef.current) {
          containerRef.current.scrollTop = containerRef.current.scrollHeight;
        }
        setShowScrollBtn(false);
        autoFollowRef.current = true;
        programmaticBottomScrollRef.current = false;
      });
    }
  }, [totalCount, virtualizer]);

  // New messages should not move the viewport. Only entering a different
  // session, explicit sends, or the manual button can scroll to the bottom.
  useEffect(() => {
    const currentSessionId = sessionId ?? null;
    if (currentSessionId !== prevSessionRef.current) {
      prevSessionRef.current = currentSessionId;
      autoFollowRef.current = true;
      scrollIntentRef.current += 1;
      setShowScrollBtn(false);
      pendingInitialScrollRef.current = currentSessionId;
    }
  }, [sessionId]);

  // Force scroll when scrollKey changes (user sent a message).
  useEffect(() => {
    if (scrollKey) {
      requestAnimationFrame(() => scrollToBottom());
    }
  }, [scrollKey, scrollToBottom]);

  // Track scroll position for "scroll to bottom" button + infinite scroll upward
  const loadingOlderInternalRef = useRef(false);
  const pendingOlderRestoreRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);

  const loadOlderAndPreserveScroll = useCallback(async () => {
    const el = containerRef.current;
    if (!el || !loadOlder || loadingOlderInternalRef.current) return;

    loadingOlderInternalRef.current = true;
    pendingOlderRestoreRef.current = {
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
    };
    stopAutoFollow();
    setShowScrollBtn(true);

    try {
      await loadOlder();
    } finally {
      loadingOlderInternalRef.current = false;
    }
  }, [loadOlder, stopAutoFollow]);

  useLayoutEffect(() => {
    const snapshot = pendingOlderRestoreRef.current;
    const el = containerRef.current;
    if (!snapshot || !el) return;

    const restore = () => {
      const delta = el.scrollHeight - snapshot.scrollHeight;
      el.scrollTop = snapshot.scrollTop + delta;
      autoFollowRef.current = false;
      setShowScrollBtn(true);
    };

    restore();
    requestAnimationFrame(() => {
      restore();
      pendingOlderRestoreRef.current = null;
    });
  }, [messages.length, totalCount]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const pendingInitialSession = pendingInitialScrollRef.current;
    if (pendingInitialSession && pendingInitialSession === (sessionId ?? null) && totalCount > 0) {
      requestAnimationFrame(() => {
        scrollToBottom();
        pendingInitialScrollRef.current = null;
      });
      previousContentKeyRef.current = contentKey;
      return;
    }

    if (pendingOlderRestoreRef.current) return;
    const contentChanged = previousContentKeyRef.current !== contentKey;
    const shouldFollowNewContent = contentChanged && autoFollowRef.current && totalCount > 0;
    previousContentKeyRef.current = contentKey;

    if (shouldFollowNewContent) {
      requestAnimationFrame(() => scrollToBottom());
      return;
    }

    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    setShowScrollBtn(totalCount > 0 && !isNearBottom);
  }, [sessionId, messages.length, totalCount, contentKey, scrollToBottom]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onScroll = async () => {
      const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
      if (programmaticBottomScrollRef.current) {
        setShowScrollBtn(false);
        return;
      }

      setShowScrollBtn(!isNearBottom);
      if (isNearBottom) {
        autoFollowRef.current = true;
      } else {
        stopAutoFollow();
      }

      // Infinite scroll: load older messages when near the top
      if (
        el.scrollTop < 100 &&
        hasOlder &&
        !loadingOlder &&
        !loadingOlderInternalRef.current &&
        loadOlder
      ) {
        await loadOlderAndPreserveScroll();
      }
    };

    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, [hasOlder, loadingOlder, loadOlder, loadOlderAndPreserveScroll, stopAutoFollow]);

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={containerRef}
        className={cn('h-full overflow-y-auto', className)}
      >
        {loadingOlder && (
          <div className="flex items-center justify-center py-3">
            <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        )}
        {hasOlder && !loadingOlder && loadOlder && (
          <button
            onClick={async () => {
              await loadOlderAndPreserveScroll();
            }}
            className="flex items-center justify-center py-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Load older messages
          </button>
        )}
        <div
          style={{
            height: virtualizer.getTotalSize(),
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const index = virtualRow.index;

            // Loading indicator row (last virtual item when loading)
            if (index >= groups.length) {
              return (
                <div
                  key="loading-indicator"
                  ref={virtualizer.measureElement}
                  data-index={index}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <div className="flex items-start gap-3 py-1">
                    <div className="size-8 shrink-0" />
                    <div className="py-1.5">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src="/breathing-dots.gif" alt="Agent is working" width={44} height={14} className="opacity-90" />
                    </div>
                  </div>
                </div>
              );
            }

            const group = groups[index];
            return (
              <div
                key={groupKey(group)}
                ref={virtualizer.measureElement}
                data-index={index}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {group.type === 'chat' ? (
                  <ChatMessage
                    message={group.message}
                    agents={agents}
                    processSteps={group.processSteps}
                  />
                ) : (
                  <IntermediateSteps
                    steps={group.messages}
                    agents={agents}
                    isActive={index === groups.length - 1}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {showScrollBtn && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2">
          <Button
            variant="secondary"
            size="sm"
            className="rounded-full shadow-lg"
            onClick={() => scrollToBottom()}
          >
            <ArrowDown className="size-4 mr-1" />
            New messages
          </Button>
        </div>
      )}
    </div>
  );
}
