const PALETTE = [
  '#0f766e',
  '#0369a1',
  '#1d4ed8',
  '#b45309',
  '#be123c',
  '#4338ca',
  '#047857',
  '#0e7490'
];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function initialsAvatar(seed: string, label?: string): string {
  const name = (label || seed || '?').trim();
  const parts = name.split(/[\s._-]+/).filter(Boolean);
  const letters = (
    parts.length >= 2 ? parts[0][0] + parts[1][0] : name.slice(0, 2)
  ).toUpperCase();
  const bg = PALETTE[hash(seed || name) % PALETTE.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="32" fill="${bg}"/>
  <text x="32" y="34" text-anchor="middle" dominant-baseline="middle"
    font-family="system-ui,Segoe UI,sans-serif" font-size="22" font-weight="600" fill="#fff">${letters}</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function toUnixSeconds(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return Math.floor(Date.now() / 1000);
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

export function formatClock(tsSec: number): string {
  return new Date(tsSec * 1000).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit'
  });
}
