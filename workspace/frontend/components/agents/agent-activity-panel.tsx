'use client';

import { useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Brain,
  CheckCircle2,
  Circle,
  CircleStop,
  Clock,
  Loader2,
  RefreshCw,
  Terminal,
} from 'lucide-react';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { cn } from '@/lib/utils';
import { timeAgo } from '@/lib/helpers';
import type { WorkspaceAgent, WorkspaceSession } from '@/lib/types';

interface AgentActivityPanelProps {
  agents: WorkspaceAgent[];
  sessions: WorkspaceSession[];
  activeSessionIds: Set<string>;
  onRefresh?: () => Promise<void>;
}

type ActivityState =
  | 'offline'
  | 'online'
  | 'starting'
  | 'thinking'
  | 'running_command'
  | 'waiting_input'
  | 'working'
  | 'stopping'
  | 'stopped'
  | 'error';

interface AgentActivity {
  agent: WorkspaceAgent;
  session: WorkspaceSession | null;
  state: ActivityState;
  summary: string;
  updatedAt: string | null;
}

const STATE_META: Record<ActivityState, { label: string; className: string; icon: typeof Activity }> = {
  offline: { label: 'offline', className: 'text-zinc-500 dark:text-zinc-400', icon: Circle },
  online: { label: 'online', className: 'text-emerald-600 dark:text-emerald-400', icon: CheckCircle2 },
  starting: { label: 'starting', className: 'text-blue-600 dark:text-blue-400', icon: Loader2 },
  thinking: { label: 'thinking', className: 'text-amber-600 dark:text-amber-400', icon: Brain },
  running_command: { label: 'running command', className: 'text-blue-600 dark:text-blue-400', icon: Terminal },
  waiting_input: { label: 'waiting input', className: 'text-violet-600 dark:text-violet-400', icon: Clock },
  working: { label: 'working', className: 'text-emerald-600 dark:text-emerald-400', icon: Activity },
  stopping: { label: 'stopping', className: 'text-zinc-500 dark:text-zinc-400', icon: Loader2 },
  stopped: { label: 'stopped', className: 'text-zinc-500 dark:text-zinc-400', icon: CircleStop },
  error: { label: 'error', className: 'text-red-600 dark:text-red-400', icon: AlertTriangle },
};

const LIFECYCLE_STATES = new Set<ActivityState>([
  'offline',
  'online',
  'starting',
  'thinking',
  'running_command',
  'waiting_input',
  'stopping',
  'stopped',
  'error',
]);

function normalizeState(agent: WorkspaceAgent, hasActiveThread: boolean): ActivityState {
  const lifecycle = agent.lifecycleState as ActivityState | undefined;
  if (lifecycle && LIFECYCLE_STATES.has(lifecycle)) return lifecycle;
  if (hasActiveThread) return 'working';
  if (agent.status === 'online') return 'online';
  if (agent.status === 'error') return 'error';
  if (agent.status === 'stopped' || agent.status === 'disabled') return 'stopped';
  return 'offline';
}

function getCurrentSession(
  agent: WorkspaceAgent,
  sessions: WorkspaceSession[],
  activeSessionIds: Set<string>,
): WorkspaceSession | null {
  if (agent.currentChannel) {
    const session = sessions.find((s) => s.sessionId === agent.currentChannel);
    if (session) return session;
  }
  return sessions.find(
    (session) => activeSessionIds.has(session.sessionId) && session.participants.includes(agent.agentName),
  ) || null;
}

function getAgentActivities(
  agents: WorkspaceAgent[],
  sessions: WorkspaceSession[],
  activeSessionIds: Set<string>,
): AgentActivity[] {
  return agents
    .map((agent) => {
      const session = getCurrentSession(agent, sessions, activeSessionIds);
      const state = normalizeState(agent, Boolean(session));
      const summary = agent.activitySummary || STATE_META[state].label;
      const updatedAt = session?.lastEventAt
        ? new Date(session.lastEventAt).toISOString()
        : agent.lastHeartbeatAt || session?.createdAt || null;

      return { agent, session, state, summary, updatedAt };
    })
    .sort((a, b) => {
      const priority = (activity: AgentActivity) =>
        activity.state !== 'online' && activity.state !== 'offline' ? 0 : activity.state === 'online' ? 1 : 2;
      const byPriority = priority(a) - priority(b);
      if (byPriority !== 0) return byPriority;
      const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return bTime - aTime;
    });
}

export function AgentActivityPanel({
  agents,
  sessions,
  activeSessionIds,
  onRefresh,
}: AgentActivityPanelProps) {
  const activities = getAgentActivities(agents, sessions, activeSessionIds);
  const activeActivities = activities.filter(
    (activity) => activity.state !== 'online' && activity.state !== 'offline',
  );
  const onlineIdle = activities.filter((activity) => activity.state === 'online');
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    if (!onRefresh || refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  if (agents.length === 0) return null;

  return (
    <div className="mt-3 border-t border-border pt-3">
      <div className="flex items-center justify-between px-2 pb-1.5">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Activity className="size-3" />
          <span>Active agents</span>
          {activeActivities.length > 0 && <span>({activeActivities.length})</span>}
        </div>
        {onRefresh && (
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            className="size-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-60"
            title="Refresh status"
          >
            <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
          </button>
        )}
      </div>

      {activeActivities.length > 0 ? (
        <div className="space-y-1">
          {activeActivities.slice(0, 4).map((activity) => {
            const meta = STATE_META[activity.state];
            const Icon = meta.icon;
            return (
              <div
                key={`${activity.agent.agentName}-${activity.session?.sessionId || activity.state}`}
                className="mx-1.5 rounded-lg px-1.5 py-1.5 hover:bg-muted/60 transition-colors"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <AgentAvatar
                    name={activity.agent.displayName || activity.agent.agentName}
                    avatar={activity.agent.avatar}
                    avatarUrl={activity.agent.avatarUrl}
                    size={20}
                    status={activity.agent.status}
                    showStatus
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-[12px] font-medium truncate">
                        {activity.agent.displayName || activity.agent.agentName}
                      </span>
                      <span className={cn('inline-flex items-center gap-1 text-[10px] shrink-0', meta.className)}>
                        <Icon className={cn(
                          'size-3',
                          (activity.state === 'thinking' || activity.state === 'starting' || activity.state === 'stopping') && 'animate-pulse',
                        )} />
                        {meta.label}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 text-[11px] text-muted-foreground min-w-0">
                      <span className="truncate">{activity.session?.title || activity.session?.sessionId || 'No active thread'}</span>
                      {activity.updatedAt && <span className="shrink-0">· {timeAgo(activity.updatedAt)}</span>}
                    </div>
                  </div>
                </div>
                <div className="mt-1 ml-7 min-w-0">
                  <p className="text-[11px] leading-snug text-muted-foreground truncate">
                    {activity.summary}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
          No active agent work detected.
        </div>
      )}

      {onlineIdle.length > 0 && (
        <div className="mt-2 px-2">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            <span className="truncate">
              Online idle: {onlineIdle.slice(0, 3).map((activity) => activity.agent.displayName || activity.agent.agentName).join(', ')}
              {onlineIdle.length > 3 ? ` +${onlineIdle.length - 3}` : ''}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
