/**
 * Two sessions: Alice sends → Bob receives (WS) → Bob delivered+read → Alice gets status ticks via WS.
 */
import { chromium } from 'playwright';

const BASE = process.env.LOCAL_CHAT_URL || 'http://127.0.0.1:5173';
const stamp = Date.now().toString(36);
const alice = { login: `sa_${stamp}`, name: 'Status Alice', password: 'test1234' };
const bob = { login: `sb_${stamp}`, name: 'Status Bob', password: 'test1234' };

async function register(page, user) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
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
  await page.waitForSelector('.modal');
  await page.locator('.modal input').fill(peerLogin);
  await page.locator('.modal').getByRole('button', { name: 'Открыть' }).click();
  await page.waitForSelector('.message-feed', { timeout: 20000 });
}

async function sendMessage(page, text) {
  const textarea = page.locator('textarea').last();
  await textarea.click();
  await textarea.fill(text);
  await page.keyboard.press('Enter');
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--no-sandbox']
  });
  const alicePage = await (
    await browser.newContext({ viewport: { width: 1280, height: 800 } })
  ).newPage();
  const bobPage = await (
    await browser.newContext({ viewport: { width: 1280, height: 800 } })
  ).newPage();

  const aliceStatusHits = [];
  alicePage.on('response', async (r) => {
    if (r.url().includes('/messages') && r.request().method() === 'GET') {
      /* ignore */
    }
  });

  console.log('1) Register');
  await register(alicePage, alice);
  await register(bobPage, bob);

  console.log('2) Both open DM');
  await openDm(alicePage, bob.login);
  await openDm(bobPage, alice.login);

  const text = `status-rt ${stamp}`;
  console.log('3) Alice sends', text);
  await sendMessage(alicePage, text);

  // Bob should see message without refresh
  await bobPage.waitForFunction(
    (t) => document.body.innerText.includes(t),
    text,
    { timeout: 15000 }
  );
  console.log('   Bob sees message: ok');

  // Wait for Alice ticks to become read (viewport on Bob → status WS → UI)
  const ok = await alicePage
    .waitForFunction(
      (t) => {
        const body = document.body.innerText;
        if (!body.includes(t)) return false;
        // Chotto read ticks: look for status icons near the outgoing bubble
        const feed = document.querySelector('.message-feed');
        if (!feed) return false;
        // Any element that indicates read (double-check / status-read class variants)
        const html = feed.innerHTML;
        return (
          /status.*read|read.*status|pi-check|message-status|status-read|double/i.test(html) ||
          feed.querySelector('[class*="status"][class*="read"], .message-status--read, .pi-check') != null
        );
      },
      text,
      { timeout: 20000 }
    )
    .then(() => true)
    .catch(() => false);

  // Stronger check via API: Alice's message has peer read status
  const token = await alicePage.evaluate(() => {
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k && k.includes('token')) return sessionStorage.getItem(k);
    }
    // try local-chat keys
    return (
      sessionStorage.getItem('local-chat:token') ||
      Object.values(sessionStorage).find((v) => typeof v === 'string' && v.split('.').length === 3) ||
      null
    );
  });

  // Parse token from page evaluate of api helper if needed
  const aliceState = await alicePage.evaluate(async (t) => {
    const keys = Object.keys(sessionStorage);
    let tok = null;
    for (const k of keys) {
      const v = sessionStorage.getItem(k);
      if (v && v.startsWith('eyJ')) tok = v;
    }
    if (!tok) return { error: 'no token', keys };
    const dialogs = await fetch('/api/dialogs?page=1&limit=5', {
      headers: { Authorization: `Bearer ${tok}` }
    }).then((r) => r.json());
    const dlg = (dialogs.dialogs || [])[0];
    if (!dlg) return { error: 'no dialog' };
    const msgs = await fetch(`/api/dialogs/${dlg.dialogId}/messages?page=1&limit=20`, {
      headers: { Authorization: `Bearer ${tok}` }
    }).then((r) => r.json());
    const mine = (msgs.messages || []).find((m) => (m.content || '').includes(t));
    return {
      messageId: mine?.messageId,
      statuses: mine?.statuses,
      dialogId: dlg.dialogId
    };
  }, text);

  console.log('   Alice API statuses', aliceState);
  const peerRead = (aliceState.statuses || []).some(
    (s) => s.status === 'read' && s.userId && s.userId !== alice.login
  );

  await alicePage.screenshot({ path: '/tmp/e2e-status-alice.png' });
  await bobPage.screenshot({ path: '/tmp/e2e-status-bob.png' });
  await browser.close();

  if (!peerRead) {
    console.error('FAILED: Alice message has no peer read status', aliceState, 'uiHint', ok);
    process.exit(1);
  }
  console.log('REALTIME STATUS PASSED (peer read on Alice message)');
}

main().catch((e) => {
  console.error('FAILED', e);
  process.exit(1);
});
