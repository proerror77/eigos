import { z } from 'zod';
import { Conflict, NotFound, digest } from '../../core/identity.js';
import {
  bookImmediateRideAction, immediateApprovalLink, immediateFare, immediateOrderLink, immediateRideApprovalCapability, immediateRideConfirmation,
  immediateRideApproval, immediateRideRecord, immediateRideRef, immediateRideTerms, immediateRideType, reconcileImmediateRideFunction,
} from '../../ontology/didi-immediate-ride.js';
import { bookWithEndpoints, bookWithEndpointsFunction, immediateRideRouteLink, resolvedRideEndpoints,
  type ResolvedRideEndpoints } from '../../ontology/didi-ride-endpoints.js';
import { assertSavedRideEndpoints, rideEndpointLinks, savedRideRevisions } from './endpoints.js';
import { privateLocation } from '../../ontology/personal-places.js';
import { json } from '../../ontology/service-contracts.js';
import type { ObjectData, ObjectRef } from '../../ontology/schema.js';
import { actionConfirmationRef } from '../../runtime/action-confirmation.js';
import type { Database } from '../../runtime/database.js';
import { ExternalOperations, UnknownExternalOperation } from '../../runtime/external-operations.js';
import type { Functions, FunctionContext, FunctionHandler } from '../../runtime/functions.js';
import { Objects } from '../../runtime/objects.js';
import { PARequests } from '../../runtime/pa.js';
import type { Sources } from '../../runtime/sources.js';
import type { DidiSource, SourceResolver, SourceResult } from './functions.js';
import { prepareRideInquiry } from './inquiry.js';
import { rideOrderSchema, type RideOrder } from './operations.js';
import { authorizeDidiPA, didiPAConnection } from './pa-read.js';
import { completeDidiPAOrder, didiPAOrderInput, didiPAOrderInstruction, didiPAOrderTools, savedDidiPAOrder, type DidiPAOrderInput } from './pa-order.js';

const offerLifetime = 300_000;
const coordinates = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const dispatchReceipt = z.strictObject({
  bindingId: z.string(), sourceAuthority: immediateRideRecord.shape.sourceAuthority.unwrap(),
  pickup: immediateRideTerms.shape.pickup, destination: immediateRideTerms.shape.destination,
  fare: immediateFare, order: rideOrderSchema, endpoints: resolvedRideEndpoints.optional(),
  approvedQuote: immediateRideApproval.optional(),
});
type DispatchReceipt = z.infer<typeof dispatchReceipt>;
type Fields = Pick<z.infer<typeof immediateRideRecord>, 'pickup' | 'destination' | 'state' | 'selectedFare' | 'updatedEstimateMinor' | 'sourceAuthority' | 'approvedQuote'>;
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
  context: FunctionContext, terms: z.infer<typeof immediateRideTerms>, quote: SourceResult, sourceAuthority: string, endpoints: ResolvedRideEndpoints,
) {
  const { task, tasks } = interactiveTask(context);
  const quoteDigest = digest([task.id, context.operationId, terms, endpoints, quote.receipt.inputDigest, quote.receipt.resultDigest, sourceAuthority]);
  const raw = await new PARequests(tasks).requestActionInput(task, context.operationId!, quoteDigest,
    immediateRideApprovalCapability, 'authorization', {
      ...terms, quoteDigest, evidence: quote.evidence,
      message: '请向用户展示起终点、车型和人民币预估价。收到用户对车型和预估价的明确确认后再回传。实际车费可能随行程变化。',
    }, json(immediateRideConfirmation));
  const approval = immediateRideConfirmation.parse(raw);
  if (approval.quoteDigest !== quoteDigest) throw new Conflict('Confirmation does not match the original ride quote');
  if (approval.decision === 'cancel') return null;
  const fare = terms.fares.find(item => item.category === approval.category &&
    item.amountMinor === approval.amountMinor && item.currency === approval.currency);
  if (!fare) throw new Conflict('Confirm one exact vehicle and estimate from the original quote');
  return { fare, quoteDigest };
}

export function immediateDidiRideFunctions(
  db: Database, resolve: SourceResolver, sources: () => Sources, functions: () => Functions,
): ReadonlyMap<string, FunctionHandler> {
  const operations = new ExternalOperations(db);
  const finishPA = async (context: FunctionContext, ride: ObjectRef, input: DidiPAOrderInput,
    guard?: Parameters<typeof completeDidiPAOrder>[3]) => {
    const result = await completeDidiPAOrder(db, context, input, guard);
    return save(context, ride, {
      state: result.state, pickup: input.pickup, destination: input.destination, selectedFare: input.fare,
      updatedEstimateMinor: result.amount ?? null, sourceAuthority: result.bindingId,
      approvedQuote: { quoteDigest: input.quoteDigest, expiresAt: input.expiresAt, requestId: context.operationId! },
    }, result.order, input.endpoints);
  };
  const resolveBooking = (actionName: string, linkedRoute: boolean) => prepareRideInquiry(
    sources, functions, resolve, true, async (input, context, resolved) => {
    const { origin, destination, quote, endpoints } = resolved;
    const { task } = interactiveTask(context);
    const source = await resolve(task.owner);
    const orders = source.orders;
    const paConnection = source.paOrdersEnabled ? didiPAConnection.getStore() : undefined;
    if (!paConnection && !orders) throw new Conflict('DiDi immediate ordering is unavailable for this account');
    const bindingId = source.bindingId, sourceAuthority = authority(source);
    if (quote.data.kind !== 'estimate' || quote.receipt.bindingId !== bindingId ||
        [origin, destination].some(row => row.properties.sourceBinding !== bindingId) ||
        (paConnection ? quote.evidence !== 'pa_reported' : orders?.environment === 'production' && quote.evidence !== 'live_readonly'))
      throw new Conflict('Ride quote does not match the current DiDi connection');
    const ride = immediateRef(task.id);
    const pickup = presentLocation(origin), dropoff = presentLocation(destination);
    const fields = { pickup, destination: dropoff, sourceAuthority, selectedFare: null, updatedEstimateMinor: null };
    const route = linkedRoute ? endpoints : undefined;
    const record = (outcome: Fields) => save(context, ride, outcome, undefined, route);
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
    if (!fares.length) return record({ ...fields, state: 'quote_unavailable' });
    const expiry = Date.parse(quote.receipt.startedAt) + offerLifetime;
    const assertFresh = () => {
      if (Date.now() >= expiry) throw new Conflict('The confirmed DiDi estimate expired before dispatch');
    };
    if (Date.now() >= expiry) return record({ ...fields, state: 'quote_expired' });
    await orders?.assertAvailable();
    const terms = immediateRideTerms.parse({ pickup, destination: dropoff, expiresAt: new Date(expiry).toISOString(), fares });
    const approved = await requestApproval(context, terms, quote, sourceAuthority, endpoints);
    if (!approved) return record({ ...fields, state: 'declined' });
    const { fare, quoteDigest } = approved;
    const approvedQuote = { quoteDigest, expiresAt: terms.expiresAt, requestId: context.operationId! };
    if (Date.now() >= expiry) return record({ ...fields, approvedQuote, selectedFare: fare, state: 'quote_expired' });
    const guard = async (objects: Reader) => {
      await source.assertCurrent();
      assertFresh();
      await assertSavedRideEndpoints(objects, endpoints);
      if (task.input.placeContinuation?.requestId === context.operationId && objects.model.links.has(immediateApprovalLink)) {
        objects.access.definition(objects.model, 'link', immediateApprovalLink);
        await objects.read(actionConfirmationRef(context.operationId!));
      }
      if (route) {
        const { access, model } = objects;
        access.read(model, 'Route');
        access.definition(model, 'link', immediateRideRouteLink);
        for (const link of rideEndpointLinks(immediateRouteRef(ride), route))
          access.definition(model, 'link', link.type);
      }
      for (const endpoint of [origin, destination]) {
        if (endpointDigest(await objects.read(endpoint.ref)) !== endpointDigest(endpoint))
          throw new Conflict('The confirmed pickup or destination changed');
      }
    };
    await guard(context.objects);
    if (paConnection) {
      const dispatch = didiPAOrderInput.parse({
        reference: immediateOperation(task.id), connectionRef: paConnection, quoteDigest, pickup, destination: dropoff,
        fare, expiresAt: terms.expiresAt, arguments: confirmedRoute, ...(route ? { endpoints: route } : {}),
        instruction: didiPAOrderInstruction,
      });
      return finishPA(context, ride, dispatch, client =>
        guard(new Objects(db, context.objects.model, context.objects.access, client)));
    }
    if (!orders) throw new Conflict('DiDi immediate ordering is unavailable for this account');
    const fresh = await orders.quote(confirmedRoute, fare.category, context.signal);
    if (fresh.category !== fare.category || fresh.amountMinor !== fare.amountMinor || fresh.currency !== fare.currency)
      return record({ ...fields, approvedQuote, selectedFare: fare, updatedEstimateMinor: fresh.amountMinor, state: 'price_changed' });
    const key = immediateOperation(task.id);
    try {
      const receipt = await operations.run<DispatchReceipt>(task.owner, key, ride, async client => {
        await context.assertDispatch!(client);
        await guard(new Objects(db, context.objects.model, context.objects.access, client));
      }, async () => {
        const original = await orders.create(fresh, context.signal, async () => {
          await context.assertCurrent?.();
          context.objects.access.action(context.objects.model, actionName);
          context.objects.access.source(context.objects.model, 'Didi');
          await guard(context.objects);
        });
        assertOrderEvidence(source, original);
        if (original.state !== 'created' || original.independentRead) throw new Conflict('DiDi did not acknowledge the original order');
        return dispatchReceipt.parse({ bindingId, sourceAuthority, pickup, destination: dropoff, fare, approvedQuote, order: original, ...(route ? { endpoints: route } : {}) });
      }, context.objects, { requestId: context.operationId, taskId: task.id });
      return recordOrder(context, ride, receipt, source);
    } catch (error) {
      if (!(error instanceof UnknownExternalOperation)) throw error;
      return record({ ...fields, approvedQuote, selectedFare: fare, state: 'unknown' });
    }
  });

  const book = (actionName: string, linkedRoute: boolean): FunctionHandler => {
    const resolved = resolveBooking(actionName, linkedRoute);
    return async (input, context) => {
      const { task, tasks } = interactiveTask(context);
      const ride = immediateRef(task.id);
      if (await readRide(context.objects, ride).catch(error => {
        if (error instanceof NotFound) return undefined;
        throw error;
      })) return context.edit!(ride, async () => {});
      if (task.input.memberAccess) {
        context.objects.access.source(context.objects.model, 'Didi');
        if (!(await resolve(task.owner)).paOrdersEnabled)
          throw new Conflict('DiDi PA ordering is unavailable for this account');
        const pending = await savedDidiPAOrder(db, task.owner, task.id);
        if (pending) return finishPA(context, ride, pending);
        const connected = await authorizeDidiPA(tasks, task, 'order', 'immediate-ride', didiPAOrderTools);
        if (connected.status === 'declined') return save(context, ride, {
          state: 'declined', pickup: null, destination: null, selectedFare: null, updatedEstimateMinor: null, sourceAuthority: null,
        });
        return didiPAConnection.run(connected.connectionRef, () => resolved(input, context));
      }
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
    };
  };
  return new Map<string, FunctionHandler>([
    ['bookDidiImmediateRide', book(bookImmediateRideAction, false)],
    [bookWithEndpointsFunction, book(bookWithEndpoints, true)],
    [reconcileImmediateRideFunction, async (raw, context) => {
      if (context.objects.model.scenario) throw new Conflict('Reconciliation requires the live Ontology');
      const { ride } = immediateRideRef.parse(raw);
      const booking = await readRide(context.objects, ride);
      if (booking.state !== 'submitted' && booking.state !== 'unknown') return context.edit!(ride, async () => {});
      const unchanged = () => context.edit!(ride, async () => {});
      if (context.principal.memberAccess) return unchanged();
      let recovered;
      try {
        recovered = await operations.recover<DispatchReceipt>(context.principal.owner,
          immediateOperation(booking.sourceTaskId), ride, context.objects);
      } catch (error) {
        if (error instanceof UnknownExternalOperation) return unchanged();
        throw error;
      }
      if (!recovered) return unchanged();
      const receipt = dispatchReceipt.parse(recovered);
      const source = await resolve(context.principal.owner,
        { bindingId: receipt.bindingId, orderId: receipt.order.orderId, readOnly: true });
      const checked = await readOriginalOrder(context, receipt, source);
      if (!checked) return unchanged();
      return context.edit!(ride, async graph => {
        const row = await graph.read(ride), current = immediateRideRecord.parse(row.properties);
        if (current.state !== 'submitted' && current.state !== 'unknown') return;
        if (current.sourceTaskId !== booking.sourceTaskId ||
            current.sourceAuthority && current.sourceAuthority !== receipt.sourceAuthority)
          throw new Conflict('The original ride connection changed');
        await source.assertCurrent();
        const patch = { state: 'ordered', pickup: receipt.pickup, destination: receipt.destination,
          selectedFare: receipt.fare, sourceAuthority: receipt.sourceAuthority,
          ...(receipt.approvedQuote ? { approvedQuote: receipt.approvedQuote } : {}),
          ...(receipt.endpoints && savedRideRevisions(receipt.endpoints) ? { locationClassification: privateLocation } : {}) };
        if (receipt.endpoints && !(await graph.follow(ride, 'route')).length)
          await storeRoute(graph, ride, receipt.endpoints, receipt.pickup, receipt.destination);
        await storeOrder(graph, ride, { value: checked, bindingId: receipt.bindingId }, receipt.sourceAuthority);
        await graph.edit(ride, row.revision, patch);
      });
    }],
    ['readDidiImmediateRide', async (raw, context) => {
      const { ride } = immediateRideRef.parse(raw);
      const { sourceAuthority: _authority, locationClassification: _location, ...record } = await readRide(context.objects, ride);
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
const immediateRouteRef = (ride: ObjectRef) => ({ type: 'Route', id: digest([ride.id, immediateRideRouteLink]) });
const immediateOperation = (taskId: string) => digest(['didi-immediate-dispatch', taskId]);

function assertOrderEvidence(source: DidiSource, order: RideOrder) {
  if (source.orders?.environment === 'production' ? order.evidence !== 'live' : !['provider_mock', 'synthetic'].includes(order.evidence))
    throw new Conflict('Original order evidence differs from the authorized environment');
}

async function readOriginalOrder(context: FunctionContext, receipt: DispatchReceipt, source: DidiSource) {
  const orders = source.orders;
  if (!orders || source.bindingId !== receipt.bindingId || authority(source) !== receipt.sourceAuthority)
    throw new Conflict('Original order belongs to a different DiDi connection');
  const original = receipt.order;
  assertOrderEvidence(source, original);
  try {
    await source.assertCurrent();
    const check = rideOrderSchema.parse(await (orders.queryAfterCreate
      ? orders.queryAfterCreate(original, context.signal) : orders.query(original.orderId, context.signal)));
    await source.assertCurrent();
    assertOrderEvidence(source, check);
    if (check.orderId === original.orderId && check.independentRead && check.state === 'reported') return check;
  } catch {
    context.signal.throwIfAborted();
  }
}

async function recordOrder(context: FunctionContext, ride: ObjectRef, receipt: DispatchReceipt, source: DidiSource) {
  const verified = await readOriginalOrder(context, receipt, source);
  return save(context, ride, { state: verified ? 'ordered' : 'submitted', pickup: receipt.pickup,
    destination: receipt.destination, selectedFare: receipt.fare, updatedEstimateMinor: null,
    sourceAuthority: receipt.sourceAuthority, ...(receipt.approvedQuote ? { approvedQuote: receipt.approvedQuote } : {}),
  }, { value: verified ?? receipt.order, bindingId: receipt.bindingId }, receipt.endpoints);
}

async function storeRoute(graph: Objects, ride: ObjectRef, endpoints: ResolvedRideEndpoints,
  pickup: DispatchReceipt['pickup'], destination: DispatchReceipt['destination']) {
  const route = immediateRouteRef(ride), revisions = savedRideRevisions(endpoints);
  await graph.create(route, { id: route.id, name: `${pickup.name} → ${destination.name}`,
    ...(endpoints.pickup ? { pickup: endpoints.pickup } : {}),
    ...(revisions ? { personalPlaceRevisions: revisions, locationClassification: privateLocation } : {}) });
  await graph.linkBatch([...rideEndpointLinks(route, endpoints), { type: immediateRideRouteLink, from: ride, to: route }]);
}

async function storeOrder(graph: Objects, ride: ObjectRef, order: { value: RideOrder; bindingId: string }, sourceAuthority: Fields['sourceAuthority']) {
  const ref = { type: 'DidiRideOrder', id: digest([order.bindingId, order.value.orderId]) };
  const [original] = await graph.follow(ride, 'order');
  if (original && original.ref.id !== ref.id) throw new Conflict('DiDi order differs from the original booking');
  await graph.ingestBatch([{ ref, properties: { id: ref.id, name: 'Original ride order', ...order.value, bindingId: order.bindingId,
    ...(graph.model.object(ref.type).properties.sourceAuthority ? { sourceAuthority } : {}) } }],
    'DidiRideOrders', order.value.observedAt);
  if (!original) await graph.link({ type: immediateOrderLink, from: ride, to: ref });
}

function save(context: FunctionContext, ride: ObjectRef, fields: Fields,
  order?: { value: RideOrder; bindingId: string }, endpoints?: ResolvedRideEndpoints) {
  const { task } = interactiveTask(context);
  return context.edit!(ride, async graph => {
    const existing = await readRide(graph, ride).catch(error => {
      if (error instanceof NotFound) return undefined;
      throw error;
    });
    if (existing) return;
    const personalPlaceRevisions = endpoints && savedRideRevisions(endpoints);
    const classified = personalPlaceRevisions ? { locationClassification: privateLocation } : {};
    await graph.create(ride, { ...fields, ...classified, id: ride.id, name: '滴滴即时叫车', sourceTaskId: task.id });
    if (task.input.placeContinuation?.requestId === context.operationId && graph.model.links.has(immediateApprovalLink))
      await graph.link({ type: immediateApprovalLink, from: ride, to: actionConfirmationRef(context.operationId!) });
    if (endpoints) await storeRoute(graph, ride, endpoints, fields.pickup!, fields.destination!);
    if (order) await storeOrder(graph, ride, order, fields.sourceAuthority);
  });
}
