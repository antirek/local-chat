/**
 * Seed a realistic local-chat fixture for manual testing.
 *
 * - Ensures user `sergey` exists
 * - Creates 100 users (u001…u100)
 * - Opens 100 DMs: sergey ↔ each user
 * - Creates several groups (5–10 members each, including sergey)
 * - Seeds a few messages so dialog list is not empty
 *
 * Usage:
 *   node scripts/seed-test-chats.mjs
 *   API=http://127.0.0.1:4000 PASSWORD=test1234 node scripts/seed-test-chats.mjs
 */
const API = process.env.API || process.env.LOCAL_CHAT_API || 'http://127.0.0.1:4000';
const PASSWORD = process.env.PASSWORD || 'test1234';
const SERGEY_LOGIN = (process.env.SERGEY_LOGIN || 'sergey').toLowerCase();
const SERGEY_NAME = process.env.SERGEY_NAME || 'Sergey';
const USER_COUNT = Number(process.env.USER_COUNT || 100);
const GROUP_COUNT = Number(process.env.GROUP_COUNT || 8);
const CONCURRENCY = Number(process.env.CONCURRENCY || 8);

async function request(path, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function ensureUser(login, name) {
  try {
    return await request('/api/auth/register', {
      method: 'POST',
      body: { login, name, password: PASSWORD }
    });
  } catch (e) {
    if (e.status === 409) {
      return request('/api/auth/login', {
        method: 'POST',
        body: { login, password: PASSWORD }
      });
    }
    throw e;
  }
}

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function pad(n, width = 3) {
  return String(n).padStart(width, '0');
}

function pickMembers(logins, size, seed) {
  const out = [];
  let x = seed;
  const used = new Set();
  while (out.length < size && out.length < logins.length) {
    x = (x * 1103515245 + 12345) >>> 0;
    const idx = x % logins.length;
    const login = logins[idx];
    if (used.has(login)) continue;
    used.add(login);
    out.push(login);
  }
  return out;
}

async function main() {
  console.log(`API=${API} users=${USER_COUNT} groups=${GROUP_COUNT}`);

  console.log(`1) Ensure ${SERGEY_LOGIN}`);
  const sergey = await ensureUser(SERGEY_LOGIN, SERGEY_NAME);
  const sergeyToken = sergey.token;
  console.log(`   ok ${sergey.user.login}`);

  console.log(`2) Create ${USER_COUNT} users`);
  const indices = Array.from({ length: USER_COUNT }, (_, i) => i + 1);
  const peerLogins = [];
  let createdUsers = 0;
  let existingUsers = 0;

  await mapPool(indices, CONCURRENCY, async (n) => {
    const login = `u${pad(n)}`;
    const name = `User ${pad(n)}`;
    try {
      await request('/api/auth/register', {
        method: 'POST',
        body: { login, name, password: PASSWORD }
      });
      createdUsers++;
    } catch (e) {
      if (e.status === 409) existingUsers++;
      else throw e;
    }
    peerLogins.push(login);
  });
  peerLogins.sort();
  console.log(`   created=${createdUsers} existing=${existingUsers}`);

  console.log(`3) Create ${USER_COUNT} DMs (sergey ↔ each)`);
  let dmCreated = 0;
  let dmExisting = 0;
  const dmDialogs = [];
  await mapPool(peerLogins, CONCURRENCY, async (peerLogin) => {
    const data = await request('/api/dm', {
      method: 'POST',
      token: sergeyToken,
      body: { peerLogin }
    });
    if (data.created) dmCreated++;
    else dmExisting++;
    dmDialogs.push({ peerLogin, dialogId: data.dialog?.dialogId });
  });
  console.log(`   dm created=${dmCreated} existing=${dmExisting}`);

  console.log(`4) Create ${GROUP_COUNT} groups (5–10 members)`);
  const groups = [];
  for (let g = 1; g <= GROUP_COUNT; g++) {
    const size = 5 + ((g * 3) % 6); // 5..10
    const members = pickMembers(peerLogins, size - 1, g * 9973); // + sergey as creator
    const title = `Team ${pad(g)} (${size})`;
    const data = await request('/api/groups', {
      method: 'POST',
      token: sergeyToken,
      body: { title, memberLogins: members }
    });
    groups.push({
      title,
      dialogId: data.dialog?.dialogId,
      members: [SERGEY_LOGIN, ...members]
    });
    console.log(`   ${title} → ${data.dialog?.dialogId} members=${members.length + 1}`);
  }

  console.log('5) Seed sample messages');
  let messagesSent = 0;
  // First 20 DMs: sergey says hi; peer replies on every 3rd
  const sampleDms = dmDialogs.slice(0, 20);
  for (const { peerLogin, dialogId } of sampleDms) {
    if (!dialogId) continue;
    await request(`/api/dialogs/${dialogId}/messages`, {
      method: 'POST',
      token: sergeyToken,
      body: { content: `Привет, ${peerLogin}! Это тестовый чат.` }
    });
    messagesSent++;
    if (messagesSent % 3 === 0) {
      const peer = await request('/api/auth/login', {
        method: 'POST',
        body: { login: peerLogin, password: PASSWORD }
      });
      await request(`/api/dialogs/${dialogId}/messages`, {
        method: 'POST',
        token: peer.token,
        body: { content: `Привет, ${SERGEY_LOGIN}! Ответ от ${peerLogin}.` }
      });
      messagesSent++;
    }
  }
  // Each group: intro from sergey
  for (const g of groups) {
    if (!g.dialogId) continue;
    await request(`/api/dialogs/${g.dialogId}/messages`, {
      method: 'POST',
      token: sergeyToken,
      body: { content: `Добро пожаловать в «${g.title}». Тестовая группа.` }
    });
    messagesSent++;
  }
  console.log(`   messages=${messagesSent}`);

  const dialogs = await request('/api/dialogs', { token: sergeyToken });
  console.log('\nDONE');
  console.log({
    sergey: SERGEY_LOGIN,
    password: PASSWORD,
    users: USER_COUNT,
    sergeyDialogs: (dialogs.dialogs || []).length,
    groups: groups.map((g) => g.title)
  });
  console.log(`\nLogin at UI as ${SERGEY_LOGIN} / ${PASSWORD}`);
}

main().catch((e) => {
  console.error('SEED FAILED', e.status || '', e.message, e.data || '');
  process.exit(1);
});
