/**
 * Two browser sessions: register, DM, send/receive both ways (realtime).
 */
import { chromium } from 'playwright';

const BASE = process.env.LOCAL_CHAT_URL || 'http://127.0.0.1:5173';
const stamp = Date.now().toString(36);
const alice = { login: `ta_${stamp}`, name: 'Test Alice', password: 'test1234' };
const bob = { login: `tb_${stamp}`, name: 'Test Bob', password: 'test1234' };

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
  await page.waitForSelector('[data-testid="dm-modal"]');
  await page.locator('[data-testid="user-search"]').fill(peerLogin);
  await page.locator(`[data-testid="user-option"][data-login="${peerLogin}"]`).click();
  await page.locator('[data-testid="dm-modal"]').getByRole('button', { name: 'Открыть' }).click();
  await page.waitForSelector('[data-testid="feed-scroll"], .lc-feed, .message-feed', { timeout: 20000 });
}

async function sendMessage(page, text) {
  const textarea = page.locator('textarea').last();
  await textarea.waitFor({ timeout: 10000 });
  await textarea.click();
  await textarea.fill(text);
  await page.keyboard.press('Enter');
}

async function waitForVisibleText(page, text, { timeoutMs = 25000, label } = {}) {
  await page.getByText(text, { exact: false }).first().waitFor({
    state: 'visible',
    timeout: timeoutMs
  }).catch(async () => {
    const visible = await page.locator('body').innerText();
    throw new Error(
      `timeout: ${label || text} not visible. Body snippet: ${visible.slice(0, 400)}`
    );
  });
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--no-sandbox']
  });
  const alicePage = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const bobPage = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();

  for (const [name, page] of [['alice', alicePage], ['bob', bobPage]]) {
    page.on('pageerror', (e) => console.warn(name, 'pageerror', e.message));
    page.on('response', async (r) => {
      if (r.url().includes('/messages') && r.request().method() === 'POST') {
        console.log(`SEND ${name} -> ${r.status()}`);
      }
    });
  }

  console.log('1) Register Alice + Bob');
  await register(alicePage, alice);
  await register(bobPage, bob);
  console.log('   ok', alice.login, bob.login);

  console.log('2) Both open same DM');
  await openDm(alicePage, bob.login);
  await openDm(bobPage, alice.login);
  console.log('   both feeds open');

  const m1 = `hello from alice ${stamp}`;
  console.log('3) Alice sends:', m1);
  await sendMessage(alicePage, m1);
  await waitForVisibleText(alicePage, m1, { label: 'alice own message' });
  await waitForVisibleText(bobPage, m1, { label: 'bob receives alice' });
  console.log('   Bob received Alice: ok');

  const m2 = `reply from bob ${stamp}`;
  console.log('4) Bob sends:', m2);
  await sendMessage(bobPage, m2);
  await waitForVisibleText(bobPage, m2, { label: 'bob own message' });
  await waitForVisibleText(alicePage, m2, { label: 'alice receives bob' });
  console.log('   Alice received Bob: ok');

  const m3 = `alice second ${stamp}`;
  console.log('5) Alice second message (realtime):', m3);
  await sendMessage(alicePage, m3);
  await waitForVisibleText(bobPage, m3, { label: 'bob receives round2' });
  console.log('   Bob received round2: ok');

  await alicePage.screenshot({ path: '/tmp/e2e-alice-session.png', fullPage: true });
  await bobPage.screenshot({ path: '/tmp/e2e-bob-session.png', fullPage: true });
  console.log('   screenshots saved');

  await browser.close();
  console.log('\nTWO-SESSION SEND/RECEIVE PASSED');
  console.log({ alice: alice.login, bob: bob.login, m1, m2, m3 });
}

main().catch((e) => {
  console.error('\nFAILED', e);
  process.exit(1);
});
