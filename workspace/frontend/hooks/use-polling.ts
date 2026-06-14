'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { workspaceApi } from '@/lib/api';
import { eventToMessage } from '@/lib/types';
import type { WorkspaceMessage } from '@/lib/types';

interface UsePollingOptions {
  sessionId: string | null;
  enabled?: boolean;
  /** Pre-loaded messages to display immediately (avoids loading state). */
  initialMessages?: WorkspaceMessage[];
}

export function useMessagePolling({ sessionId, enabled = true, initialMessages }: UsePollingOptions) {
  const [messages, setMessages] = useState<WorkspaceMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  // Increments when messages are bulk-replaced (backfill/session switch) to signal scroll-to-bottom
  const [generation, setGeneration] = useState(0);

  // Refs for cursor tracking
  const newestIdRef = useRef<string | null>(null);
  const oldestIdRef = useRef<string | null>(null);
  const lastActivityRef = useRef<number>(Date.now());
  const historyLoadedRef = useRef(false);
  // Track current session to discard stale responses
  const currentSessionRef = useRef<string | null>(sessionId);

  // Reset when session changes
  useEffect(() => {
    currentSessionRef.current = sessionId;

    if (initialMessages && initialMessages.length > 0) {
      // Seed with cached messages for instant display
      setMessages(initialMessages);
      newestIdRef.current = initialMessages[initialMessages.length - 1].messageId;
      oldestIdRef.current = initialMessages[0].messageId;
      historyLoadedRef.current = true;
      setHasOlder(true); // assume there may be older until proven otherwise
      setLoading(false);
    } else {
      setMessages([]);
      newestIdRef.current = null;
      oldestIdRef.current = null;
      historyLoadedRef.current = false;
      setHasOlder(false);
      setLoading(false);
    }
  }, [sessionId]); // intentionally omit initialMessages — only seed on session change

  // Track user activity for adaptive polling
  useEffect(() => {
    const onActivity = () => {
      lastActivityRef.current = Date.now();
    };
    window.addEventListener('keydown', onActivity);
    window.addEventListener('click', onActivity);
    return () => {
      window.removeEventListener('keydown', onActivity);
      window.removeEventListener('click', onActivity);
    };
  }, []);

  const loadHistory = useCallback(async () => {
    if (!sessionId) return;

    setLoading(true);
    try {
      const result = await workspaceApi.loadMessageHistory(sessionId, { limit: 50 });

      // Discard if session changed
      if (sessionId !== currentSessionRef.current) return;

      if (result.events.length > 0) {
        // Events come newest-first from sort=desc, reverse for chronological display
        const historicMessages = result.events.map(eventToMessage).reverse();
        setMessages(historicMessages);
        // newest_id is the most recent event (first in desc order)
        newestIdRef.current = result.newest_id || historicMessages[historicMessages.length - 1].messageId;
        // oldest_id for loading older messages
        oldestIdRef.current = result.oldest_id || historicMessages[0].messageId;
        setHasOlder(result.has_more);
        setGeneration((g) => g + 1);
      } else {
        setHasOlder(false);
      }

      historyLoadedRef.current = true;
    } catch {
      historyLoadedRef.current = true;
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  // Forward poll: fetch new messages since the newest known
  const poll = useCallback(async () => {
    if (!sessionId || !historyLoadedRef.current) return;

    try {
      // Keep fetching while there are more events (handles bursts of status messages)
      let hasMore = true;
      while (hasMore) {
        const result = await workspaceApi.pollMessages(
          sessionId,
          newestIdRef.current ?? undefined,
        );

        // Discard response if session changed while request was in flight
        if (sessionId !== currentSessionRef.current) return;

        const newMessages = result.messages;
        hasMore = result.hasMore && newMessages.length > 0;

        if (newMessages.length > 0) {
          const lastMsg = newMessages[newMessages.length - 1];
          newestIdRef.current = lastMsg.messageId;

          setMessages((prev) => {
            const existingIds = new Set(prev.map((m) => m.messageId));
            const unique = newMessages.filter((m) => !existingIds.has(m.messageId));
            return unique.length > 0 ? [...prev, ...unique] : prev;
          });
        }
      }
    } catch {
      // Polling error — will retry on next interval
    }
  }, [sessionId]);

  const reconcileLatest = useCallback(async () => {
    if (!sessionId || !historyLoadedRef.current) return;

    try {
      const result = await workspaceApi.loadMessageHistory(sessionId, { limit: 50 });

      if (sessionId !== currentSessionRef.current) return;

      if (result.events.length > 0) {
        const latestMessages = result.events.map(eventToMessage).reverse();
        const newest = result.newest_id || latestMessages[latestMessages.length - 1]?.messageId;
        if (newest) newestIdRef.current = newest;

        setMessages((prev) => {
          const byId = new Map(prev.map((m) => [m.messageId, m]));
          let changed = false;

          for (const msg of latestMessages) {
            if (!byId.has(msg.messageId)) {
              byId.set(msg.messageId, msg);
              changed = true;
            }
          }

          if (!changed) return prev;
          return Array.from(byId.values()).sort(
            (a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime(),
          );
        });
      }
    } catch {
      // Best-effort reconciliation; normal polling/SSE continues.
    }
  }, [sessionId]);

  // Load older messages (infinite scroll upward)
  const loadOlder = useCallback(async () => {
    if (!sessionId || !hasOlder || loadingOlder) return;

    setLoadingOlder(true);
    try {
      const result = await workspaceApi.loadMessageHistory(sessionId, {
        before: oldestIdRef.current ?? undefined,
        limit: 30,
      });

      if (sessionId !== currentSessionRef.current) return;

      if (result.events.length > 0) {
        const olderMessages = result.events.map(eventToMessage).reverse();
        oldestIdRef.current = result.oldest_id || olderMessages[0].messageId;
        setHasOlder(result.has_more);

        setMessages((prev) => {
          const existingIds = new Set(prev.map((m) => m.messageId));
          const unique = olderMessages.filter((m) => !existingIds.has(m.messageId));
          return unique.length > 0 ? [...unique, ...prev] : prev;
        });
      } else {
        setHasOlder(false);
      }
    } catch {
      // Best-effort
    } finally {
      setLoadingOlder(false);
    }
  }, [sessionId, hasOlder, loadingOlder]);

  // Initial load + SSE with polling fallback
  useEffect(() => {
    if (!sessionId || !enabled) return;

    if (!historyLoadedRef.current) {
      loadHistory();
    }

    // Try SSE first for instant updates, fall back to polling
    let eventSource: EventSource | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const startPolling = () => {
      const getDelay = () => {
        const idle = Date.now() - lastActivityRef.current;
        return idle > 60_000 ? 15_000 : 2_000;
      };
      const schedule = () => {
        timeout = setTimeout(async () => {
          await poll();
          schedule();
        }, getDelay());
      };
      schedule();
    };

    try {
      const sseUrl = workspaceApi.getSSEUrl(sessionId);
      eventSource = new EventSource(sseUrl);

      eventSource.onmessage = (ev) => {
        if (sessionId !== currentSessionRef.current) return;
        try {
          const event = JSON.parse(ev.data);
          const msg = eventToMessage(event);
          newestIdRef.current = msg.messageId;
          setMessages((prev) => {
            if (prev.some((m) => m.messageId === msg.messageId)) return prev;
            return [...prev, msg];
          });
        } catch {
          // malformed event
        }
      };

      eventSource.onerror = () => {
        eventSource?.close();
        eventSource = null;
        startPolling();
      };
    } catch {
      startPolling();
    }

    return () => {
      if (eventSource) eventSource.close();
      if (timeout) clearTimeout(timeout);
    };
  }, [sessionId, enabled, poll, loadHistory]);

  useEffect(() => {
    if (!sessionId || !enabled) return;
    const interval = setInterval(() => {
      reconcileLatest();
    }, 5000);
    return () => clearInterval(interval);
  }, [sessionId, enabled, reconcileLatest]);

  // If seeded with cache, do a background refresh to catch any new messages
  useEffect(() => {
    if (!sessionId || !enabled) return;
    if (initialMessages && initialMessages.length > 0) {
      // Immediately poll for new messages after cache display
      poll();
    }
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Force immediate poll (after sending a message)
  const forceRefresh = useCallback(() => {
    lastActivityRef.current = Date.now();
    poll();
  }, [poll]);

  return { messages, loading, forceRefresh, generation, loadOlder, hasOlder, loadingOlder };
}
