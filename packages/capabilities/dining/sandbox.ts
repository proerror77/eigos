import { z } from 'zod';
import type { Page } from 'playwright-core';
import { Conflict, digest } from '../../core/identity.js';
import { diningBookingReceipt, diningReservationTerms } from '../../ontology/dining-reservations.js';
import { withDiningPage } from './browser.js';

export const diningSandboxOrigin = z.url().refine(raw => {
  const url = new URL(raw);
  return url.protocol === 'http:' && url.hostname === '127.0.0.1' && !!url.port && raw === url.origin;
}, 'Use an explicit loopback test merchant origin');

export type DiningTerms = z.infer<typeof diningReservationTerms>;
type Receipt = z.infer<typeof diningBookingReceipt>;
const reservePath = '/reserve';
const receiptSelector = '[data-eigos-dining-receipt="synthetic"]';

async function readReceipt(page: Page, terms: DiningTerms, reference: string, verifiedBy: Receipt['verifiedBy']) {
  const details = await page.locator(receiptSelector).evaluate(element => ({
    bookingId: element.getAttribute('data-booking-id'),
    reference: element.getAttribute('data-reference'),
    restaurant: element.getAttribute('data-restaurant'),
    city: element.getAttribute('data-city'),
    date: element.getAttribute('data-date'),
    time: element.getAttribute('data-time'),
    partySize: Number(element.getAttribute('data-party-size')),
  }));
  const receipt = diningBookingReceipt.parse({
    ...details, verifiedBy, observedAt: new Date().toISOString(), evidence: 'synthetic',
  });
  const { bookingId: _bookingId, reference: actual, verifiedBy: _verifiedBy, observedAt: _observedAt,
    evidence: _evidence, ...actualTerms } = receipt;
  if (actual !== reference || digest(actualTerms) !== digest(terms)) {
    throw new Conflict('The test merchant returned a different reservation');
  }
  return receipt;
}

export function diningSandbox(raw: string, timeZone: string) {
  const origin = diningSandboxOrigin.parse(raw);
  const browse = <T>(path: string, signal: AbortSignal, usePage: (page: Page, admit: (fields: Record<string, string>) => void) => Promise<T>) =>
    withDiningPage(timeZone, signal, async (page, context) => {
      let authorizedFields: Record<string, string> | undefined, sent = false;
      const target = origin + path;
      await context.route('**/*', async route => {
        const request = route.request(), method = request.method();
        if (request.url() !== target || !request.isNavigationRequest()) return route.abort();
        if (method !== 'GET') {
          if (method !== 'POST' || path !== reservePath || !authorizedFields || sent) return route.abort();
          const body = new URLSearchParams(request.postData() ?? '');
          const expected = Object.entries(authorizedFields);
          if (body.size !== expected.length || expected.some(([key, value]) => body.get(key) !== value)) return route.abort();
          sent = true;
        }
        try {
          // Fetch once here so Chrome cannot retry a form POST after losing its response.
          const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 6000 });
          if (response.status() >= 300 && response.status() < 400) return route.abort();
          await route.fulfill({ response });
        } catch {
          await route.abort().catch(() => {});
        }
      });
      return usePage(page, fields => { authorizedFields = fields; });
    });

  return {
    async submit(
      terms: DiningTerms,
      reference: string,
      signal: AbortSignal,
      dispatch: (submitForm: () => Promise<Receipt>) => Promise<Receipt>,
    ) {
      return browse(reservePath, signal, async (page, admit) => {
        const response = await page.goto(origin + reservePath, { waitUntil: 'domcontentloaded' });
        if (!response?.ok()) throw new Conflict('The test merchant form is unavailable');
        const form = page.locator('form[data-eigos-dining="synthetic"][method="post"][action="/reserve"]');
        const fields = Object.fromEntries(Object.entries({ ...terms, reference }).map(([key, value]) => [key, String(value)]));
        for (const [name, value] of Object.entries(fields)) {
          await form.locator(`input[name="${name}"]`).fill(value);
        }
        const button = form.getByRole('button', { name: 'Submit test reservation', exact: true });
        await button.click({ trial: true });
        return dispatch(async () => {
          signal.throwIfAborted();
          admit(fields);
          await button.click();
          return readReceipt(page, terms, reference, 'confirmation-page');
        });
      });
    },
    async lookup(terms: DiningTerms, reference: string, signal: AbortSignal) {
      const path = `/reservations/${diningBookingReceipt.shape.reference.parse(reference)}`;
      return browse(path, signal, async page => {
        const response = await page.goto(origin + path, { waitUntil: 'domcontentloaded' });
        if (response?.status() === 404) return undefined;
        if (!response?.ok()) throw new Conflict('The original test reservation could not be read');
        return readReceipt(page, terms, reference, 'original-order-lookup');
      });
    },
  };
}
