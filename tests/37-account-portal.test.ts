import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { rateLimit } from '../apps/gateway/rate-limit.js';
import { seal, unseal } from '../apps/gateway/sealed-cookie.js';

test('sealed cookies reject tampering, other purposes and expiry', () => {
  const secret = 's'.repeat(32), schema = z.strictObject({ state: z.string() });
  const sealed = seal(secret, 'login', { state: 'abc' }, 300_000, 1_000);
  assert.deepEqual(unseal(secret, 'login', sealed, schema, 2_000), { state: 'abc' });
  assert.equal(unseal(secret, 'link', sealed, schema, 2_000), undefined);
  assert.equal(unseal('t'.repeat(32), 'login', sealed, schema, 2_000), undefined);
  assert.equal(unseal(secret, 'login', sealed, schema, 301_001), undefined);
  const flipped = sealed.slice(0, 20) + (sealed[20] === 'A' ? 'B' : 'A') + sealed.slice(21);
  assert.equal(unseal(secret, 'login', flipped, schema, 2_000), undefined);
  assert.equal(unseal(secret, 'login', 'not-a-cookie', schema, 2_000), undefined);
});

test('sealed cookies follow the documented key derivation and AES-256-GCM layout', () => {
  const secret = 's'.repeat(32), schema = z.strictObject({ state: z.string() });
  const key = Buffer.from(hkdfSync('sha256', secret, 'eigos-sealed-cookie', 'login', 32));
  const sealed = seal(secret, 'login', { state: 'abc' }, 300_000, 1_000);
  const bytes = Buffer.from(sealed, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from('login'));
  decipher.setAuthTag(bytes.subarray(-16));
  const plain = Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
  assert.deepEqual(JSON.parse(plain.toString('utf8')), { v: { state: 'abc' }, exp: 301_000 });
  assert.notEqual(seal(secret, 'login', { state: 'abc' }, 300_000, 1_000), sealed, 'each seal uses a fresh IV');

  const handmade = (aad?: string) => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    if (aad !== undefined) cipher.setAAD(Buffer.from(aad));
    const body = Buffer.concat([cipher.update(JSON.stringify({ v: { state: 'xyz' }, exp: 9_000 })), cipher.final()]);
    return Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url');
  };
  assert.deepEqual(unseal(secret, 'login', handmade('login'), schema, 2_000), { state: 'xyz' });
  assert.equal(unseal(secret, 'login', handmade(), schema, 2_000), undefined, 'the purpose is authenticated data too');
  assert.equal(unseal(secret, 'login', handmade('link'), schema, 2_000), undefined);
});

test('unseal returns undefined for malformed or non-canonical input instead of throwing', () => {
  const secret = 's'.repeat(32), schema = z.strictObject({ state: z.string() });
  const sealed = seal(secret, 'login', { state: 'abc' }, 300_000, 1_000);
  const inputs = [
    '', 'not-a-cookie', 'A'.repeat(5_000), undefined as unknown as string,
    sealed.slice(0, -4), sealed + 'AAAA',
    sealed + '!!', sealed + '=', sealed + ' ', sealed.slice(0, 10) + '.' + sealed.slice(10),
    Buffer.from(sealed, 'base64url').toString('base64'),
    randomBytes(20).toString('base64url'), randomBytes(28).toString('base64url'), randomBytes(60).toString('base64url'),
  ];
  for (const input of inputs) assert.equal(unseal(secret, 'login', input, schema, 2_000), undefined, String(input).slice(0, 40));

  // Node decodes base64url leniently: the spare bits of the last character are ignored. A cookie
  // has exactly one valid spelling, so a sibling that decodes to the same bytes is rejected.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  assert.notEqual(sealed.length % 4, 0, 'the last character carries spare bits');
  const sibling = sealed.slice(0, -1) + alphabet.charAt(alphabet.indexOf(sealed.slice(-1)) ^ 1);
  assert.ok(Buffer.from(sibling, 'base64url').equals(Buffer.from(sealed, 'base64url')));
  assert.equal(unseal(secret, 'login', sibling, schema, 2_000), undefined);
  assert.deepEqual(unseal(secret, 'login', sealed, schema, 2_000), { state: 'abc' });
});

test('unseal rejects cookies longer than 4096 characters even when they are authentic', () => {
  const secret = 's'.repeat(32), schema = z.strictObject({ state: z.string() });
  // 3072 bytes of IV, ciphertext and tag are exactly 4096 base64url characters.
  const fill = 3072 - 12 - 16 - JSON.stringify({ v: { state: '' }, exp: 301_000 }).length;
  const exact = seal(secret, 'login', { state: 'x'.repeat(fill) }, 300_000, 1_000);
  assert.equal(exact.length, 4096);
  assert.deepEqual(unseal(secret, 'login', exact, schema, 2_000), { state: 'x'.repeat(fill) });
  const over = seal(secret, 'login', { state: 'x'.repeat(fill + 1) }, 300_000, 1_000);
  assert.equal(over.length, 4098);
  assert.equal(unseal(secret, 'login', over, schema, 2_000), undefined);
});

test('unseal accepts a value only before it expires and only in the shape of its schema', () => {
  const secret = 's'.repeat(32), schema = z.strictObject({ state: z.string() });
  const sealed = seal(secret, 'login', { state: 'abc' }, 300_000, 1_000);
  assert.deepEqual(unseal(secret, 'login', sealed, schema, 300_999), { state: 'abc' });
  assert.equal(unseal(secret, 'login', sealed, schema, 301_000), undefined, 'expired at its exp instant');
  assert.equal(unseal(secret, 'login', sealed, z.strictObject({ state: z.number() }), 2_000), undefined);
  assert.equal(unseal(secret, 'login', seal(secret, 'login', { state: 'abc', extra: 1 }, 300_000, 1_000), schema, 2_000), undefined);
  assert.equal(unseal(secret, 'login', seal(secret, 'login', 'abc', 300_000, 1_000), schema, 2_000), undefined);
  // Without an explicit time both functions use the current time.
  assert.deepEqual(unseal(secret, 'login', seal(secret, 'login', { state: 'now' }, 60_000), schema), { state: 'now' });
  assert.equal(unseal(secret, 'login', seal(secret, 'login', { state: 'now' }, -1), schema), undefined);
});

async function serveLimited(t: TestContext, options: Parameters<typeof rateLimit>[0]) {
  const app = express();
  app.set('trust proxy', 'loopback');
  app.get('/limited', rateLimit(options), (_req, res) => res.send('ok'));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  await new Promise<void>(resolve => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return async (ip: string) => {
    const response = await fetch(`http://127.0.0.1:${port}/limited`, { headers: { 'X-Forwarded-For': ip } });
    return { status: response.status, retryAfter: response.headers.get('retry-after'),
      type: response.headers.get('content-type') ?? '', body: await response.text() };
  };
}

test('rate limit counts each client address separately behind a trusted proxy', async () => {
  const app = express();
  app.set('trust proxy', 'loopback');
  app.get('/limited', rateLimit({ windowMs: 60_000, max: 2 }), (_req, res) => res.send('ok'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const from = (ip: string) => fetch(`http://127.0.0.1:${port}/limited`, { headers: { 'X-Forwarded-For': ip } });
  try {
    assert.deepEqual([(await from('198.51.100.1')).status, (await from('198.51.100.1')).status], [200, 200]);
    const limited = await from('198.51.100.1');
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal((await from('198.51.100.2')).status, 200);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('rate limit reports the seconds left in the window and starts a fresh window after it', async t => {
  let clock = 1_000_000;
  t.mock.method(Date, 'now', () => clock);
  const from = await serveLimited(t, { windowMs: 60_000, max: 1 });
  assert.equal((await from('198.51.100.1')).status, 200);
  clock += 20_500;
  const limited = await from('198.51.100.1');
  assert.equal(limited.status, 429);
  assert.equal(limited.retryAfter, '40', '39.5 seconds left, rounded up');
  assert.match(limited.type, /^text\/plain/);
  assert.equal(limited.body, '请求过于频繁，请稍后再试。');
  clock += 39_499;
  assert.equal((await from('198.51.100.1')).retryAfter, '1');
  clock += 1;
  assert.equal((await from('198.51.100.1')).status, 200);
  assert.equal((await from('198.51.100.1')).status, 429);
});

test('rate limit bounds its table: expired windows go first, then the oldest address', async t => {
  let clock = 0;
  t.mock.method(Date, 'now', () => clock);
  const from = await serveLimited(t, { windowMs: 1_000, max: 1, maxKeys: 2 });
  const status = async (ip: string) => (await from(ip)).status;
  assert.equal(await status('198.51.100.1'), 200);
  clock = 600;
  assert.equal(await status('198.51.100.2'), 200);
  // The table is full. The window of .1 is over, so .3 takes its place and .2 keeps its count.
  clock = 1_100;
  assert.equal(await status('198.51.100.3'), 200);
  assert.equal(await status('198.51.100.2'), 429);
  // Still full and nothing has expired: .4 pushes out the oldest address, .2.
  assert.equal(await status('198.51.100.4'), 200);
  assert.equal(await status('198.51.100.3'), 429);
  assert.equal(await status('198.51.100.2'), 200, '.2 was forgotten and starts a fresh window');
});

test('rate limit remembers 10 000 addresses by default', () => {
  const limit = rateLimit({ windowMs: 60_000, max: 1 });
  // Ten thousand real requests would take seconds, so call the middleware directly. Only `next` matters: a
  // limited request is answered through calls on the response, and any chain of them is accepted here.
  const response: Response = new Proxy({}, { get: () => () => response }) as Response;
  const allowed = (index: number) => {
    let passed = false;
    limit({ ip: `10.0.${index >> 8}.${index & 255}` } as Request, response, () => { passed = true; });
    return passed;
  };
  assert.equal(allowed(0), true);
  assert.equal(allowed(0), false);
  for (let index = 1; index < 10_000; index++) assert.equal(allowed(index), true);
  assert.equal(allowed(0), false, 'all 10 000 addresses are still remembered');
  assert.equal(allowed(10_000), true, 'the 10 001st pushes out the oldest');
  assert.equal(allowed(10_000), false);
  assert.equal(allowed(0), true, 'the oldest address was forgotten');
});
