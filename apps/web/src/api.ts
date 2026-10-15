const TOKEN_KEY = 'local_chat_token';
const USER_KEY = 'local_chat_user';

/**
 * Per-tab session (sessionStorage), so two tabs can log in as different users.
 * Cleared when the tab is closed; not shared across tabs like localStorage.
 */
const store: Storage =
  typeof sessionStorage !== 'undefined' ? sessionStorage : (globalThis as any).localStorage;

export type User = { login: string; name: string };

/** Drop legacy shared localStorage session once (avoids sticky cross-tab login). */
function migrateAwayFromLocalStorage() {
  try {
    if (typeof localStorage === 'undefined') return;
    if (localStorage.getItem(TOKEN_KEY) || localStorage.getItem(USER_KEY)) {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    }
  } catch {
    /* ignore */
  }
}

export function getToken(): string | null {
  migrateAwayFromLocalStorage();
  return store.getItem(TOKEN_KEY);
}

export function getUser(): User | null {
  migrateAwayFromLocalStorage();
  const raw = store.getItem(USER_KEY);
  return raw ? JSON.parse(raw) : null;
}

export function setSession(token: string, user: User) {
  migrateAwayFromLocalStorage();
  store.setItem(TOKEN_KEY, token);
  store.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession() {
  store.removeItem(TOKEN_KEY);
  store.removeItem(USER_KEY);
  migrateAwayFromLocalStorage();
}

async function request(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Content-Type', 'application/json');
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

export const api = {
  register: (body: { login: string; name: string; password: string }) =>
    request('/api/auth/register', { method: 'POST', body: JSON.stringify(body) }),
  login: (body: { login: string; password: string }) =>
    request('/api/auth/login', { method: 'POST', body: JSON.stringify(body) }),
  dialogs: (opts: { page?: number; limit?: number; filter?: string | null } = {}) => {
    const page = opts.page && opts.page > 0 ? opts.page : 1;
    const limit = opts.limit && opts.limit > 0 ? opts.limit : 30;
    const q = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (opts.filter) q.set('filter', opts.filter);
    return request(`/api/dialogs?${q}`);
  },
  users: (opts: { page?: number; limit?: number; q?: string | null } = {}) => {
    const page = opts.page && opts.page > 0 ? opts.page : 1;
    const limit = opts.limit && opts.limit > 0 ? opts.limit : 30;
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    const q = typeof opts.q === 'string' ? opts.q.trim() : '';
    if (q) params.set('q', q);
    return request(`/api/users?${params}`);
  },
  dm: (peerLogin: string) =>
    request('/api/dm', { method: 'POST', body: JSON.stringify({ peerLogin }) }),
  group: (title: string, memberLogins: string[]) =>
    request('/api/groups', {
      method: 'POST',
      body: JSON.stringify({ title, memberLogins })
    }),
  messages: (dialogId: string, opts: { page?: number; limit?: number } = {}) => {
    const page = opts.page && opts.page > 0 ? opts.page : 1;
    const limit = opts.limit && opts.limit > 0 ? opts.limit : 30;
    const q = new URLSearchParams({ page: String(page), limit: String(limit) });
    return request(`/api/dialogs/${dialogId}/messages?${q}`);
  },
  send: (dialogId: string, content: string) =>
    request(`/api/dialogs/${dialogId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content })
    }),
  markRead: (dialogId: string) =>
    request(`/api/dialogs/${dialogId}/read`, { method: 'POST', body: '{}' }),
  /** Viewport / per-message receipt → Chat3 SetMessageStatus */
  markMessageStatus: (dialogId: string, messageId: string, status: 'read' | 'delivered' = 'read') =>
    request(`/api/dialogs/${dialogId}/messages/${encodeURIComponent(messageId)}/status`, {
      method: 'POST',
      body: JSON.stringify({ status })
    }),
  typing: (dialogId: string) =>
    request(`/api/dialogs/${dialogId}/typing`, { method: 'POST', body: '{}' }),
  dialog: (dialogId: string) => request(`/api/dialogs/${dialogId}`),
  members: (dialogId: string) => request(`/api/dialogs/${dialogId}/members`),
  addMembers: (dialogId: string, memberLogins: string[]) =>
    request(`/api/dialogs/${dialogId}/members`, {
      method: 'POST',
      body: JSON.stringify({ memberLogins })
    }),
  removeMember: (dialogId: string, memberLogin: string) =>
    request(`/api/dialogs/${dialogId}/members/${encodeURIComponent(memberLogin)}`, {
      method: 'DELETE'
    }),
  renameDialog: (dialogId: string, title: string) =>
    request(`/api/dialogs/${dialogId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title })
    })
};

export function connectUpdates(onUpdate: (payload: any) => void): WebSocket {
  const token = getToken();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token || '')}`);
  ws.onmessage = (ev) => {
    try {
      onUpdate(JSON.parse(ev.data));
    } catch {
      /* ignore */
    }
  };
  return ws;
}
