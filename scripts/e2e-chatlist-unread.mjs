import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5173';
const API = 'http://127.0.0.1:4000';

async function api(path, { method='GET', token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

async function loginPage(page, login, password='test1234') {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  if (await page.locator('.chat-shell').count()) {
    await page.getByRole('button', { name: 'Выйти' }).click();
    await page.waitForSelector('form.auth-card');
  }
  const switchBtn = page.getByRole('button', { name: /Создать аккаунт|У меня есть аккаунт/ });
  if ((await switchBtn.textContent())?.includes('У меня есть')) await switchBtn.click();
  await page.locator('input').nth(0).fill(login);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: /Войти/ }).click();
  await page.waitForSelector('.chat-list__item', { timeout: 20000 });
  await page.waitForTimeout(1000);
}

async function names(page) {
  return page.locator('.chat-list__item .chat-item__name').allTextContents();
}

async function unreadFlags(page) {
  return page.evaluate(() => [...document.querySelectorAll('.chat-list__item')].map(el => ({
    name: el.querySelector('.chat-item__name')?.textContent?.trim(),
    unread: (el.querySelector('.chat-item__status-unread-container')?.textContent || '').trim(),
    hasBadge: !!(el.querySelector('.chat-item__status-unread-container')?.textContent?.trim())
  })));
}

// Create unread for sergey from u050 and u051
const u50 = await api('/api/auth/login', { method:'POST', body:{ login:'u050', password:'test1234' } });
const u51 = await api('/api/auth/login', { method:'POST', body:{ login:'u051', password:'test1234' } });
const dm50 = await api('/api/dm', { method:'POST', token:u50.token, body:{ peerLogin:'sergey' } });
const dm51 = await api('/api/dm', { method:'POST', token:u51.token, body:{ peerLogin:'sergey' } });
const stamp = Date.now().toString(36);
await api(`/api/dialogs/${dm50.dialog.dialogId}/messages`, { method:'POST', token:u50.token, body:{ content:`unread from u050 ${stamp}` } });
await api(`/api/dialogs/${dm51.dialog.dialogId}/messages`, { method:'POST', token:u51.token, body:{ content:`unread from u051 ${stamp}` } });
console.log('seeded unread from u050, u051');

// wait for counters
await new Promise(r => setTimeout(r, 2500));

const browser = await chromium.launch({ headless:true, channel:'chrome', args:['--no-sandbox'] });
const page = await browser.newPage({ viewport:{ width:1400, height:900 } });
await loginPage(page, 'sergey');

const list = await unreadFlags(page);
console.log('top10', list.slice(0,10));
const topNames = list.slice(0,5).map(x => x.name);
const unreadOnTop = topNames.includes('u050') && topNames.includes('u051');
console.log('unread on top?', unreadOnTop, topNames);

// click a read chat mid-list that is not unread
const readIdx = list.findIndex(x => !x.hasBadge && x.name && !['u050','u051'].includes(x.name));
const readName = list[readIdx].name;
console.log('click read chat', readName, 'at', readIdx);
await page.locator('.chat-list__item').nth(readIdx).click();
await page.waitForTimeout(2500);
const after = await names(page);
console.log('after click first5', after.slice(0,5));
const jumped = after[0] === readName && readIdx > 2;
console.log(jumped ? 'FAIL jumped to top' : 'OK did not jump over unread');

// unread still above selected if selected was read
const stillUnreadTop = after.slice(0,5).includes('u050') || after.slice(0,5).includes('u051');
console.log('unread still near top after selecting read?', stillUnreadTop);

await browser.close();
if (!unreadOnTop || jumped) process.exit(1);
console.log('\nPASSED');
