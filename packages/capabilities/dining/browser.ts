import type { BrowserContext, Page } from 'playwright-core';

export async function withDiningPage<T>(
  timeZone: string,
  signal: AbortSignal,
  run: (page: Page, context: BrowserContext) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome', headless: true, timeout: 10000 });
  const stop = () => { void browser.close().catch(() => {}); };
  signal.addEventListener('abort', stop, { once: true });
  try {
    signal.throwIfAborted();
    const context = await browser.newContext({
      locale: 'en-US', timezoneId: timeZone, serviceWorkers: 'block', acceptDownloads: false,
    });
    await context.routeWebSocket('**/*', socket => socket.close());
    context.setDefaultTimeout(7000);
    context.setDefaultNavigationTimeout(12000);
    return await run(await context.newPage(), context);
  } finally {
    signal.removeEventListener('abort', stop);
    await browser.close();
  }
}
