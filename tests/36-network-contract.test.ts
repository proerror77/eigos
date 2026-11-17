import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { businessDefinition } from '../packages/ontology/definition.js';
import { diningReservationRef, diningReservationTerms, diningReservationType } from '../packages/ontology/dining-reservations.js';
import { Ontology } from '../packages/ontology/model.js';
import {
  cancelCommitmentInput, commitmentApproval, commitmentContact, commitmentReceipt, commitmentState, networkContract, observedReceipt, tableReservationTerms, termsDigest,
} from '../packages/ontology/network-contract.js';
import { objectRefSchema, type OntologyDocument } from '../packages/ontology/schema.js';
import { json, time } from '../packages/ontology/service-contracts.js';

const pinned = { ontology: networkContract.id, version: networkContract.version, digest: new Ontology(networkContract).digest, namespace: 'Net', document: networkContract };
const property = (schema: z.ZodType, required = true) => ({ description: 'Test property', required, schema: json(schema) });
const identity = (names: string[]) => Object.fromEntries(names.map(name => [name, name]));
const reservation = { type: diningReservationType, id: 'a'.repeat(64) };
const approval = { termsDigest: 'b'.repeat(64), approvedAt: '2026-11-17T10:02:00+08:00' };
const contact = { name: '王', phone: 'relay-5821' };
const tableProperties = ['restaurant', 'city', 'branch', 'date', 'time', 'partySize'];

type Gap = 'terms' | 'state' | 'cancel' | 'approval';
/** The synthetic dining pilot with every gap to the contract closed except `open`. */
function diningConsumer(open?: Gap): OntologyDocument {
  const body = structuredClone(businessDefinition);
  body.imports = [...(body.imports ?? []), structuredClone(pinned)];
  const type = body.objectTypes.find(object => object.apiName === diningReservationType)!;
  const terms = diningReservationTerms.shape;
  if (open !== 'terms') Object.assign(type.properties, {
    restaurant: property(terms.restaurant), city: property(terms.city), branch: property(terms.branch.unwrap(), false),
    date: property(terms.date), time: property(terms.time), partySize: property(terms.partySize), termsDigest: property(termsDigest),
    receipts: property(z.array(observedReceipt.extend({ evidence: z.literal('synthetic') })).max(20)),
  });
  if (open !== 'state') type.properties.state = property(z.enum(['offered', 'unknown', 'confirmed', 'canceled']));
  const actions: Record<string, { action: string; parameters: Record<string, string> }> = {
    confirm: { action: 'SubmitDiningTestReservation', parameters: { commitment: 'reservation' } },
    reconcile: { action: 'RefreshDiningTestReservation', parameters: { commitment: 'reservation' } },
  };
  if (open !== 'approval') {
    body.actionTypes.find(action => action.apiName === 'SubmitDiningTestReservation')!.parameters =
      json(diningReservationRef.extend({ approval: commitmentApproval, contact: commitmentContact }));
    Object.assign(actions.confirm!.parameters, { approval: 'approval', contact: 'contact' });
  }
  if (open !== 'cancel') {
    const parameters = json(diningReservationRef.extend({ reason: cancelCommitmentInput.shape.reason }));
    body.actionTypes.push({ apiName: 'CancelDiningTestReservation', description: 'Cancel a synthetic reservation through its recorded channel.',
      parameters, objectParameters: { reservation: diningReservationType }, function: 'cancelDiningTestReservation', submissionCriteria: [] });
    body.functionTypes.push({ apiName: 'cancelDiningTestReservation', description: 'Cancel one synthetic reservation and record the receipt.',
      parameters, returns: json(objectRefSchema), edits: true, dependencies: { objectTypes: [diningReservationType] } });
    actions.cancel = { action: 'CancelDiningTestReservation', parameters: { commitment: 'reservation', reason: 'reason' } };
  }
  type.interfaces.NetTableReservation = { properties: identity(['state', 'termsDigest', 'receipts', ...tableProperties]), links: {}, actions };
  return body;
}

const booking = 'MerchantAgentBooking', offer = { type: booking, id: 'nx-offer-8841' };
/** Adds a booking held with a merchant agent, which implements the contract through Actions of its own. */
function merchantConsumer(): OntologyDocument {
  const body = diningConsumer();
  const actions: Record<string, { action: string; parameters: Record<string, string> }> = {};
  for (const [step, input] of Object.entries({ hold: {}, confirm: { approval: commitmentApproval, contact: commitmentContact }, cancel: { reason: cancelCommitmentInput.shape.reason }, reconcile: {} })) {
    const apiName = step[0]!.toUpperCase() + step.slice(1) + booking, fn = apiName[0]!.toLowerCase() + apiName.slice(1);
    const parameters = json(z.strictObject({ booking: objectRefSchema, ...input }));
    body.actionTypes.push({ apiName, description: `${step} through the merchant agent`, parameters, objectParameters: { booking }, function: fn, submissionCriteria: [] });
    body.functionTypes.push({ apiName: fn, description: `Send ${step} to the merchant agent and record its receipt.`, parameters,
      returns: json(objectRefSchema), edits: true, source: 'MerchantAgentA2A', dependencies: { objectTypes: [booking] } });
    actions[step] = { action: apiName, parameters: { commitment: 'booking', ...identity(Object.keys(input)) } };
  }
  const terms = Object.fromEntries(Object.entries(tableReservationTerms.shape).map(([name, schema]) =>
    [name, schema instanceof z.ZodOptional ? property(schema.unwrap(), false) : property(schema)]));
  body.objectTypes.push({ apiName: booking, displayName: 'Merchant agent booking', description: 'A table booking held with a merchant agent.', primaryKey: 'id', titleProperty: 'name',
    properties: { id: property(z.string()), name: property(z.string()), merchantAgent: property(z.url()), state: property(commitmentState), termsDigest: property(termsDigest),
      expiresAt: property(time, false), receipts: property(z.array(commitmentReceipt).max(20)), ...terms },
    interfaces: { NetTableReservation: { properties: identity(['state', 'termsDigest', 'expiresAt', 'receipts', ...Object.keys(terms)]), links: {}, actions } } });
  return body;
}

test('the pilot DiningReservation implements TableReservation once its four gaps are closed', () => {
  const failures: Record<Gap, RegExp> = {
    terms: /Invalid property mapping DiningReservation\.termsDigest$/,
    state: /Invalid property mapping DiningReservation\.state$/,
    cancel: /Missing action mapping DiningReservation\.cancel$/,
    approval: /Incompatible action parameters$/,
  };
  for (const [gap, failure] of Object.entries(failures)) assert.throws(() => new Ontology(diningConsumer(gap as Gap)), failure, gap);
  const model = new Ontology(diningConsumer());
  assert.equal(model.implements(diningReservationType, 'NetCommitment'), true);
  assert.deepEqual(model.resolveAction(reservation, 'NetTableReservation', 'confirm', { commitment: reservation, approval, contact }),
    { action: 'SubmitDiningTestReservation', input: { reservation, approval, contact } });
  assert.deepEqual(model.resolveAction(reservation, 'NetTableReservation', 'reconcile', { commitment: reservation }),
    { action: 'RefreshDiningTestReservation', input: { reservation } });
  assert.throws(() => model.resolveAction(reservation, 'NetTableReservation', 'hold', { commitment: reservation }), /Interface action is unavailable/);
});

test('a merchant agent booking implements the same contract through Actions of its own', () => {
  const model = new Ontology(merchantConsumer());
  assert.deepEqual(model.resolveAction(offer, 'NetTableReservation', 'confirm', { commitment: offer, approval, contact }),
    { action: 'ConfirmMerchantAgentBooking', input: { booking: offer, approval, contact } });
  assert.equal(model.resolveAction(offer, 'NetTableReservation', 'hold', { commitment: offer }).action, 'HoldMerchantAgentBooking');
  assert.equal(model.resolveAction(reservation, 'NetTableReservation', 'confirm', { commitment: reservation, approval, contact }).action, 'SubmitDiningTestReservation');
});

test('a commitment receipt claims a merchant signature only when it carries one', () => {
  const model = new Ontology(merchantConsumer());
  const receipt = { step: 'confirm', merchantRef: 'NX-1121-0137', termsDigest: 'c'.repeat(64), observedAt: '2026-11-17T10:02:03+08:00' };
  const stored = (receipts: unknown[]) => ({ id: offer.id, name: '南巷小馆', merchantAgent: 'https://agent.nanxiang.example/a2a', state: 'confirmed',
    termsDigest: 'c'.repeat(64), receipts, restaurant: '南巷小馆', city: '上海', branch: '静安店', date: '2026-11-21', time: '19:00', partySize: 4 });
  assert.doesNotThrow(() => model.parseObject(offer, stored([{ ...receipt, evidence: 'merchant_signed', signature: 'eyJhbGciOiJFUzI1NiJ9.e30.c2ln' }])));
  assert.throws(() => model.parseObject(offer, stored([{ ...receipt, evidence: 'merchant_signed' }])));
  assert.throws(() => model.parseObject(offer, stored([{ ...receipt, evidence: 'pa_reported', signature: 'eyJhbGciOiJFUzI1NiJ9.e30.c2ln' }])));
  assert.doesNotThrow(() => model.parseObject(offer, stored([{ ...receipt, evidence: 'pa_reported' }])));
});
