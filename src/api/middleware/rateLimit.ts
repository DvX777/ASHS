// src/api/middleware/rateLimit.ts
const windows = new Map<string, number[]>();

export function checkRateLimit(domain: string, limitRpm: number): boolean {
  const now = Date.now();
  const cutoff = now - 60_000;
  let hits = (windows.get(domain) ?? []).filter(t => t > cutoff);
  if (hits.length >= limitRpm) return false;
  hits.push(now);
  windows.set(domain, hits);
  return true;
}

setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [key, hits] of windows) {
    const fresh = hits.filter(t => t > cutoff);
    if (fresh.length === 0) windows.delete(key); else windows.set(key, fresh);
  }
}, 5 * 60_000);
