const USER_ID_COOKIE = 'oa_user_id';
const USER_NAME_COOKIE = 'oa_user_name';
const USER_AVATAR_KEY = 'oa_user_avatar_url';
const MAX_AGE = 365 * 24 * 60 * 60; // 1 year in seconds

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
