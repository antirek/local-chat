import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5173';
const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const hits = [];
page.on('request', (r) => {
  if (r.url().includes('/messages?') && r.method() === 'GET') hits.push(r.url());
});

await page.goto(BASE);
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
await page.waitForTimeout(1000);

// open first group in list (test group should be near top after seed)
await page.locator('.chat-list__item').filter({ hasText: /Team|test group|546/ }).first().click();
await page.waitForTimeout(2000);
console.log('after open hits', hits);
const page1 = hits.filter((u) => u.includes('page=1'));
if (!page1.length) throw new Error('no page=1 messages request');

const feed = page.locator('.message-feed');
await feed.waitFor({ timeout: 10000 });
// scroll toward top to load older
for (let i = 0; i < 8; i++) {
  await feed.evaluate((el) => { el.scrollTop = 0; });
  await page.waitForTimeout(500);
  await feed.evaluate((el) => { el.scrollTop = 40; });
  await page.waitForTimeout(300);
  await feed.evaluate((el) => { el.scrollTop = 0; });
  await page.waitForTimeout(700);
}
console.log('after scroll hits', hits);
const hasPage2 = hits.some((u) => u.includes('page=2'));
console.log('loaded page2?', hasPage2);
await browser.close();
if (!hasPage2) process.exit(1);
console.log('PASSED');
