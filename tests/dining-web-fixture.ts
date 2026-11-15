import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { diningReservationTerms, diningBookingReceipt } from '../packages/ontology/dining-reservations.js';
import type { DiningTerms } from '../packages/capabilities/dining/sandbox.js';

const form = '<form data-eigos-dining="synthetic" action="/reserve" method="post">' +
  ['restaurant', 'city', 'date', 'partySize', 'time', 'reference'].map(name => `<input name="${name}">`).join('') +
  '<button type="submit">Submit test reservation</button></form>';
const escape = (value: unknown) => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const html = (res: ServerResponse, status: number, body: string) =>
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html>' + body);
type Order = DiningTerms & { reference: string; bookingId: string };

export async function startDiningTestMerchant() {
  const orders: Order[] = [], lookups: string[] = [];
  const flags = { formUnavailable: false, loseReply: true, hideOrder: false, mismatched: false };
  let submissions = 0, lostReplies = 0;
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/reserve') return flags.formUnavailable
      ? html(res, 503, 'The test form is unavailable') : html(res, 200, form);
    if (req.method === 'POST' && req.url === '/reserve') {
      submissions++;
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 2000) return html(res, 413, 'Too large');
      }
      const decoded = Object.fromEntries(new URLSearchParams(body));
      const parsed = diningReservationTerms.safeParse({
        restaurant: decoded.restaurant, city: decoded.city, date: decoded.date, time: decoded.time,
        partySize: Number(decoded.partySize),
      });
      const reference = diningBookingReceipt.shape.reference.safeParse(decoded.reference);
      if (!parsed.success || !reference.success) return html(res, 400, 'Invalid test request');
      // Every accepted POST creates a new row. The EIGOS test must prove that it sent exactly one.
      const order = { ...parsed.data, reference: reference.data, bookingId: 'test-' + randomUUID() };
      orders.push(order);
      if (flags.loseReply) { lostReplies++; res.destroy(); return; }
      return html(res, 201, receipt(order));
    }
    if (req.method === 'GET' && req.url?.startsWith('/reservations/')) {
      const reference = req.url.slice('/reservations/'.length);
      lookups.push(reference);
      const order = orders.find(row => row.reference === reference);
      if (!order || flags.hideOrder) return html(res, 404, 'No matching reservation is visible yet');
      return html(res, 200, receipt(flags.mismatched ? { ...order, partySize: order.partySize + 1 } : order));
    }
    return html(res, 404, 'Unknown test route');
  });
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${port}`, orders, lookups, flags,
    get submissions() { return submissions; },
    get lostReplies() { return lostReplies; },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

function receipt(order: Order) {
  return `<main data-eigos-dining-receipt="synthetic" data-booking-id="${escape(order.bookingId)}"` +
    ` data-reference="${escape(order.reference)}" data-restaurant="${escape(order.restaurant)}"` +
    ` data-city="${escape(order.city)}" data-date="${escape(order.date)}" data-time="${escape(order.time)}"` +
    ` data-party-size="${order.partySize}">Test reservation confirmed</main>`;
}
