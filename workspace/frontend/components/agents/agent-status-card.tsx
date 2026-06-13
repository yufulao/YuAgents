'use client';

import { useState } from 'react';
import { MoreHorizontal, Crown, UserMinus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { timeAgo } from '@/lib/helpers';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { SectionHeader } from '@/components/sessions/section-header';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { workspaceApi } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace-context';
import { toast } from 'sonner';
import type { WorkspaceAgent } from '@/lib/types';

interface AgentStatusCardProps {
  agents: WorkspaceAgent[];
}

export function AgentStatusCard({ agents }: AgentStatusCardProps) {
  const { refreshAgents } = useWorkspace();
  const [busy, setBusy] = useState(false);

  const handlePromote = async (agentName: string) => {
    setBusy(true);
    try {
      await workspaceApi.updateAgentRole(agentName, 'master');
      toast.success(`${agentName} promoted to master`);
      await refreshAgents();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update role');
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (agentName: string) => {
    if (!confirm(`Remove ${agentName} from workspace?`)) return;
    setBusy(true);
    try {
      await workspaceApi.removeAgent(agentName);
      toast.success(`${agentName} removed`);
      await refreshAgents();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to remove agent');
    } finally {
      setBusy(false);
    }
  };

  const statusText = (agent: WorkspaceAgent) => {
    if (agent.presenceStatus === 'online' || agent.isConnected) {
      if (agent.hasActiveWork) {
        if (agent.activityState === 'running_command') return '在线 · 执行命令';
        if (agent.activityState === 'editing_file') return '在线 · 编辑文件';
        if (agent.activityState === 'waiting_input') return '在线 · 等待输入';
        if (agent.activityState === 'error') return '在线 · 阻塞';
        if (agent.activityState === 'starting') return '在线 · 启动中';
        return '在线 · 工作中';
      }
      return '在线 · 空闲';
    }
    if (agent.presenceStatus === 'stopped' || agent.status === 'stopped') return '已停止';
    return agent.lastHeartbeatAt ? `离线 · ${timeAgo(agent.lastHeartbeatAt)}` : '离线';
  };
  const statusDot = (agent: WorkspaceAgent) =>
    agent.activityState && agent.activityState !== 'idle'
      ? agent.activityState
      : agent.presenceStatus || agent.status;

  return (
    <div className="space-y-2">
      <SectionHeader label="Agents" />
      <div className="space-y-1.5">
        {agents.map((agent) => {
          const isMaster = agent.role === 'master';

          return (
            <div
              key={agent.agentName}
              className="flex items-center gap-2.5 px-2 py-1.5 rounded-md group"
            >
              <AgentAvatar name={agent.agentName} size={28} status={statusDot(agent)} showStatus />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{agent.agentName}</p>
                <p className="text-xs text-muted-foreground">
                  {agent.agentType && <span className="capitalize">{agent.agentType} · </span>}
                  {statusText(agent)}
                </p>
              </div>
              <span className={cn(
                'text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full font-medium',
                isMaster
                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                  : 'text-muted-foreground'
              )}>
                {agent.role}
              </span>

              {/* Management dropdown — only show when multiple agents */}
              {agents.length > 1 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6 opacity-0 group-hover:opacity-100 transition-opacity"
                      disabled={busy}
                    >
                      <MoreHorizontal className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {!isMaster && (
                      <DropdownMenuItem onClick={() => handlePromote(agent.agentName)}>
                        <Crown className="size-4 text-amber-500" />
                        Set as Master
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => handleRemove(agent.agentName)}
                    >
                      <UserMinus className="size-4" />
                      Remove
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
