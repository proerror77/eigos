import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { diningReservationData } from '../packages/ontology/dining-reservations.js';
import { Objects } from '../packages/runtime/objects.js';
import { fixture, principal } from './fixture.js';
import { startDiningTestMerchant } from './dining-web-fixture.js';

test('a lost web confirmation reconciles the original test order and never repeats its form submission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eigos-dining-web-test-'));
  const merchant = await startDiningTestMerchant();
  const diningWeb = join(directory, 'connection.json'), timeZone = 'Asia/Singapore';
  const terms = {
    restaurant: 'Fixture Dining Bar', city: 'Singapore', time: '19:00', partySize: 2,
    date: new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeZone }).format(new Date(Date.now() + 86400000)),
  };
  let active: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    await writeFile(diningWeb, JSON.stringify({
      owner: principal.owner, restaurant: terms.restaurant, city: terms.city, timeZone, sandboxOrigin: merchant.origin,
    }), { mode: 0o600 });
    const f = active = await fixture(undefined, undefined, undefined, undefined, { diningWeb });
    const apply = (action: string, input: Record<string, unknown>, requestId: string) =>
      f.capabilities.actions.apply(f.access, f.model, action, input, requestId);
    const objects = new Objects(f.db, f.model, f.access);
    const reservation = await apply('PrepareDiningTestReservation', terms, 'prepare');
    const read = async () => diningReservationData.parse((await objects.read(reservation)).properties);
    assert.equal((await read()).state, 'prepared');
    await assert.rejects(apply('RefreshDiningTestReservation', { reservation }, 'before-submit'), /no original submission/);

    merchant.flags.hideOrder = true;
    assert.deepEqual(await apply('SubmitDiningTestReservation', { reservation }, 'first-submit'), reservation);
    assert.equal(merchant.submissions, 1);
    assert.equal(merchant.lostReplies, 1);
    assert.deepEqual(merchant.lookups, [reservation.id]);
    assert.equal((await read()).state, 'unknown');
    assert.equal((await read()).receipt, null);

    // Same Action request returns its prior result. A new request ID still refers to the same external operation.
    await apply('SubmitDiningTestReservation', { reservation }, 'first-submit');
    merchant.flags.hideOrder = false;
    merchant.flags.mismatched = true;
    await apply('SubmitDiningTestReservation', { reservation }, 'new-submit-request');
    assert.equal(merchant.submissions, 1);
    assert.equal((await read()).state, 'unknown');

    merchant.flags.mismatched = false;
    await Promise.all([
      apply('RefreshDiningTestReservation', { reservation }, 'original-readback'),
      apply('SubmitDiningTestReservation', { reservation }, 'concurrent-submit'),
    ]);
    const confirmed = await read();
    assert.equal(confirmed.state, 'confirmed');
    assert.deepEqual(confirmed.receipt, {
      ...terms, reference: reservation.id, bookingId: merchant.orders[0]!.bookingId,
      verifiedBy: 'original-order-lookup', evidence: 'synthetic', observedAt: confirmed.receipt?.observedAt,
    });
    assert.equal(merchant.submissions, 1);
    assert.equal(merchant.orders.length, 1);
    assert(merchant.lookups.length >= 3 && merchant.lookups.every(id => id === reservation.id));
    const technical = (await f.db.query(
      `SELECT state, result FROM ${f.schema}.external_operations WHERE owner=$1 AND operation_key=$2`,
      [principal.owner, reservation.id],
    )).rows;
    assert.deepEqual(technical, [{ state: 'confirmed', result: confirmed.receipt }]);
  } finally {
    await active?.close();
    await merchant.close();
    await rm(directory, { recursive: true, force: true });
  }
});
