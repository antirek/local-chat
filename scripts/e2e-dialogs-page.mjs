import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5173';
const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const pagesHit = [];
page.on('request', (r) => {
  if (r.url().includes('/api/dialogs') && r.method() === 'GET') pagesHit.push(r.url());
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
await page.waitForTimeout(1500);
let n = await page.locator('.chat-list__item').count();
console.log('after login items', n, 'requests', pagesHit);
if (n > 35) throw new Error('expected ~30 items on first page, got ' + n);

// scroll list to bottom repeatedly to load more
const list = page.locator('.chat-list__items');
for (let i = 0; i < 6; i++) {
  await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(800);
  // nudge to re-trigger scrollCheck
  await list.evaluate((el) => { el.scrollTop = el.scrollHeight - 10; });
  await page.waitForTimeout(400);
  await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(800);
}
n = await page.locator('.chat-list__item').count();
console.log('after scroll items', n, 'requests', pagesHit);
const hasPage2 = pagesHit.some((u) => u.includes('page=2'));
console.log('loaded page2?', hasPage2);
await browser.close();
if (!hasPage2 || n < 50) {
  console.error('FAIL');
  process.exit(1);
}
console.log('PASSED');
