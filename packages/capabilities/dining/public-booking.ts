import type { Page } from 'playwright-core';
import type { z } from 'zod';
import { Conflict } from '../../core/identity.js';
import type { diningWebQuery } from '../../ontology/dining-reservations.js';
import { withDiningPage } from './browser.js';

const portal = 'https://www.sevenrooms.com';
const bookingLink = /book|reserv|訂位|訂座|预订|订位/i;
const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function portalPage(url: URL) {
  if (url.origin !== portal || url.username || url.password) return;
  const slug = url.pathname.match(/^\/reservations\/([\w-]+)\/?$/)?.[1] ??
    url.pathname.match(/^\/explore\/([\w-]+)\/reservations(?:\/create\/search)?\/?$/)?.[1];
  // The platform resolves its public legacy reservation links to this search page.
  if (slug) return new URL(`/explore/${slug}/reservations/create/search`, portal);
}

async function discover(page: Page, official: URL) {
  const queue = [official], visited = new Set<string>();
  for (let i = 0; i < 3 && queue.length; i++) {
    const next = queue.shift()!;
    visited.add(next.href);
    const response = await page.goto(next.href, { waitUntil: 'domcontentloaded' });
    if (!response?.ok() || page.url() !== next.href) throw new Conflict('The verified restaurant site is unavailable');
    const links = await page.locator('a[href]').evaluateAll(nodes => nodes.slice(0, 250).map(node => ({
      href: (node as HTMLAnchorElement).href, label: node.textContent?.trim() ?? '',
    })));
    const found = new Map<string, URL>();
    for (const { href, label } of links) {
      const link = new URL(href, next);
      const booking = portalPage(link);
      if (booking) found.set(booking.href, booking);
      else if (link.origin === official.origin && bookingLink.test(label + link.pathname) && !link.username && !link.password) {
        link.search = ''; link.hash = '';
        if (!visited.has(link.href) && !queue.some(item => item.href === link.href)) queue.push(link);
      }
    }
    if (found.size === 1) return { officialPage: next.href, page: [...found.values()][0]! };
    if (found.size > 1) throw new Conflict('The official page contains more than one booking venue');
  }
  throw new Conflict('No supported booking entry was found on the official site');
}

export async function checkPublicDiningPage(
  officialPage: string,
  timeZone: string,
  query: z.infer<typeof diningWebQuery>,
  signal: AbortSignal,
) {
  const official = new URL(officialPage);
  if (official.protocol !== 'https:' || official.port || official.username || official.password || official.search || official.hash)
    throw new Conflict('Configure a canonical HTTPS restaurant website');
  return withDiningPage(timeZone, signal, async (page, context) => {
    await context.route('**/*', async route => {
      const request = route.request(), origin = new URL(request.url()).origin;
      const officialDocument = origin === official.origin && request.resourceType() === 'document';
      const portalContent = origin === portal && !['font', 'image', 'media'].includes(request.resourceType());
      if ((!officialDocument && !portalContent) || !['GET', 'HEAD'].includes(request.method())) return route.abort();
      try {
        const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 9000 });
        if (response.status() >= 300 && response.status() < 400) return route.abort();
        await route.fulfill({ response });
      } catch {
        await route.abort().catch(() => {});
      }
    });
    const entry = await discover(page, official);
    entry.page.searchParams.set('date', query.date);
    entry.page.searchParams.set('party_size', String(query.partySize));
    const response = await page.goto(entry.page.href, { waitUntil: 'domcontentloaded' });
    if (!response?.ok()) throw new Conflict('The booking page is unavailable');
    const name = await page.locator('[data-test="venue-information-name"]').innerText();
    const address = await page.locator('[data-test="venue-information-address"]').innerText();
    if (normalize(name) !== normalize(query.restaurant) || !normalize(address).includes(normalize(query.city)))
      throw new Conflict('The booking page refers to a different venue');

    const guests = page.getByRole('button', { name: /^Guests/ });
    const count = query.partySize + (query.partySize === 1 ? ' Guest' : ' Guests');
    const expectedGuests = normalize('Guests ' + count);
    const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(query.date));
    if (normalize(await guests.innerText()) !== expectedGuests ||
        new URL(page.url()).searchParams.get('date') !== query.date ||
        !normalize(await page.getByRole('button', { name: /^Date/ }).innerText()).endsWith(normalize(day))) {
      throw new Conflict('The booking site did not apply the requested date and number of guests');
    }

    const slots = page.locator('[data-test="reservation-availability-grid-primary"] [data-test="time-slot-label"]:visible');
    const empty = page.locator('[data-test="reservation-availability-grid-primary-text"]:visible');
    await slots.or(empty).first().waitFor();
    const times = await slots.evaluateAll(nodes => nodes.flatMap(node => {
      const control = node.closest('button, a[href], [role="button"]');
      const label = node.textContent?.trim() ?? '';
      return control && !control.matches(':disabled, [aria-disabled="true"]') && /^([01]\d|2[0-3]):[0-5]\d$/.test(label)
        ? [label] : [];
    }));
    if (!times.length && !/no availability that meets your search criteria|we are closed on/i.test((await empty.allTextContents()).join(' ')))
      throw new Conflict('The page did not provide a recognizable availability result');
    return { officialPage: entry.officialPage, bookingPage: page.url(), availableTimes: [...new Set(times)].sort() };
  });
}
