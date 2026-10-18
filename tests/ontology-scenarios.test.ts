import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { OntologyObjectStore, linkSnapshotDigest } from '../packages/ontology/object-store.js';
import { digest } from '../packages/core/delegation.js';
import { syntheticOntology } from './fixtures/ontology-objects.js';

type Data = ReturnType<typeof syntheticOntology>;
const props = (data: Data, id: string) => data.batch.objects.find(o => o.ref.id === id)!.properties;
function refreshReceiptSubjects(data: Data) {
  for (const receipt of data.batch.objects.filter(o => o.ref.type === 'SourceReceipt')) {
    for (const subject of receipt.properties.subjects as { object: { type: string; id: string }; digest: string; linksDigest: string }[]) { subject.digest = digest(props(data, subject.object.id)); subject.linksDigest = linkSnapshotDigest(subject.object, data.batch.links); }
  }
}
function fixture(change: (data: Data) => void = () => {}) {
  const data = syntheticOntology(); change(data); refreshReceiptSubjects(data);
  const db = new DatabaseSync(':memory:'), graph = new OntologyObjectStore(db, undefined, () => data.now);
  try { graph.ingest('owner', data.batch, data.source); } catch (error) { db.close(); throw error; }
  return { ...data, db, graph };
}
const quoteInput = (f: Data) => ({ function: 'deliveryQuoteMatches', object: f.ids['quote-D'], request: f.ids.D, serviceLevel: 'ordinary' });
const productInput = (f: Data) => ({ function: 'productOfferMatches', object: f.ids['offer-G'], variant: f.ids.variant, quantity: { amount: '20', unit: 'cup' }, budget: { minor: '50000', currency: 'CNY' }, deadline: f.startsAt, destination: props(f, 'route').destinationSnapshot });
const reservationInput = (f: Data) => ({ function: 'reservationMatches', object: f.ids.reservation, venue: f.ids.venue, startsAt: f.startsAt, timeZone: 'Asia/Shanghai', partySize: 4 });

test('N1 synthetic delivery, goods and reservation scenes use the same object/query/function system', () => {
  const f = fixture();
  try {
    assert.equal(f.graph.evaluate('owner', quoteInput(f)).value, 'pass');
    assert.equal(f.graph.evaluate('owner', { function: 'withinBudget', object: f.ids['quote-D'], budget: { minor: '2000', currency: 'CNY' }, priceBasis: 'estimate' }).value, 'pass');
    assert.equal(f.graph.evaluate('owner', productInput(f)).value, 'pass');
    assert.deepEqual(f.graph.evaluate('owner', { function: 'remainingQuantity', object: f.ids.line }).value, { amount: '2', unit: 'cup' });
    assert.equal(f.graph.evaluate('owner', reservationInput(f)).value, 'pass');
    assert.equal(f.graph.evaluate('owner', { ...reservationInput(f), function: 'slotAvailability', object: f.ids.slot }).value, 'pass');
    const interfaces = f.graph.query('owner', { type: 'Offer', select: ['offerId', 'isFresh'] });
    assert.equal(interfaces.items.length, 3); assert(interfaces.items.every(o => o.properties.isFresh === true && o.derived!.isFresh!.evidenceLevels.includes('synthetic')));
    const selected = f.graph.query('owner', { from: f.ids.D!, link: 'selectedProposal' }).items[0]!;
    assert.equal(f.graph.query('owner', { from: selected.ref, link: 'selectedOffer' }).items[0]!.ref.id, 'quote-D');
    const lines = f.graph.query('owner', { from: f.ids.order!, link: 'lines', select: ['orderLineId', 'remainingQuantity'] });
    assert.deepEqual(lines.items[0]!.properties.remainingQuantity, { amount: '2', unit: 'cup' });
    for (const input of [quoteInput(f), productInput(f), reservationInput(f)]) assert.deepEqual(f.graph.evaluate('owner', input).evidenceLevels, ['synthetic']);
  } finally { f.db.close(); }
});

test('N1 delivery semantics preserve route, weight, request revision, freshness and price basis', async t => {
  const cases: { name: string; change: (d: Data) => void; status: string; value?: unknown }[] = [
    { name: 'different priced weight', change: d => { props(d, 'quote-D').quotedWeight = { amount: '2', unit: 'kg' }; }, status: 'known', value: 'fail' },
    { name: 'different service', change: d => { props(d, 'quote-D').serviceLevel = 'express'; }, status: 'known', value: 'fail' },
    { name: 'saved address changed', change: d => { props(d, 'address-A').address = { text: 'changed synthetic address', city: '北京市', sourceRevision: '2' }; }, status: 'known', value: 'fail' },
    { name: 'stale request revision', change: d => { props(d, 'quote-D').requestRevision = 0; }, status: 'known', value: 'fail' },
    { name: 'expired quote', change: d => { props(d, 'quote-D').expiresAt = new Date(d.now - 1).toISOString(); }, status: 'unknown' },
    { name: 'missing declared weight', change: d => { delete props(d, 'parcel').declaredWeight; }, status: 'unknown' },
    { name: 'missing input version', change: d => { delete props(d, 'quote-D').routeRevision; }, status: 'unknown' },
    { name: 'wrong receipt scope', change: d => { props(d, 'receipt-quote-D').scope = 'payment'; }, status: 'unknown' },
    { name: 'unknown receipt source', change: d => { delete props(d, 'receipt-quote-D').sourceIdentity; }, status: 'unknown' },
    { name: 'future receipt', change: d => { props(d, 'receipt-quote-D').observedAt = new Date(d.now + 10000).toISOString(); }, status: 'unknown' },
  ];
  for (const c of cases) await t.test(c.name, () => { const f = fixture(c.change); try { const r = f.graph.evaluate('owner', quoteInput(f)); assert.equal(r.status, c.status); assert.equal(r.value, c.value); } finally { f.db.close(); } });
  assert.throws(() => fixture(d => { props(d, 'quote-D').quotedWeight = { amount: '1', unit: 'cup' }; }), /schema/);
  const f = fixture();
  try {
    assert.equal(f.graph.evaluate('owner', { function: 'withinBudget', object: f.ids['quote-D'], budget: { minor: '2000', currency: 'CNY' }, priceBasis: 'firm_quote' }).status, 'unknown');
    assert.equal(f.graph.evaluate('owner', { function: 'withinBudget', object: f.ids['quote-D'], budget: { minor: '2000', currency: 'USD' }, priceBasis: 'estimate' }).status, 'unknown');
    assert.equal(f.graph.evaluate('owner', { function: 'withinBudget', object: f.ids['quote-D'], budget: { minor: '1000', currency: 'CNY' }, priceBasis: 'estimate' }).value, 'fail');
    assert.throws(() => f.graph.evaluate('owner', { function: 'deliveryQuoteMatches', object: f.ids.place, request: f.ids.D, serviceLevel: 'ordinary' }), /registered object type/);
  } finally { f.db.close(); }
});

test('N1 goods candidates cannot manufacture capacity, destination, commitment or a lower quantity', async t => {
  const cases: { name: string; change: (d: Data) => void; status: string; value?: unknown }[] = [
    { name: 'unknown capacity', change: d => { props(d, 'offer-G').capacity = 'unknown'; }, status: 'unknown' },
    { name: 'unavailable capacity', change: d => { props(d, 'offer-G').capacity = 'unavailable'; }, status: 'known', value: 'fail' },
    { name: 'quote for 18 instead of 20', change: d => { props(d, 'offer-G').offeredQuantity = { amount: '18', unit: 'cup' }; }, status: 'known', value: 'fail' },
    { name: 'missing delivery destination', change: d => { delete props(d, 'offer-G').deliveryDestination; }, status: 'unknown' },
    { name: 'ETA is not a commitment', change: d => { delete props(d, 'offer-G').deliveryCommitment; props(d, 'offer-G').estimatedArrival = d.startsAt; }, status: 'unknown' },
    { name: 'late commitment', change: d => { props(d, 'offer-G').deliveryCommitment = new Date(Date.parse(d.startsAt) + 60000).toISOString(); }, status: 'known', value: 'fail' },
    { name: 'missing fee scope', change: d => { props(d, 'offer-G').pricingCompleteness = 'unknown'; }, status: 'unknown' },
  ];
  for (const c of cases) await t.test(c.name, () => { const f = fixture(c.change); try { const r = f.graph.evaluate('owner', productInput(f)); assert.equal(r.status, c.status); assert.equal(r.value, c.value); } finally { f.db.close(); } });
});

test('N1 delivery allocation counts are evidenced, bounded and reject duplicates or incompatible facts', async t => {
  const cases: { name: string; change: (d: Data) => void }[] = [
    { name: 'incompatible units', change: d => { props(d, 'allocation').deliveredQuantity = { amount: '18', unit: 'kg' }; } },
    { name: 'unverified allocation', change: d => { props(d, 'allocation').verificationState = 'pending'; } },
    { name: 'wrong delivered specification', change: d => { props(d, 'allocation').acceptedSpecificationRef = 'another-specification'; } },
    { name: 'over-allocation', change: d => { props(d, 'allocation').deliveredQuantity = { amount: '22', unit: 'cup' }; } },
    { name: 'retracted event', change: d => { props(d, 'delivery-event').eventKind = 'retracted'; } },
    { name: 'unknown event meaning', change: d => { delete props(d, 'delivery-event').eventKind; } },
    { name: 'future delivery is not actual delivery', change: d => { props(d, 'delivery-event').occurredAt = new Date(d.now + 10000).toISOString(); } },
    { name: 'wrong business evidence', change: d => { props(d, 'receipt-delivery-event').scope = 'payment'; } },
    { name: 'duplicate event allocation', change: d => {
      const original = d.batch.objects.find(o => o.ref.id === 'allocation')!;
      d.batch.objects.push({ ref: { type: 'DeliveryAllocation', id: 'duplicate' }, properties: { ...original.properties, allocationId: 'duplicate' } });
      d.batch.links.push(...d.batch.links.filter(l => l.from.id === 'allocation').map(l => ({ ...l, from: { type: 'DeliveryAllocation', id: 'duplicate' } })));
      (props(d, 'receipt-allocation').subjects as unknown[]).push({ object: { type: 'DeliveryAllocation', id: 'duplicate' }, digest: '', linksDigest: '' });
    } },
  ];
  for (const c of cases) await t.test(c.name, () => { const f = fixture(c.change); try { assert.equal(f.graph.evaluate('owner', { function: 'remainingQuantity', object: f.ids.line }).status, 'unknown'); } finally { f.db.close(); } });
});

test('N1 reservation effectiveness distinguishes paid, held, confirmed, expired and wrong-party results', async t => {
  const cases: { name: string; change: (d: Data) => void; status: string; value?: unknown }[] = [
    { name: 'paid but pending', change: d => { props(d, 'reservation').reservationState = 'pending'; }, status: 'known', value: 'pending' },
    { name: 'expired hold', change: d => { props(d, 'reservation').reservationState = 'held'; props(d, 'reservation').holdExpiresAt = new Date(d.now - 1).toISOString(); }, status: 'known', value: 'expired' },
    { name: 'free confirmed booking', change: d => { props(d, 'reservation').depositRequired = false; props(d, 'payment').paymentState = 'not_started'; }, status: 'known', value: 'confirmed' },
    { name: 'deposit only pending', change: d => { props(d, 'payment').paymentState = 'pending'; }, status: 'unknown' },
    { name: 'deposit amount missing', change: d => { delete props(d, 'reservation').requiredDeposit; }, status: 'unknown' },
    { name: 'confirmation identity missing', change: d => { delete props(d, 'reservation').providerReference; }, status: 'unknown' },
    { name: 'deposit currency wrong', change: d => { props(d, 'payment').amount = { minor: '5000', currency: 'USD' }; }, status: 'unknown' },
    { name: 'payment from wrong evidence scope', change: d => { props(d, 'receipt-payment').scope = 'reservation'; }, status: 'unknown' },
  ];
  for (const c of cases) await t.test(c.name, () => { const f = fixture(c.change); try { const r = f.graph.evaluate('owner', { function: 'reservationStatus', object: f.ids.reservation }); assert.equal(r.status, c.status); assert.equal(r.value, c.value); } finally { f.db.close(); } });
  const f = fixture(d => { props(d, 'reservation').partySize = 2; });
  try {
    assert.equal(f.graph.evaluate('owner', reservationInput(f)).value, 'fail');
    assert.equal(f.graph.evaluate('owner', { ...reservationInput(f), function: 'slotAvailability', object: f.ids.slot, partySize: 5 }).value, 'fail');
    assert.equal(f.graph.query('owner', { from: f.ids.payment!, link: 'refunds' }).items[0]!.properties.refundState, 'pending');
  } finally { f.db.close(); }
});

test('N1 source evidence cannot be promoted or reused after its bound object changes', () => {
  const data = syntheticOntology(), receipt = props(data, 'receipt-quote-D'); receipt.evidenceLevel = 'live_readonly';
  const db = new DatabaseSync(':memory:'), graph = new OntologyObjectStore(db);
  try { assert.throws(() => graph.ingest('owner', data.batch, data.source), /cannot be promoted/); assert.equal(graph.query('owner', { type: 'ServiceRequest' }).items.length, 0); } finally { db.close(); }
  const f = fixture();
  try {
    const quote = f.graph.read('owner', f.ids['quote-D']!);
    f.graph.ingest('owner', { objects: [{ ref: quote.ref, properties: { ...quote.properties, serviceLevel: 'express' }, expectedRevision: quote.revision }] }, f.source);
    assert.equal(f.graph.evaluate('owner', { function: 'offerFreshness', object: quote.ref }).status, 'unknown');
    assert.throws(() => f.graph.evaluate('owner', { function: 'PayDeposit', object: f.ids.payment }));
  } finally { f.db.close(); }
});

test('N1 receipts bind quantities and business relationships, not just an unrelated valid receipt ID', () => {
  const f = fixture();
  try {
    const allocation = f.graph.read('owner', f.ids.allocation!);
    f.graph.ingest('owner', { objects: [{ ref: allocation.ref, properties: { ...allocation.properties, deliveredQuantity: { amount: '20', unit: 'cup' } }, expectedRevision: allocation.revision }] }, f.source);
    assert.equal(f.graph.evaluate('owner', { function: 'remainingQuantity', object: f.ids.line }).status, 'unknown');
    f.graph.ingest('owner', { objects: [], removeLinks: [{ type: 'OfferRequest', from: f.ids['quote-D']!, to: f.ids.D! }], links: [{ type: 'OfferRequest', from: f.ids['quote-D']!, to: f.ids.G! }] }, f.source);
    assert.equal(f.graph.evaluate('owner', { function: 'offerFreshness', object: f.ids['quote-D'] }).status, 'unknown');
  } finally { f.db.close(); }
});

test('N1 actual arrival uses accepted event time and never treats a partial shipment as whole-order completion', () => {
  const f = fixture(d => { props(d, 'delivery-event').eventKind = 'delivered'; });
  try {
    const value = f.graph.evaluate('owner', { function: 'actualArrival', object: f.ids.shipment });
    assert.equal(value.value, props(f, 'delivery-event').occurredAt); assert.deepEqual(value.functionRef, { id: 'actualArrival', version: '1' });
    assert.deepEqual(value.evidenceLevels, ['synthetic']);
    assert.deepEqual(f.graph.evaluate('owner', { function: 'remainingQuantity', object: f.ids.line }).value, { amount: '2', unit: 'cup' });
    const derived = f.graph.query('owner', { type: 'Shipment', select: ['actualArrivalAt'] }).items[0]!;
    assert.equal(derived.properties.actualArrivalAt, value.value);
    assert.deepEqual(derived.derived!.actualArrivalAt!.functionRef, value.functionRef);
  } finally { f.db.close(); }
});

test('N1 two channels remain distinct offers for one provider, with incompatible pricing left unknown', () => {
  const f = fixture(d => {
    const alternate = { type: 'ProductOffer', id: 'alternate-offer' }, receipt = { type: 'SourceReceipt', id: 'alternate-receipt' }, channel = { type: 'Channel', id: 'alternate-channel' };
    d.batch.objects.push(
      { ref: channel, properties: { channelId: channel.id, displayTitle: '另一合成渠道', name: '另一合成渠道' } },
      { ref: alternate, properties: { ...props(d, 'offer-G'), offerId: alternate.id, pricingCompleteness: 'partial' } },
      { ref: receipt, properties: { ...props(d, 'receipt-offer-G'), receiptId: receipt.id, subjects: [{ object: alternate, digest: '', linksDigest: '' }] } },
    );
    for (const link of d.batch.links.filter(l => l.from.id === 'offer-G')) d.batch.links.push({ ...link, from: alternate, to: link.type === 'OfferChannel' ? channel : link.type === 'ProductOfferEvidence' ? receipt : link.to });
  });
  try {
    const offers = f.graph.query('owner', { from: f.ids.G!, link: 'offers' }).items;
    assert.equal(offers.length, 2);
    const providers = offers.map(o => f.graph.query('owner', { from: o.ref, link: 'provider' }).items[0]!.ref.id);
    assert.deepEqual(providers, ['provider', 'provider']);
    assert.notEqual(...offers.map(o => f.graph.query('owner', { from: o.ref, link: 'channel' }).items[0]!.ref.id) as [string, string]);
    assert.equal(f.graph.evaluate('owner', { ...productInput(f), object: { type: 'ProductOffer', id: 'alternate-offer' } }).status, 'unknown');
    assert.equal(f.graph.evaluate('owner', productInput(f)).value, 'pass');
  } finally { f.db.close(); }
});
