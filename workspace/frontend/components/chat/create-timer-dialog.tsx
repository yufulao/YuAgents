'use client';

import { useEffect, useMemo, useState } from 'react';
import { Timer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { WorkspaceAgent } from '@/lib/types';
import { workspaceApi } from '@/lib/api';

interface CreateTimerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelName: string | null;
  agents: WorkspaceAgent[];
  onCreated?: () => void;
}

export function CreateTimerDialog({
  open,
  onOpenChange,
  channelName,
  agents,
  onCreated,
}: CreateTimerDialogProps) {
  const activeAgents = useMemo(
    () => agents.filter((agent) => agent.status !== 'offline' && agent.presenceStatus !== 'offline'),
    [agents],
  );
  const selectableAgents = activeAgents.length > 0 ? activeAgents : agents;
  const [targetAgent, setTargetAgent] = useState('');
  const [firstDelayMinutes, setFirstDelayMinutes] = useState('1');
  const [repeatMinutes, setRepeatMinutes] = useState('5');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setTargetAgent((current) => current || selectableAgents[0]?.agentName || '');
    setError('');
  }, [open, selectableAgents]);

  const handleSubmit = async () => {
    if (!channelName || !targetAgent || !message.trim()) return;
    const delay = Math.max(1, Math.round(Number(firstDelayMinutes) || 1)) * 60;
    const repeat = Math.max(1, Math.round(Number(repeatMinutes) || 0)) * 60;
    setSubmitting(true);
    setError('');
    try {
      await workspaceApi.createTimer({
        channel: channelName,
        targetAgent,
        delaySeconds: delay,
        repeatIntervalSeconds: repeat,
        message: message.trim(),
      });
      setMessage('');
      setFirstDelayMinutes('1');
      setRepeatMinutes('5');
      onCreated?.();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建 timer 失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Timer className="size-4 text-amber-500" />
            创建定时推进
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="timer-agent">目标 Agent</Label>
            <select
              id="timer-agent"
              value={targetAgent}
              onChange={(event) => setTargetAgent(event.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            >
              {selectableAgents.map((agent) => (
                <option key={agent.agentName} value={agent.agentName}>
                  {agent.agentName}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="timer-delay">首次触发（分钟）</Label>
              <Input
                id="timer-delay"
                type="number"
                min="1"
                value={firstDelayMinutes}
                onChange={(event) => setFirstDelayMinutes(event.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="timer-repeat">重复间隔（分钟）</Label>
              <Input
                id="timer-repeat"
                type="number"
                min="1"
                value={repeatMinutes}
                onChange={(event) => setRepeatMinutes(event.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="timer-message">Prompt</Label>
            <textarea
              id="timer-message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              className="min-h-[132px] resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              placeholder="例如：继续推进当前目标。先检查仓库、队列和合并状态；如果没有正在运行的任务，就拆出下一步并开始执行。"
            />
          </div>

          {error && <div className="text-xs text-destructive">{error}</div>}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || !channelName || !targetAgent || !message.trim()}>
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
