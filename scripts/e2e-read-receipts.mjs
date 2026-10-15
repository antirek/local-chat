/**
 * E2E: viewport read receipts
 * - Bob receives Alice message while chat closed → unread badge
 * - Bob opens DM → @message-visible → mark-read / SetMessageStatus
 * - Bob unread clears; Alice outgoing tick becomes read (when statuses reload)
 *
 * Run: cd local-chat && node scripts/e2e-read-receipts.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.LOCAL_CHAT_URL || 'http://127.0.0.1:5173';
const API = process.env.LOCAL_CHAT_API || 'http://127.0.0.1:4000';
const stamp = Date.now().toString(36);
const alice = { login: `ra_${stamp}`, name: 'Read Alice', password: 'test1234' };
const bob = { login: `rb_${stamp}`, name: 'Read Bob', password: 'test1234' };

async function register(page, user) {
  await page.goto(BASE);
  await page.waitForSelector('form.auth-card, .chat-shell', { timeout: 20000 });
  if (await page.locator('.chat-shell').count()) {
    await page.getByRole('button', { name: 'Выйти' }).click();
    await page.waitForSelector('form.auth-card');
  }
  const switchBtn = page.getByRole('button', { name: /Создать аккаунт|У меня есть аккаунт/ });
  if ((await switchBtn.textContent())?.includes('Создать')) await switchBtn.click();
  await page.locator('input').nth(0).fill(user.login);
  await page.locator('input').nth(1).fill(user.name);
  await page.locator('input').nth(2).fill(user.password);
  await page.getByRole('button', { name: /Зарегистрироваться/ }).click();
  await page.waitForSelector('.chat-shell', { timeout: 20000 });
}

async function openDm(page, peerLogin) {
  await page.getByRole('button', { name: 'DM' }).click();
  await page.waitForSelector('[data-testid="dm-modal"]');
  await page.locator('[data-testid="user-search"]').fill(peerLogin);
  await page.locator(`[data-testid="user-option"][data-login="${peerLogin}"]`).click();
  await page.locator('[data-testid="dm-modal"]').getByRole('button', { name: 'Открыть' }).click();
  await page.waitForSelector('[data-testid="feed-scroll"], .lc-feed, .message-feed', {
    timeout: 20000
  });
}

async function sendMessage(page, text) {
  const input = page.locator('textarea').first().or(page.locator('[contenteditable="true"]').first());
  await input.waitFor({ timeout: 10000 });
  await input.click();
  await input.fill(text);
  await page.keyboard.press('Enter');
}

async function loginApi(user) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: user.login, password: user.password })
  });
  if (!res.ok) throw new Error(`login ${user.login}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function apiDialogs(token) {
  const res = await fetch(`${API}/api/dialogs`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`dialogs: ${res.status}`);
  return res.json();
}

async function apiMessages(token, dialogId) {
  const res = await fetch(`${API}/api/dialogs/${dialogId}/messages`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`messages: ${res.status}`);
  return res.json();
}

function unreadSum(dialogsPayload) {
  return (dialogsPayload.dialogs || []).reduce((s, d) => s + (d.unreadCount || 0), 0);
}

async function waitFor(fn, { timeoutMs = 20000, intervalMs = 500, label = 'condition' } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timeout waiting for ${label}; last=${JSON.stringify(last)}`);
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--no-sandbox']
  });
  const alicePage = await (await browser.newContext()).newPage();
  const bobPage = await (await browser.newContext()).newPage();

  const markCalls = [];
  bobPage.on('request', (req) => {
    const u = req.url();
    if (u.includes('/read') || u.includes('/status')) {
      markCalls.push({ method: req.method(), url: u });
    }
  });

  console.log('1) Register users', alice.login, bob.login);
  await register(alicePage, alice);
  await register(bobPage, bob);

  console.log('2) Alice opens DM and sends message (Bob stays on list)');
  await openDm(alicePage, bob.login);
  const msg = `read-receipt ${stamp}`;
  await sendMessage(alicePage, msg);
  await alicePage.waitForTimeout(1500);

  const aliceAuth = await loginApi(alice);
  const bobAuth = await loginApi(bob);

  console.log('3) Bob should have unread > 0 before opening chat');
  await waitFor(
    async () => {
      const d = await apiDialogs(bobAuth.token);
      const u = unreadSum(d);
      console.log('   bob unread=', u);
      return u > 0 ? d : null;
    },
    { label: 'bob unread > 0', timeoutMs: 25000 }
  );

  console.log('4) Bob opens DM — viewport should fire read markers');
  await openDm(bobPage, alice.login);
  await bobPage.waitForTimeout(2500);

  const bobSaw = await bobPage.content();
  if (!bobSaw.includes(msg) && !bobSaw.includes('read-receipt')) {
    throw new Error('Bob feed missing Alice message');
  }
  console.log('   Bob sees message: ok');

  if (!markCalls.length) {
    // give observer a bit more time / tab already visible
    await bobPage.waitForTimeout(2000);
  }
  console.log('   mark API calls:', markCalls);

  const hasMark =
    markCalls.some((c) => c.url.includes('/read') || c.url.includes('/status')) ||
    markCalls.length > 0;
  if (!hasMark) {
    throw new Error('No mark-read / message-status requests from Bob after opening chat');
  }
  console.log('   viewport mark request: ok');

  console.log('5) Bob unread should clear');
  await waitFor(
    async () => {
      const d = await apiDialogs(bobAuth.token);
      const u = unreadSum(d);
      console.log('   bob unread after open=', u);
      return u === 0 ? true : null;
    },
    { label: 'bob unread == 0', timeoutMs: 30000 }
  );
  console.log('   unread cleared: ok');

  console.log('6) Alice outgoing statuses should include peer read (eventual)');
  const aliceDialogs = await apiDialogs(aliceAuth.token);
  const dialogId = (aliceDialogs.dialogs || [])[0]?.dialogId;
  if (!dialogId) throw new Error('Alice has no dialog');

  await waitFor(
    async () => {
      const { messages } = await apiMessages(aliceAuth.token, dialogId);
      const mine = (messages || []).find((m) => m.content === msg || String(m.content).includes(stamp));
      if (!mine) return null;
      const statuses = mine.statuses || [];
      const peerRead = statuses.some(
        (s) =>
          String(s.userId || '').toLowerCase() === bob.login &&
          String(s.status || '').toLowerCase() === 'read'
      );
      console.log('   alice msg statuses=', JSON.stringify(statuses));
      return peerRead ? true : null;
    },
    { label: 'alice sees bob read status', timeoutMs: 45000 }
  );
  console.log('   peer read status on message: ok');

  await browser.close();
  console.log('\nE2E READ RECEIPTS PASSED');
}

main().catch((err) => {
  console.error('\nE2E READ RECEIPTS FAILED', err);
  process.exit(1);
});
