import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AlipayRehearsalLedger, prepareTaobaoShopping, prepareAlipayRehearsal, checkAlipayWallet } from '../packages/pa/alipay-agent-pay.js';
import { fixtureRead, fixtureAuthority, fixtureOrder, SyntheticAlipay, readTaobaoCatalogThroughEigos } from './fixtures/taobao-pa-rehearsal.js';

test('Taobao source prices stop at a PA draft; only full synthetic order terms prepare the Alipay contract', () => {
  const authority = fixtureAuthority(), read = fixtureRead(), order = fixtureOrder(authority), session = randomUUID();
  const draft = prepareTaobaoShopping(read, authority);
  assert.equal(draft.status, 'awaiting_order_material'); assert(draft.missing.includes('final_total'));
  const { preparation, command } = prepareAlipayRehearsal(read, authority, order, session);
  assert.equal(preparation.amount.minor, '3490'); // Reference price was 2990, not the final total.
  assert.equal(preparation.dispatchAllowed, false); assert.equal(preparation.realPaymentSubmitted, false);
  assert(command.args.includes(session)); assert(command.args.includes(order.paymentLink));
  assert(command.args.at(-1)!.includes('¥34.90'));
  assert(!JSON.stringify(preparation).includes('synthetic-secret'));
  assert.equal(prepareAlipayRehearsal(read, authority, order, session).preparation.operationId, preparation.operationId);
});

test('Reject real materials, expired observations, changed identity, unknown fees and authority escalation', () => {
  const now = Date.now(), read = fixtureRead(now), authority = fixtureAuthority(undefined, now), order = fixtureOrder(authority, now), session = randomUUID();
  const prepare = (a: unknown = authority, o: unknown = order, r: unknown = read) => prepareAlipayRehearsal(r, a, o, session, now);
  for (const change of [{ itemId: 'other' }, { skuId: 'sim-sku-other' }, { quantity: 2 }, { taskId: randomUUID() }, { payeeId: 'other' },
    { amount: { minor: '4001', currency: 'CNY' } }, { shippingIncluded: false }, { stockConfirmed: false },
    { expiresAt: new Date(now - 1).toISOString() }, { observedAt: new Date(now + 1).toISOString() },
    { paymentLink: 'https://cashier.alipay.com/real' }, { paymentLink: 'https://cashier.alipay.invalid.evil.test/' },
    { environment: 'production' }, { walletToken: 'secret' }]) assert.throws(() => prepare(authority, { ...order, ...change }));
  for (const change of [{ allowRealPayments: true }, { allowRealOrders: true }, { mode: 'production' },
    { payeeId: undefined }, { skuId: undefined }, { expiresAt: new Date(now).toISOString() }]) assert.throws(() => prepare({ ...authority, ...change }));
  assert.throws(() => prepare(authority, order, { ...read, expiresAt: new Date(now).toISOString() }));
  assert.throws(() => prepare(authority, order, { ...read, query: { ...read.query, walletToken: 'not-accepted' } }));
  assert.throws(() => prepare(authority, order, { ...read, result: { ...read.result, items: [read.result.items[0], read.result.items[0]] } }));
  assert.throws(() => prepareAlipayRehearsal(read, authority, order, 'invented-session', now));
});

test('A response loss and PA restart read the original operation without a second simulated submission', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pa-alipay-')), database = join(directory, 'ledger.sqlite');
  const read = fixtureRead(), authority = fixtureAuthority(), order = fixtureOrder(authority), session = randomUUID(), source = new SyntheticAlipay();
  source.loseSubmitResponse = true; source.failReads = true;
  let ledger = new AlipayRehearsalLedger(new DatabaseSync(database));
  try {
    assert.equal((await ledger.rehearse(read, authority, order, session, source)).simulationState, 'unknown');
    ledger.close(); ledger = new AlipayRehearsalLedger(new DatabaseSync(database)); source.failReads = false;
    const recovered = await ledger.rehearse(read, authority, order, session, source);
    assert.equal(recovered.simulationState, 'confirmed'); assert.equal(recovered.recoveredByReadback, true);
    assert.equal(recovered.businessCompleted, false); assert.equal(recovered.officialPaymentVerified, false);
    assert.equal(source.submitCount, 1);
    assert.equal((await ledger.reconcile(authority.taskId, source)).simulationState, 'confirmed');
    await assert.rejects(ledger.rehearse(read, authority, order, session, source, Date.now() + 600_000), /expired/);
    assert.equal((await ledger.reconcile(authority.taskId, source)).simulationState, 'confirmed');
    assert.equal(source.submitCount, 1);
    await assert.rejects(ledger.rehearse(read, authority, { ...order, orderId: 'sim-replacement' }, session, source), /never replace/);
    await assert.rejects(ledger.rehearse(read, authority, order, randomUUID(), source), /never replace/);
    assert(!readFileSync(database).includes(Buffer.from('synthetic-secret')));
  } finally { ledger.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Order and payment must independently match; a submit acknowledgement alone never confirms', async () => {
  for (const variant of ['pending', 'mismatch', 'unknown'] as const) {
    const ledger = new AlipayRehearsalLedger(), source = new SyntheticAlipay(), authority = fixtureAuthority();
    if (variant === 'pending') source.orderState = 'pending';
    if (variant === 'mismatch') source.paymentOverride = { minor: '2990' };
    if (variant === 'unknown') source.paymentState = 'unknown';
    try { assert.equal((await ledger.rehearse(fixtureRead(), authority, fixtureOrder(authority), randomUUID(), source)).simulationState, variant);
      assert.equal(source.paymentReads, 1); assert.equal(source.orderReads, 1); }
    finally { ledger.close(); }
  }
});

test('Concurrent PA invocations consume one simulation dispatch', async () => {
  const ledger = new AlipayRehearsalLedger(), source = new SyntheticAlipay(), authority = fixtureAuthority(), order = fixtureOrder(authority), read = fixtureRead(), session = randomUUID();
  try {
    await Promise.all(Array.from({ length: 3 }, () => ledger.rehearse(read, authority, order, session, source)));
    assert.equal(source.submitCount, 1);
  } finally { ledger.close(); }
});

test('Real CLI wrapper rejects tampering and executes only a wallet check without inherited secrets', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pa-wallet-')), executable = join(directory, 'fixture-wallet'), alias = join(directory, 'alias');
  try {
    writeFileSync(executable, `#!${process.execPath}\nif(process.argv.slice(2).join()!=="check-wallet" || process.env.PA_SECRET_TEST) process.exit(9); process.stdout.write("synthetic wallet status");`, { mode: 0o700 });
    const pin = { executable, sha256: createHash('sha256').update(readFileSync(executable)).digest('hex') };
    process.env.PA_SECRET_TEST = 'must-not-reach-child';
    assert.equal(await checkAlipayWallet(pin), 'synthetic wallet status');
    assert.throws(() => checkAlipayWallet({ ...pin, sha256: '0'.repeat(64) }), /changed/);
    symlinkSync(executable, alias); assert.throws(() => checkAlipayWallet({ ...pin, executable: alias }));
    chmodSync(executable, 0o777); assert.throws(() => checkAlipayWallet(pin), /privately owned/);
  } finally { delete process.env.PA_SECRET_TEST; rmSync(directory, { recursive: true, force: true }); }
});

test('Existing EIGOS task returns a Taobao catalog to the PA without introducing order/payment actions', { timeout: 90_000 }, async () => {
  const result = await readTaobaoCatalogThroughEigos();
  const authority = fixtureAuthority(result.taskId);
  assert.equal(prepareTaobaoShopping(result.catalogRead, authority).realOrderCreated, false);
  assert.equal(result.catalogRead.evidenceKind, 'fixture'); assert.equal(result.sourceCalls, 1);
});
