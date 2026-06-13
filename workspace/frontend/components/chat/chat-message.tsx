'use client';

import { cn } from '@/lib/utils';
import { getAgentColor } from '@/lib/helpers';
import { Button } from '@/components/ui/button';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Eye,
  FileIcon,
  Hash,
  Info,
  MessageSquare,
  Paperclip,
  User,
} from 'lucide-react';
import { toast } from 'sonner';
import { memo, useCallback, useMemo, useState } from 'react';
import type { WorkspaceMessage, WorkspaceAgent } from '@/lib/types';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { MarkdownContent } from './markdown-content';
import { workspaceApi } from '@/lib/api';
import { useLayout } from '@/components/layout/layout-context';
import { useWorkspace } from '@/lib/workspace-context';

interface Attachment {
  fileId: string;
  filename: string;
  contentType: string;
  url: string;
}

function humanColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return `hsl(${hash % 360} 55% 82%)`;
}

function HumanAvatar({
  name,
  avatarUrl,
  seed,
}: {
  name: string;
  avatarUrl?: string | null;
  seed: string;
}) {
  return (
    <div
      className="size-9 rounded-lg shrink-0 flex items-center justify-center mt-0.5 overflow-hidden"
      style={{ backgroundColor: avatarUrl ? undefined : humanColor(seed) }}
    >
      {avatarUrl ? (
        <img src={avatarUrl} alt={name} className="h-full w-full object-cover" />
      ) : (
        <User className="size-4 text-zinc-700" />
      )}
    </div>
  );
}

function isPreviewable(contentType: string, filename: string): boolean {
  if (contentType?.startsWith('image/')) return true;
  if (contentType === 'text/html' || /\.html?$/i.test(filename)) return true;
  if (contentType === 'text/markdown' || /\.mdx?$/i.test(filename)) return true;
  if (contentType?.startsWith('text/') || /\.(json|js|ts|tsx|jsx|py|rs|go|java|rb|sh|yaml|yml)$/i.test(filename)) return true;
  return false;
}

function Attachments({ items }: { items: Attachment[] }) {
  if (!items || items.length === 0) return null;

  const { setViewMode } = useLayout();
  const { setSelectedFileId } = useWorkspace();

  const openPreview = useCallback((fileId: string) => {
    setSelectedFileId(fileId);
    setViewMode('files');
  }, [setSelectedFileId, setViewMode]);

  // Regenerate URLs from fileId to ensure they include current auth token
  const fixedItems = useMemo(() =>
    items.map((a) => ({ ...a, url: workspaceApi.getFileUrl(a.fileId) })),
    [items]
  );

  const images = fixedItems.filter((a) => a.contentType?.startsWith('image/'));
  const files = fixedItems.filter((a) => !a.contentType?.startsWith('image/'));

  return (
    <div className="mt-2 space-y-2">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((img) => (
            <button
              key={img.fileId}
              type="button"
              onClick={() => openPreview(img.fileId)}
              className="block rounded-lg overflow-hidden border hover:shadow-md transition-shadow max-w-sm cursor-pointer text-left"
            >
              <img
                src={img.url}
                alt={img.filename}
                className="max-h-64 w-auto object-contain"
                loading="lazy"
              />
            </button>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {files.map((file) => {
            const previewable = isPreviewable(file.contentType, file.filename);
            return previewable ? (
              <button
                key={file.fileId}
                type="button"
                onClick={() => openPreview(file.fileId)}
                className="flex items-center gap-2 px-3 py-2 rounded-lg border bg-muted hover:bg-muted/80 transition-colors text-sm cursor-pointer"
              >
                <Eye className="size-4 text-muted-foreground shrink-0" />
                <span className="truncate max-w-[200px]">{file.filename}</span>
              </button>
            ) : (
              <a
                key={file.fileId}
                href={file.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 px-3 py-2 rounded-lg border bg-muted hover:bg-muted/80 transition-colors text-sm"
              >
                <FileIcon className="size-4 text-muted-foreground shrink-0" />
                <span className="truncate max-w-[200px]">{file.filename}</span>
                <Download className="size-3 text-muted-foreground shrink-0" />
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface ChatMessageProps {
  message: WorkspaceMessage;
  agents?: WorkspaceAgent[];
  processSteps?: WorkspaceMessage[];
}

const LONG_MESSAGE_CHARS = 900;
const LONG_MESSAGE_LINES = 12;

function isLongContent(content: string): boolean {
  if (content.length > LONG_MESSAGE_CHARS) return true;
  return content.split(/\r?\n/).length > LONG_MESSAGE_LINES;
}

function shortId(id?: string): string {
  return id ? id.slice(0, 8) : '';
}

function metadataValue(metadata: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = metadata[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

interface ThreadInfo {
  title: string;
  count: number | null;
  preview: string | null;
  parentId: string | null;
  messages: Array<{ senderName?: string; content?: string; createdAt?: string }>;
}

function getThreadInfo(message: WorkspaceMessage): ThreadInfo | null {
  const metadata = message.metadata || {};
  const parentId = metadataValue(metadata, [
    'thread_id',
    'threadId',
    'parent_message_id',
    'parentMessageId',
    'topic_id',
    'topicId',
  ]);
  const title = metadataValue(metadata, [
    'topic_title',
    'topicTitle',
    'thread_title',
    'threadTitle',
    'topic',
    'thread',
    'title',
  ]);
  const countValue = metadataValue(metadata, [
    'reply_count',
    'replyCount',
    'thread_reply_count',
    'threadReplyCount',
    'message_count',
    'messageCount',
  ]);
  const preview = metadataValue(metadata, [
    'last_reply_preview',
    'lastReplyPreview',
    'thread_preview',
    'threadPreview',
    'topic_preview',
    'topicPreview',
  ]);
  const rawMessages = metadataValue(metadata, ['thread_messages', 'threadMessages', 'replies']);
  const messages = Array.isArray(rawMessages)
    ? rawMessages
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
      .map((entry) => ({
        senderName: (entry.senderName as string) || (entry.sender as string) || undefined,
        content: (entry.content as string) || (entry.text as string) || undefined,
        createdAt: (entry.createdAt as string) || (entry.created_at as string) || undefined,
      }))
    : [];

  const count = typeof countValue === 'number'
    ? countValue
    : typeof countValue === 'string' && countValue.trim()
      ? Number(countValue)
      : messages.length > 0
        ? messages.length
        : null;

  if (!parentId && !title && !preview && count === null && messages.length === 0) return null;
  return {
    title: typeof title === 'string' && title.trim() ? title : '话题',
    count: Number.isFinite(count) ? count : null,
    preview: typeof preview === 'string' && preview.trim() ? preview : null,
    parentId: typeof parentId === 'string' && parentId.trim() ? parentId : null,
    messages,
  };
}

function MessageBody({
  content,
  agentNames,
  isHuman,
}: {
  content: string;
  agentNames: string[];
  isHuman: boolean;
}) {
  if (!content) return null;
  return isHuman
    ? <div className="whitespace-pre-wrap break-words"><MentionText content={content} agentNames={agentNames} /></div>
    : <MarkdownContent content={content} agentNames={agentNames} />;
}

interface ProcessDetail {
  label: string;
  value: string;
}

const PROCESS_METADATA_LABELS: Record<string, string> = {
  agent_mode: '工作模式',
  queue_status: '队列状态',
  queue_id: '队列 ID',
  queued_message: '排队消息',
  session_error: '会话状态',
  tool: '工具',
  tool_name: '工具',
  command: '命令',
  exit_code: '退出码',
  status: '状态',
};

function detailValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(detailValue).filter(Boolean).join('\n');
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.entries(record)
      .filter(([, entry]) => entry !== undefined && entry !== null && String(entry).trim() !== '')
      .map(([key, entry]) => `${key}: ${detailValue(entry)}`)
      .join('\n');
  }
  return String(value ?? '').trim();
}

function processDetails(message: WorkspaceMessage): ProcessDetail[] {
  const details: ProcessDetail[] = [];
  const metadata = message.metadata || {};

  const visibleTargets = (message.targetAgents || []).filter((name) => name && name !== '__no_response__');
  if (visibleTargets.length > 0) {
    details.push({ label: '唤醒 Agent', value: visibleTargets.join(', ') });
  }
  if (message.mentions.length > 0) {
    details.push({ label: '提及', value: message.mentions.map((name) => `@${name}`).join(', ') });
  }

  const todos = metadata.todos as Array<{ content?: string; status?: string; assignee?: string }> | undefined;
  if (Array.isArray(todos) && todos.length > 0) {
    details.push({
      label: 'To-do list',
      value: todos.map((todo) => {
        const status = todo.status || 'todo';
        const assignee = todo.assignee ? ` -> ${todo.assignee}` : '';
        return `${status}: ${todo.content || '未命名任务'}${assignee}`;
      }).join('\n'),
    });
  }

  for (const [key, label] of Object.entries(PROCESS_METADATA_LABELS)) {
    const value = metadata[key];
    const text = detailValue(value);
    if (text) details.push({ label, value: text });
  }

  return details;
}

function stepProcessDetails(steps: WorkspaceMessage[]): ProcessDetail[] {
  const details: ProcessDetail[] = [];
  for (const step of steps) {
    const actor = step.senderName || 'Agent';
    if (step.messageType === 'todos') {
      const todos = step.metadata?.todos as Array<{ content?: string; status?: string; assignee?: string }> | undefined;
      if (Array.isArray(todos) && todos.length > 0) {
        details.push({
          label: `${actor} To-do`,
          value: todos.map((todo) => {
            const status = todo.status || 'todo';
            const assignee = todo.assignee ? ` -> ${todo.assignee}` : '';
            return `${status}: ${todo.content || '未命名任务'}${assignee}`;
          }).join('\n'),
        });
      }
      continue;
    }

    const content = step.content.trim();
    const running = content.match(/\*\*Running:\*\*\s*`([^`]+)`/);
    if (running) {
      details.push({ label: `${actor} 命令`, value: running[1] });
      continue;
    }
    const editing = content.match(/\*\*Editing:\*\*\s*`([^`]+)`/);
    if (editing) {
      details.push({ label: `${actor} 编辑`, value: editing[1] });
      continue;
    }
    const thinking = content.match(/^\*\*Thinking:\*\*\n([\s\S]+)$/);
    if (step.messageType === 'thinking' || thinking) {
      const text = (thinking?.[1] || content).trim();
      if (text && text.toLowerCase() !== 'thinking...') {
        details.push({ label: `${actor} 思考`, value: text });
      }
      continue;
    }
    if (content) {
      details.push({ label: `${actor} 状态`, value: content });
    }
  }
  return details;
}

function ProcessDetails({ details }: { details: ProcessDetail[] }) {
  if (details.length === 0) {
    return (
      <div className="mt-1.5 rounded-md border bg-muted/30 px-2.5 py-2 text-[11px] text-muted-foreground">
        本条消息没有可展示的过程详情。
      </div>
    );
  }
  return (
    <div className="mt-1.5 max-h-56 overflow-auto rounded-md border bg-muted/30 px-2.5 py-2 text-[11px] leading-snug">
      <div className="space-y-2">
        {details.map((detail, index) => (
          <div key={`${detail.label}-${index}`} className="grid grid-cols-[72px_minmax(0,1fr)] gap-2">
            <div className="text-muted-foreground">{detail.label}</div>
            <div className="whitespace-pre-wrap break-words text-foreground/80">{detail.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MentionText({ content, agentNames }: { content: string; agentNames: string[] }) {
  if (agentNames.length === 0) return <>{content}</>;

  const escaped = agentNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const mentionRegex = new RegExp(`(@(?:${escaped.join('|')}))(?=$|\\s|[.,!?;:，。！？；：、)\\]）】])`, 'g');
  const parts = content.split(mentionRegex);

  if (parts.length === 1) return <>{content}</>;

  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith('@') && agentNames.includes(part.slice(1))) {
          const color = getAgentColor(part.slice(1), agentNames);
          return (
            <span key={index} className={cn('font-medium rounded px-0.5', color.text)}>
              {part}
            </span>
          );
        }
        return part;
      })}
    </>
  );
}

function ThreadSummary({ thread }: { thread: ThreadInfo }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-2 rounded-md border border-border bg-muted/30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-2.5 py-2 text-left"
      >
        {open ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
        <MessageSquare className="size-3.5 shrink-0 text-primary" />
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-medium truncate">{thread.title}</span>
          {thread.preview && <span className="block text-[11px] text-muted-foreground truncate">{thread.preview}</span>}
        </span>
        {thread.count !== null && (
          <span className="shrink-0 rounded-full bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {thread.count}
          </span>
        )}
      </button>
      {open && (
        <div className="px-3 pb-2 space-y-1.5">
          {thread.messages.length > 0 ? (
            thread.messages.slice(0, 5).map((reply, index) => (
              <div key={`${reply.createdAt || index}-${reply.senderName || 'reply'}`} className="border-l-2 border-primary/30 pl-2">
                <div className="text-[10px] text-muted-foreground">
                  {reply.senderName || '未知'} {reply.createdAt ? new Date(reply.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                </div>
                <div className="text-[11px] whitespace-pre-wrap break-words">
                  {reply.content || '（空消息）'}
                </div>
              </div>
            ))
          ) : (
            <div className="text-[11px] text-muted-foreground">
              {thread.parentId ? shortId(thread.parentId) : '话题元数据'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export const ChatMessage = memo(function ChatMessage({ message, agents = [], processSteps = [] }: ChatMessageProps) {
  const { currentUser } = useWorkspace();
  const isHuman = message.senderType === 'human' || message.senderType === 'user';
  const isSystem = message.messageType === 'status';
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const agentNames = agents.map((a) => a.agentName);
  const agent = agents.find((a) => a.agentName === message.senderName);
  const summaryText = typeof message.summary === 'string' && message.summary.trim() ? message.summary.trim() : '';
  const bodyText = typeof message.body === 'string' && message.body.trim() ? message.body : message.content;
  const hasSummaryBodySplit = Boolean(summaryText && bodyText && summaryText !== bodyText);
  const visibleContent = hasSummaryBodySplit && !expanded ? summaryText : bodyText || summaryText || message.content;
  const longContent = hasSummaryBodySplit || isLongContent(bodyText || summaryText || message.content);
  const thread = useMemo(() => getThreadInfo(message), [message]);
  const details = useMemo(() => {
    const stepDetails = stepProcessDetails(processSteps);
    const messageProcessDetails = processDetails(message);
    return [...stepDetails, ...messageProcessDetails];
  }, [message, processSteps]);
  const rawAttachments = (message.metadata?.attachments as Record<string, unknown>[]) || [];
  const attachments: Attachment[] = rawAttachments.map((a) => ({
    fileId: (a.fileId || a.file_id || '') as string,
    filename: (a.filename || '') as string,
    contentType: (a.contentType || a.content_type || '') as string,
    url: '',
  }));

  const timestamp = message.createdAt
    ? new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(bodyText || message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('复制失败');
    }
  };

  // Status messages — subtle inline
  if (isSystem) {
    const isQueued = message.content.includes('queued');
    return (
      <div className="flex justify-center py-1">
        <span className={cn(
          'text-xs italic',
          isQueued
            ? 'text-blue-500 dark:text-blue-400'
            : 'text-muted-foreground'
        )}>
          {message.senderName}: {message.content}
        </span>
      </div>
    );
  }

  const isCurrentUser = isHuman && !!message.senderId && message.senderId === currentUser.id;
  const displayName = isHuman
    ? isCurrentUser
      ? '我'
      : (message.senderName && message.senderName !== 'user' ? message.senderName : '用户')
    : (agent?.displayName || message.senderName);
  const seed = message.senderId || message.senderName || 'human';
  const humanAvatarUrl = isCurrentUser
    ? currentUser.avatarUrl || message.senderAvatarUrl || null
    : message.senderAvatarUrl || null;

  return (
    <div className="py-1.5 group/message">
      <div className="flex items-start gap-2">
        {isHuman ? (
          <HumanAvatar name={displayName} avatarUrl={humanAvatarUrl} seed={seed} />
        ) : (
          <AgentAvatar
            name={message.senderName}
            avatar={agent?.avatar}
            avatarUrl={agent?.avatarUrl}
            size={36}
            square
            className="mt-0.5"
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-[15px] font-bold text-foreground truncate">{displayName}</span>
            {!isHuman && agent && (
              <span className={cn(
                'text-[10px] px-1.5 py-0.5 rounded font-semibold shrink-0',
                agent.role === 'master'
                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                  : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
              )}>
                {agent.role}
              </span>
            )}
            {timestamp && (
              <span className="text-xs text-muted-foreground">{timestamp}</span>
            )}
            {message.messageId && (
              <span className="hidden sm:inline-flex items-center gap-0.5 text-[10px] text-muted-foreground opacity-0 group-hover/message:opacity-100 transition-opacity">
                <Hash className="size-3" />
                {shortId(message.messageId)}
              </span>
            )}
          </div>
          <div className="text-sm leading-relaxed mt-0.5">
            <div className="relative min-w-0">
              <div className={cn(longContent && !expanded && !hasSummaryBodySplit && 'max-h-[240px] overflow-hidden')}>
                <MessageBody content={visibleContent} agentNames={agentNames} isHuman={isHuman} />
              </div>
              {longContent && !expanded && !hasSummaryBodySplit && (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-b from-transparent to-background" />
              )}
            </div>
            {longContent && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-primary hover:text-primary/80"
              >
                {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                {expanded ? '收起' : '展开全文'}
              </button>
            )}
            {thread && <ThreadSummary thread={thread} />}
            <Attachments items={attachments} />

            <div className="flex items-center gap-1 mt-1.5">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-xs text-muted-foreground hover:text-foreground gap-1"
                onClick={handleCopy}
              >
                {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                {copied ? '已复制' : '复制'}
              </Button>
              {attachments.length > 0 && (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <Paperclip className="size-3" />
                  {attachments.length}
                </span>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-xs text-muted-foreground hover:text-foreground gap-1"
                onClick={() => setDetailsOpen((v) => !v)}
              >
                {detailsOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                <Info className="size-3" />
                详情
              </Button>
            </div>
            {detailsOpen && (
              <ProcessDetails details={details} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
