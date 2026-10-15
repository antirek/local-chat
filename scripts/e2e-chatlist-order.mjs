import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5173';

async function login(page) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (await page.locator('.chat-shell').count()) {
    await page.getByRole('button', { name: 'Выйти' }).click();
    await page.waitForSelector('form.auth-card');
  }
  const switchBtn = page.getByRole('button', { name: /Создать аккаунт|У меня есть аккаунт/ });
  if ((await switchBtn.textContent())?.includes('У меня есть')) await switchBtn.click();
  await page.locator('input').nth(0).fill('sergey');
  await page.locator('input[type="password"]').fill('test1234');
  await page.getByRole('button', { name: /Войти/ }).click();
  await page.waitForSelector('.chat-list__item');
  await page.waitForTimeout(1500);
}

async function names(page) {
  return page.locator('.chat-list__item .chat-item__name').allTextContents();
}

const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

// Capture dialog API response order on refresh
const dialogSnapshots = [];
page.on('response', async (r) => {
  if (r.url().includes('/api/dialogs') && r.request().method() === 'GET') {
    const data = await r.json().catch(() => null);
    if (data?.dialogs) {
      dialogSnapshots.push(data.dialogs.slice(0, 15).map(d => ({
        id: d.dialogId,
        type: d.meta?.type,
        title: d.meta?.title || d.meta?.dmKey,
        last: d.lastMessage?.createdAt,
        created: d.createdAt,
        unread: d.unreadCount
      })));
    }
  }
});

await login(page);
const before = await names(page);
console.log('before first10', before.slice(0, 10));

// click a chat with messages near top but not first - Team 001 is index 1
const clickName = 'Team 008 (5)';
const idx = before.indexOf(clickName);
console.log('click', clickName, 'at', idx);
await page.locator('.chat-list__item').filter({ hasText: clickName }).first().click();
await page.waitForTimeout(3000);

const after = await names(page);
console.log('after first10', after.slice(0, 10));
console.log('newIdx', after.indexOf(clickName));
console.log('dialogSnapshots', dialogSnapshots.length);
dialogSnapshots.forEach((s, i) => console.log('snap', i, JSON.stringify(s.slice(0,8))));

// scroll list and click deep empty chat
await page.locator('.chat-list__items').evaluate(el => { el.scrollTop = el.scrollHeight; });
await page.waitForTimeout(500);
const deep = await names(page);
const deepName = deep[deep.length - 5];
console.log('click deep', deepName, 'at', deep.indexOf(deepName));
await page.locator('.chat-list__item').filter({ hasText: deepName }).first().click();
await page.waitForTimeout(3000);
const afterDeep = await names(page);
console.log('after deep first10', afterDeep.slice(0, 10));
console.log('deep newIdx', afterDeep.indexOf(deepName), 'jumped?', afterDeep[0] === deepName);

// check scroll position
const scroll = await page.locator('.chat-list__items').evaluate(el => ({ top: el.scrollTop, h: el.scrollHeight }));
console.log('scroll', scroll);

await browser.close();
