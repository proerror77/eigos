import { z } from 'zod';
import { Conflict, NotFound, digest } from '../../core/identity.js';
import {
  bookImmediateRideAction, immediateFare, immediateOrderLink, immediateRideApprovalCapability, immediateRideConfirmation,
  immediateRideRecord, immediateRideRef, immediateRideTerms, immediateRideType,
} from '../../ontology/didi-immediate-ride.js';
import { json } from '../../ontology/service-contracts.js';
import type { ObjectData, ObjectRef } from '../../ontology/schema.js';
import { ActionPARequestRequired, PARequestRequired } from '../../runtime/clarification.js';
import type { Database } from '../../runtime/database.js';
import { ExternalOperations, UnknownExternalOperation } from '../../runtime/external-operations.js';
import type { Functions, FunctionContext, FunctionHandler } from '../../runtime/functions.js';
import { Objects } from '../../runtime/objects.js';
import { PARequests } from '../../runtime/pa.js';
import type { Sources } from '../../runtime/sources.js';
import type { DidiSource, SourceResolver, SourceResult } from './functions.js';
import { prepareRideInquiry } from './inquiry.js';
import { rideOrderSchema, type RideOrder } from './operations.js';

const offerLifetime = 300_000;
const coordinates = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const dispatchReceipt = z.strictObject({
  bindingId: z.string(), sourceAuthority: immediateRideRecord.shape.sourceAuthority.unwrap(),
  pickup: immediateRideTerms.shape.pickup, destination: immediateRideTerms.shape.destination,
  fare: immediateFare, order: rideOrderSchema,
});
type DispatchReceipt = z.infer<typeof dispatchReceipt>;
type Fields = Pick<z.infer<typeof immediateRideRecord>, 'pickup' | 'destination' | 'state' | 'selectedFare' | 'updatedEstimateMinor' | 'sourceAuthority'>;
type Reader = FunctionContext['objects'];
const presentLocation = (row: ObjectData) => immediateRideTerms.shape.pickup.parse({
  name: row.properties.name, address: row.properties.address, city: row.properties.city,
});
const point = (row: ObjectData) => coordinates.parse(row.properties.coordinates);
const endpointDigest = (row: ObjectData) => digest([row.ref, presentLocation(row), point(row), row.properties.sourceBinding]);
const authority = (source: DidiSource) => source.authorityId ?? digest(source.bindingId);

function interactiveTask(context: FunctionContext) {
  const execution = context.execution;
  if (!execution || !context.edit || !context.assertDispatch || !context.operationId || context.objects.model.scenario ||
      execution.task.input.scheduledAction || execution.task.cognitive_context)
    throw new Conflict('Immediate ride booking requires the original interactive PA task');
  return execution;
}

async function readRide(objects: Reader, ride: ObjectRef) {
  if (ride.type !== immediateRideType) throw new Conflict('Expected an immediate DiDi ride');
  return immediateRideRecord.parse((await objects.read(ride)).properties);
}

async function requestApproval(
  context: FunctionContext, terms: z.infer<typeof immediateRideTerms>, quote: SourceResult, sourceAuthority: string,
) {
  const { task, tasks } = interactiveTask(context);
  const quoteDigest = digest([task.id, terms, quote.receipt.inputDigest, quote.receipt.resultDigest, sourceAuthority]);
  try {
    const raw = await new PARequests(tasks).request(task, quoteDigest, immediateRideApprovalCapability, {
      ...terms, quoteDigest, evidence: quote.evidence,
      message: '请向用户展示起终点、车型和人民币预估价。收到用户对车型和预估价的明确确认后再回传。实际车费可能随行程变化。',
    }, json(immediateRideConfirmation));
    const approval = immediateRideConfirmation.parse(raw);
    if (approval.quoteDigest !== quoteDigest) throw new Conflict('Confirmation does not match the original ride quote');
    if (approval.decision === 'cancel') return null;
    const fare = terms.fares.find(item => item.category === approval.category &&
      item.amountMinor === approval.amountMinor && item.currency === approval.currency);
    if (!fare) throw new Conflict('Confirm one exact vehicle and estimate from the original quote');
    return fare;
  } catch (error) {
    if (error instanceof PARequestRequired) throw new ActionPARequestRequired(error.message, error.choices, error.permissions);
    throw error;
  }
}

export function immediateDidiRideFunctions(
  db: Database, resolve: SourceResolver, sources: () => Sources, functions: () => Functions,
): ReadonlyMap<string, FunctionHandler> {
  const operations = new ExternalOperations(db);
  const resolved = prepareRideInquiry(sources, functions, resolve, true, async (input, context, { origin, destination, quote }) => {
    const { task } = interactiveTask(context);
    const source = await resolve(task.owner);
    const orders = source.orders;
    if (!orders) throw new Conflict('DiDi immediate ordering is unavailable for this account');
    const bindingId = source.bindingId, sourceAuthority = authority(source);
    if (quote.data.kind !== 'estimate' || quote.receipt.bindingId !== bindingId ||
        [origin, destination].some(row => row.properties.sourceBinding !== bindingId) ||
        (orders.environment === 'production' && quote.evidence !== 'live_readonly'))
      throw new Conflict('Ride quote does not match the current DiDi connection');
    const ride = immediateRef(task.id);
    const pickup = presentLocation(origin), dropoff = presentLocation(destination);
    const fields = { pickup, destination: dropoff, sourceAuthority, selectedFare: null, updatedEstimateMinor: null };
    const from = point(origin), to = point(destination);
    const confirmedRoute = { from_lng: String(from.lng), from_lat: String(from.lat), from_name: pickup.name,
      to_lng: String(to.lng), to_lat: String(to.lat), to_name: dropoff.name };
    if (quote.receipt.inputDigest !== digest(confirmedRoute))
      throw new Conflict('The quoted pickup or destination changed');
    const categories = quote.data.items.map(item => item.productCategory);
    const fares = quote.data.items.flatMap(item => {
      if (!item.estimatedMoney || categories.indexOf(item.productCategory) !== categories.lastIndexOf(item.productCategory) ||
          (input.serviceClass && item.productName !== input.serviceClass)) return [];
      return [immediateFare.parse({ category: item.productCategory, vehicle: item.productName,
        amountMinor: item.estimatedMoney.minor, currency: item.estimatedMoney.currency })];
    });
    if (!fares.length) return save(context, ride, { ...fields, state: 'quote_unavailable' });
    const expiry = Date.parse(quote.receipt.startedAt) + offerLifetime;
    const assertFresh = () => {
      if (Date.now() >= expiry) throw new Conflict('The confirmed DiDi estimate expired before dispatch');
    };
    if (Date.now() >= expiry) return save(context, ride, { ...fields, state: 'quote_expired' });
    await orders.assertAvailable();
    const terms = immediateRideTerms.parse({ pickup, destination: dropoff, expiresAt: new Date(expiry).toISOString(), fares });
    const fare = await requestApproval(context, terms, quote, sourceAuthority);
    if (!fare) return save(context, ride, { ...fields, state: 'declined' });
    if (Date.now() >= expiry) return save(context, ride, { ...fields, selectedFare: fare, state: 'quote_expired' });
    const guard = async (objects: Reader) => {
      await source.assertCurrent();
      assertFresh();
      for (const endpoint of [origin, destination]) {
        if (endpointDigest(await objects.read(endpoint.ref)) !== endpointDigest(endpoint))
          throw new Conflict('The confirmed pickup or destination changed');
      }
    };
    await guard(context.objects);
    const fresh = await orders.quote(confirmedRoute, fare.category, context.signal);
    if (fresh.category !== fare.category || fresh.amountMinor !== fare.amountMinor || fresh.currency !== fare.currency)
      return save(context, ride, { ...fields, selectedFare: fare, updatedEstimateMinor: fresh.amountMinor, state: 'price_changed' });
    const key = immediateOperation(task.id);
    try {
      const receipt = await operations.run<DispatchReceipt>(task.owner, key, ride, async client => {
        await context.assertDispatch!(client);
        await guard(new Objects(db, context.objects.model, context.objects.access, client));
      }, async () => {
        const original = await orders.create(fresh, context.signal, async () => {
          await context.assertCurrent?.();
          context.objects.access.action(context.objects.model, bookImmediateRideAction);
          context.objects.access.source(context.objects.model, 'Didi');
          await guard(context.objects);
        });
        assertOrderEvidence(source, original);
        if (original.state !== 'created' || original.independentRead) throw new Conflict('DiDi did not acknowledge the original order');
        return dispatchReceipt.parse({ bindingId, sourceAuthority, pickup, destination: dropoff, fare, order: original });
      }, context.objects, { requestId: context.operationId, taskId: task.id });
      return recordOrder(context, ride, receipt, source);
    } catch (error) {
      if (!(error instanceof UnknownExternalOperation)) throw error;
      return save(context, ride, { ...fields, selectedFare: fare, state: 'unknown' });
    }
  });

  return new Map<string, FunctionHandler>([
    ['bookDidiImmediateRide', async (input, context) => {
      const { task } = interactiveTask(context);
      const ride = immediateRef(task.id);
      if (await readRide(context.objects, ride).catch(error => {
        if (error instanceof NotFound) return undefined;
        throw error;
      })) return context.edit!(ride, async () => {});
      let receipt;
      try {
        receipt = await operations.recover<DispatchReceipt>(task.owner, immediateOperation(task.id), ride, context.objects);
      } catch (error) {
        if (!(error instanceof UnknownExternalOperation)) throw error;
        return save(context, ride, { state: 'unknown', pickup: null, destination: null,
          selectedFare: null, updatedEstimateMinor: null, sourceAuthority: null });
      }
      if (receipt) return recordOrder(context, ride, dispatchReceipt.parse(receipt), await resolve(task.owner));
      return resolved(input, context);
    }],
    ['readDidiImmediateRide', async (raw, context) => {
      const { ride } = immediateRideRef.parse(raw);
      const { sourceAuthority: _authority, ...record } = await readRide(context.objects, ride);
      const [linked] = await context.objects.follow(ride, 'order');
      const order = linked ? {
        ref: linked.ref, orderId: linked.properties.orderId, status: linked.properties.status,
        independentRead: linked.properties.independentRead, evidence: linked.properties.evidence,
      } : null;
      return { ...record, order };
    }],
  ]);
}

function immediateRef(taskId: string) {
  return { type: immediateRideType, id: digest([immediateRideType, taskId]) };
}
const immediateOperation = (taskId: string) => digest(['didi-immediate-dispatch', taskId]);

function assertOrderEvidence(source: DidiSource, order: RideOrder) {
  if (source.orders?.environment === 'production' ? order.evidence !== 'live' : order.evidence === 'live')
    throw new Conflict('Original order evidence differs from the authorized environment');
}

async function recordOrder(context: FunctionContext, ride: ObjectRef, receipt: DispatchReceipt, source: DidiSource) {
  const orders = source.orders;
  if (!orders || source.bindingId !== receipt.bindingId || authority(source) !== receipt.sourceAuthority)
    throw new Conflict('Original order belongs to a different DiDi connection');
  const original = receipt.order;
  let verified: RideOrder | undefined;
  try {
    await source.assertCurrent();
    const check = rideOrderSchema.parse(await (orders.queryAfterCreate
      ? orders.queryAfterCreate(original, context.signal) : orders.query(original.orderId, context.signal)));
    await source.assertCurrent();
    assertOrderEvidence(source, check);
    if (check.orderId === original.orderId && check.independentRead && check.state === 'reported') verified = check;
  } catch {
    // Preserve the acknowledged order and expose the pending readback explicitly.
    context.signal.throwIfAborted();
  }
  return save(context, ride, { state: verified ? 'ordered' : 'submitted', pickup: receipt.pickup,
    destination: receipt.destination, selectedFare: receipt.fare, updatedEstimateMinor: null,
    sourceAuthority: receipt.sourceAuthority }, { value: verified ?? original, bindingId: receipt.bindingId });
}

function save(context: FunctionContext, ride: ObjectRef, fields: Fields, order?: { value: RideOrder; bindingId: string }) {
  const { task } = interactiveTask(context);
  return context.edit!(ride, async graph => {
    const existing = await readRide(graph, ride).catch(error => {
      if (error instanceof NotFound) return undefined;
      throw error;
    });
    if (existing) return;
    await graph.create(ride, { ...fields, id: ride.id, name: '滴滴即时叫车', sourceTaskId: task.id });
    if (!order) return;
    const ref = { type: 'DidiRideOrder', id: digest([order.bindingId, order.value.orderId]) };
    await graph.ingestBatch([{ ref, properties: { id: ref.id, name: 'Original ride order', ...order.value, bindingId: order.bindingId } }],
      'DidiRideOrders', order.value.observedAt);
    await graph.link({ type: immediateOrderLink, from: ride, to: ref });
  });
}
