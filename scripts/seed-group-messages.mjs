/**
 * Seed 100–200 messages into each of sergey's group dialogs (for feed pagination tests).
 *
 *   node scripts/seed-group-messages.mjs
 *   API=http://127.0.0.1:4000 PASSWORD=test1234 MIN=100 MAX=200 node scripts/seed-group-messages.mjs
 */
const API = process.env.API || 'http://127.0.0.1:4000';
const PASSWORD = process.env.PASSWORD || 'test1234';
const SERGEY = (process.env.SERGEY_LOGIN || 'sergey').toLowerCase();
const MIN = Number(process.env.MIN || 100);
const MAX = Number(process.env.MAX || 200);
const CONCURRENCY = Number(process.env.CONCURRENCY || 6);

async function request(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body != null ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${path}`);
  return data;
}

async function mapPool(items, limit, fn) {
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

function randInt(a, b) {
  return a + Math.floor(Math.random() * (b - a + 1));
}

async function main() {
  const auth = await request('/api/auth/login', {
    method: 'POST',
    body: { login: SERGEY, password: PASSWORD }
  });
  const token = auth.token;

  // Pull all dialog pages
  const groups = [];
  let page = 1;
  let pages = 1;
  while (page <= pages) {
    const data = await request(`/api/dialogs?page=${page}&limit=100`, { token });
    pages = data.pagination?.pages || 1;
    for (const d of data.dialogs || []) {
      if (d.meta?.type === 'group') groups.push(d);
    }
    page++;
  }

  console.log(`Found ${groups.length} groups for ${SERGEY}`);
  if (!groups.length) {
    console.log('Nothing to seed');
    return;
  }

  for (const g of groups) {
    const title = g.meta?.title || g.dialogId;
    const count = randInt(MIN, MAX);
    console.log(`Seeding ${count} messages → ${title} (${g.dialogId})`);

    // Prefer posting as sergey (always a member); mix content.
    const jobs = Array.from({ length: count }, (_, i) => i + 1);
    await mapPool(jobs, CONCURRENCY, async (n) => {
      await request(`/api/dialogs/${g.dialogId}/messages`, {
        method: 'POST',
        token,
        body: { content: `[${title}] msg #${n}/${count} — seed ${Date.now().toString(36)}` }
      });
    });
    console.log(`  done ${title}`);
  }

  console.log('SEED GROUP MESSAGES DONE');
}

main().catch((e) => {
  console.error('FAILED', e.message || e);
  process.exit(1);
});
