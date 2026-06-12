import { getApiUrl } from './api-url';
import type { Workspace } from './types';

const LOCAL_WORKSPACE_TOKENS_KEY = 'oa_local_workspace_tokens';

async function localFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${getApiUrl()}${path}`, {
    ...options,
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.message || body?.detail || `API error (${res.status})`);
  }

  const json = await res.json();
  return json.data;
}

function workspaceAccessErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '');
  if (message.includes('Workspace not found') || message.includes('API error (404)')) {
    return 'workspace 名称或 slug 不存在';
  }
  if (message.includes('Invalid workspace credentials') || message.includes('API error (401)')) {
    return 'workspace token/password 不正确';
  }
  if (message.includes('Multiple workspaces')) {
    return '有多个同名 workspace，请改用 workspace slug 登录';
  }
  if (message.includes('API error (500)')) {
    return '远端 workspace 服务内部错误，请检查服务端是否已部署最新版本并查看后端日志';
  }
  if (
    message.includes('API error (502)') ||
    message.includes('Remote relay cannot reach the local control API') ||
    message.includes('local control API')
  ) {
    return '远端 relay 无法连接本地控制面，请检查 LOCAL_CONTROL_API_URL 或 SSH 反向隧道';
  }
  if (message.includes('Failed to fetch') || message.includes('NetworkError')) {
    return '无法连接远端 workspace 服务，请检查 API 地址和网络';
  }
  return message || '无法打开 workspace';
}

export function getLocalWorkspaceTokens(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(LOCAL_WORKSPACE_TOKENS_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function rememberLocalWorkspaceToken(slug: string, token: string) {
  if (typeof window === 'undefined' || !slug || !token) return;
  const tokens = getLocalWorkspaceTokens();
  tokens[slug] = token;
  window.localStorage.setItem(LOCAL_WORKSPACE_TOKENS_KEY, JSON.stringify(tokens));
}

export async function listLocalWorkspaces(): Promise<Workspace[]> {
  return localFetch<Workspace[]>('/v1/workspaces');
}

export async function verifyWorkspaceAccess(workspace: string, token: string): Promise<Workspace> {
  try {
    return await localFetch<Workspace>('/v1/workspaces/resolve', {
      method: 'POST',
      headers: token ? { 'X-Workspace-Token': token } : {},
      body: JSON.stringify({ workspace }),
    });
  } catch (error) {
    throw new Error(workspaceAccessErrorMessage(error));
  }
}

export async function getLocalWorkspaceToken(slug: string): Promise<string> {
  const data = await localFetch<{ token: string }>(`/v1/workspaces/${encodeURIComponent(slug)}/local-token`);
  rememberLocalWorkspaceToken(slug, data.token);
  return data.token;
}

export async function deleteLocalWorkspace(slug: string, token: string): Promise<void> {
  await localFetch(`/v1/workspaces/${encodeURIComponent(slug)}`, {
    method: 'DELETE',
    headers: { 'X-Workspace-Token': token },
  });
}

export async function createLocalWorkspace(params: {
  name: string;
  agentName?: string;
  agentType?: string;
}): Promise<{ workspaceId: string; slug: string; name: string; token: string }> {
  const created = await localFetch<{ workspaceId: string; slug: string; name: string; token: string }>('/v1/workspaces', {
    method: 'POST',
    body: JSON.stringify({
      name: params.name,
      agent_name: params.agentName || undefined,
      agent_type: params.agentType || undefined,
    }),
  });
  rememberLocalWorkspaceToken(created.slug, created.token);
  return created;
}
