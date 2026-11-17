import type { RequestHandler } from 'express';

/**
 * Fixed-window request limit per client address. The address is `req.ip`, so behind a reverse proxy the app needs a
 * matching `trust proxy` setting. Counts live in this process only. `maxKeys` bounds the memory: when the table is
 * full, windows that have ended are dropped first, then the oldest one.
 */
export function rateLimit(options: { windowMs: number; max: number; maxKeys?: number }): RequestHandler {
  const { windowMs, max, maxKeys = 10_000 } = options;
  // A Map iterates in insertion order. A window is inserted when it starts and every window lasts the same time,
  // so the order is also the order in which windows end.
  const windows = new Map<string, { start: number; count: number }>();
  return (req, res, next) => {
    const now = Date.now(), client = req.ip ?? '';
    let current = windows.get(client);
    if (current && current.start + windowMs <= now) { windows.delete(client); current = undefined; }
    if (!current) {
      if (windows.size >= maxKeys) {
        for (const [key, entry] of windows) { if (entry.start + windowMs > now) break; windows.delete(key); }
        const oldest = windows.keys().next();
        if (windows.size >= maxKeys && !oldest.done) windows.delete(oldest.value);
      }
      current = { start: now, count: 0 };
      windows.set(client, current);
    }
    if (current.count >= max) {
      res.set('Retry-After', String(Math.ceil((current.start + windowMs - now) / 1000)));
      res.status(429).type('text').send('请求过于频繁，请稍后再试。');
      return;
    }
    current.count++;
    next();
  };
}
