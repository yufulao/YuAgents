const USER_ID_COOKIE = 'oa_user_id';
const USER_NAME_COOKIE = 'oa_user_name';
const USER_AVATAR_KEY = 'oa_user_avatar_url';
const WORKSPACE_USER_PROFILES_KEY = 'local_user_profiles';
const LAST_WORKSPACE_USER_PROFILE_KEY = 'last_local_user_profile';
const MAX_AGE = 365 * 24 * 60 * 60; // 1 year in seconds

export interface WorkspaceStoredUserProfile {
  id: string;
  name: string;
  avatarUrl: string | null;
  updatedAt: number;
}

function setCookie(name: string, value: string) {
  document.cookie = `${name}=${encodeURIComponent(value)};path=/;max-age=${MAX_AGE};SameSite=Lax`;
}

function getCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export function generateUserId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `user-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function getStoredIdentity(): { id: string; name: string; avatarUrl?: string | null } | null {
  try {
    const id = getCookie(USER_ID_COOKIE);
    const name = getCookie(USER_NAME_COOKIE);
    const avatarUrl = window.localStorage.getItem(USER_AVATAR_KEY);
    if (id && name) return { id, name, avatarUrl: avatarUrl || null };
  } catch {
    // SSR or cookie access blocked
  }
  return null;
}

export function storeIdentity(id: string, name: string, avatarUrl?: string | null) {
  try {
    setCookie(USER_ID_COOKIE, id);
    setCookie(USER_NAME_COOKIE, name);
    if (avatarUrl) {
      window.localStorage.setItem(USER_AVATAR_KEY, avatarUrl);
    } else if (avatarUrl === '') {
      window.localStorage.removeItem(USER_AVATAR_KEY);
    }
  } catch {
    // cookie access blocked
  }
}

function profileNameKey(name: string): string {
  return `name:${name.trim().toLowerCase()}`;
}

function isProfile(value: unknown): value is WorkspaceStoredUserProfile {
  if (!value || typeof value !== 'object') return false;
  const profile = value as Partial<WorkspaceStoredUserProfile>;
  return typeof profile.id === 'string' && typeof profile.name === 'string';
}

function profileMap(settings: Record<string, unknown>): Record<string, WorkspaceStoredUserProfile> {
  const value = settings[WORKSPACE_USER_PROFILES_KEY];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const profiles: Record<string, WorkspaceStoredUserProfile> = {};
  for (const [key, profile] of Object.entries(value as Record<string, unknown>)) {
    if (isProfile(profile)) profiles[key] = profile;
  }
  return profiles;
}

export function withWorkspaceIdentityProfile(
  settings: Record<string, unknown>,
  profile: { id: string; name: string; avatarUrl?: string | null },
): Record<string, unknown> {
  const cleanName = profile.name.trim();
  const nextProfile: WorkspaceStoredUserProfile = {
    id: profile.id,
    name: cleanName,
    avatarUrl: profile.avatarUrl || null,
    updatedAt: Date.now(),
  };
  const profiles = profileMap(settings);
  profiles[profile.id] = nextProfile;
  if (cleanName) profiles[profileNameKey(cleanName)] = nextProfile;
  return {
    ...settings,
    [WORKSPACE_USER_PROFILES_KEY]: profiles,
    [LAST_WORKSPACE_USER_PROFILE_KEY]: nextProfile,
  };
}

export function getWorkspaceIdentityProfile(
  settings: Record<string, unknown> | null | undefined,
  identity: { id?: string; name?: string },
): WorkspaceStoredUserProfile | null {
  if (!settings) return null;
  const profiles = profileMap(settings);
  if (identity.id && profiles[identity.id]) return profiles[identity.id];
  if (identity.name) {
    const byName = profiles[profileNameKey(identity.name)];
    if (byName) return byName;
  }
  const last = settings[LAST_WORKSPACE_USER_PROFILE_KEY];
  return isProfile(last) ? last : null;
}
