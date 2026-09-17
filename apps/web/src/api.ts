const TOKEN_KEY = 'local_chat_token';
const USER_KEY = 'local_chat_user';

export type User = { login: string; name: string };

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getUser(): User | null {
  const raw = localStorage.getItem(USER_KEY);
  return raw ? JSON.parse(raw) : null;
}

export function setSession(token: string, user: User) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
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
  dialogs: () => request('/api/dialogs'),
  users: () => request('/api/users'),
  dm: (peerLogin: string) =>
    request('/api/dm', { method: 'POST', body: JSON.stringify({ peerLogin }) }),
  group: (title: string, memberLogins: string[]) =>
    request('/api/groups', {
      method: 'POST',
      body: JSON.stringify({ title, memberLogins })
    }),
  messages: (dialogId: string) => request(`/api/dialogs/${dialogId}/messages`),
  send: (dialogId: string, content: string) =>
    request(`/api/dialogs/${dialogId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content })
    }),
  markRead: (dialogId: string) =>
    request(`/api/dialogs/${dialogId}/read`, { method: 'POST', body: '{}' }),
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
