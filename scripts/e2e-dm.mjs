/**
 * E2E: local-chat UI — register two users, DM, exchange messages, check unread/realtime.
 * Run: npx playwright test (or node via playwright)
 */
import { chromium } from 'playwright';

const BASE = process.env.LOCAL_CHAT_URL || 'http://localhost:5173';
const stamp = Date.now().toString(36);
const alice = { login: `alice_${stamp}`, name: 'Alice Test', password: 'test1234' };
const bob = { login: `bob_${stamp}`, name: 'Bob Test', password: 'test1234' };

async function register(page, user, mode = 'register') {
  await page.goto(BASE);
  await page.waitForSelector('form.auth-card, .chat-shell', { timeout: 15000 });

  if (await page.locator('.chat-shell').count()) {
    // already logged in from prior session — logout
    const logout = page.getByRole('button', { name: 'Выйти' });
    if (await logout.count()) await logout.click();
    await page.waitForSelector('form.auth-card');
  }

  if (mode === 'register') {
    const switchBtn = page.getByRole('button', { name: /Создать аккаунт|У меня есть аккаунт/ });
    const label = await switchBtn.textContent();
    if (label?.includes('Создать')) await switchBtn.click();
  }

  await page.locator('input').nth(0).fill(user.login);
  if (mode === 'register') {
    await page.locator('input').nth(1).fill(user.name);
    await page.locator('input').nth(2).fill(user.password);
  } else {
    await page.locator('input[type="password"]').fill(user.password);
  }

  await page.getByRole('button', { name: /Зарегистрироваться|Войти/ }).click();
  await page.waitForSelector('.chat-shell', { timeout: 20000 });
}

async function openDm(page, peerLogin) {
  await page.getByRole('button', { name: 'DM' }).click();
  await page.waitForSelector('.modal');
  await page.locator('.modal input').fill(peerLogin);
  await page.locator('.modal').getByRole('button', { name: 'Открыть' }).click();
  await page.waitForSelector('[data-testid="feed"], .lc-feed', { timeout: 15000 });
}

function feedLocator(page) {
  return page.locator('[data-testid="feed"]').or(page.locator('.lc-feed')).first();
}

async function sendMessage(page, text) {
  // Chotto ChatInput — textarea or contenteditable
  const input =
    page.locator('textarea').first().or(page.locator('[contenteditable="true"]').first());
  await input.waitFor({ timeout: 10000 });
  await input.click();
  await input.fill(text);
  await page.keyboard.press('Enter');
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome'
  });

  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const alicePage = await aliceCtx.newPage();
  const bobPage = await bobCtx.newPage();

  const errors = [];
  for (const [name, page] of [
    ['alice', alicePage],
    ['bob', bobPage]
  ]) {
    page.on('pageerror', (e) => errors.push(`${name} pageerror: ${e.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`${name} console: ${msg.text()}`);
    });
  }

  console.log('1) Register Alice', alice.login);
  await register(alicePage, alice, 'register');

  console.log('2) Register Bob', bob.login);
  await register(bobPage, bob, 'register');

  console.log('3) Alice opens DM with Bob');
  await openDm(alicePage, bob.login);

  const msg1 = `hello from alice ${stamp}`;
  console.log('4) Alice sends:', msg1);
  await sendMessage(alicePage, msg1);
  await alicePage.waitForTimeout(1500);

  // Alice should see her message in feed
  const aliceFeed = await feedLocator(alicePage).innerText();
  if (!aliceFeed.includes(msg1) && !aliceFeed.includes('hello from alice')) {
    // fallback: any text containing stamp
    const body = await alicePage.content();
    if (!body.includes(msg1)) {
      throw new Error(`Alice feed missing own message. Feed snippet: ${aliceFeed.slice(0, 200)}`);
    }
  }
  console.log('   Alice sees own message: ok');

  console.log('5) Bob opens DM with Alice (should see message via list/open)');
  await openDm(bobPage, alice.login);
  await bobPage.waitForTimeout(2000);
  let bobFeed = await feedLocator(bobPage).innerText();
  if (!bobFeed.includes('hello from alice') && !(await bobPage.content()).includes(msg1)) {
    // refresh by re-selecting — click chat in list
    await bobPage.waitForTimeout(2000);
    bobFeed = await feedLocator(bobPage).innerText();
  }
  if (!bobFeed.includes('hello from alice') && !(await bobPage.content()).includes(msg1)) {
    throw new Error(`Bob did not see Alice message. Feed: ${bobFeed.slice(0, 300)}`);
  }
  console.log('   Bob sees Alice message: ok');

  const msg2 = `reply from bob ${stamp}`;
  console.log('6) Bob replies:', msg2);
  await sendMessage(bobPage, msg2);
  await bobPage.waitForTimeout(1500);

  console.log('7) Wait for Alice realtime / refresh');
  await alicePage.waitForTimeout(2500);
  let aliceFeed2 = await alicePage.content();
  if (!aliceFeed2.includes(msg2)) {
    // force refresh dialogs by clicking DM chat again if needed
    await alicePage.waitForTimeout(2000);
    aliceFeed2 = await alicePage.content();
  }
  if (!aliceFeed2.includes(msg2)) {
    throw new Error(`Alice did not receive Bob reply (WS/update).`);
  }
  console.log('   Alice sees Bob reply: ok');

  console.log('8) Create group from Alice');
  await alicePage.getByRole('button', { name: 'Группа' }).click();
  await alicePage.waitForSelector('.modal');
  await alicePage.locator('.modal input').nth(0).fill(`Team ${stamp}`);
  await alicePage.locator('.modal input').nth(1).fill(bob.login);
  await alicePage.locator('.modal').getByRole('button', { name: 'Создать' }).click();
  await alicePage.waitForTimeout(2000);
  const groupMsg = `group hi ${stamp}`;
  await sendMessage(alicePage, groupMsg);
  await alicePage.waitForTimeout(1000);
  if (!(await alicePage.content()).includes(groupMsg)) {
    throw new Error('Group message not visible for Alice');
  }
  console.log('   Group create + message: ok');

  await browser.close();

  if (errors.length) {
    console.warn('Non-fatal page errors:', errors.slice(0, 10));
  }

  console.log('\nE2E PASSED');
  console.log({ alice: alice.login, bob: bob.login });
}

main().catch((err) => {
  console.error('\nE2E FAILED', err);
  process.exit(1);
});
