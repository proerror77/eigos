import { Conflict, NotFound, digest } from '../../core/identity.js';
import { partnerRideEstimateResult, partnerRideServices } from '../../ontology/partner-rides.js';
import { partnerRideInputs as inputs, partnerRideLinks as links, partnerRideTypes as types, partnerRideReadbacks as reads } from '../../ontology/partner-ride-lifecycle.js';
import type { ObjectRef } from '../../ontology/schema.js';
import { ActionPARequestRequired, PARequestRequired } from '../../runtime/clarification.js';
import type { Database } from '../../runtime/database.js';
import type { FunctionContext, FunctionHandler, Functions } from '../../runtime/functions.js';
import type { Objects } from '../../runtime/objects.js';

const quoteLifetime = 5 * 60_000;
const timestamp = () => new Date().toISOString();
const ownedRef = (type: string, owner: string, key: unknown): ObjectRef => ({ type, id: digest([type, owner, key]) });
async function existing(graph: Pick<Objects, 'read'>, ref: ObjectRef) {
  try { return await graph.read(ref); }
  catch (error) { if (!(error instanceof NotFound)) throw error; }
}
function syntheticEdit(db: Database, context: FunctionContext) {
  if (!db.sandboxEnabled || !context.edit || context.objects.model.scenario)
    throw new Conflict('Synthetic partner rides require an enabled development Action');
  return context.edit;
}
function readRef(ref: ObjectRef, type: string) {
  if (ref.type !== type) throw new Conflict('Use the exact original partner ride record');
  return ref;
}
function validateAmount(fields: Record<string, unknown>, amountMinor: number, currency: string) {
  if (fields.amountMinor !== amountMinor || fields.currency !== currency)
    throw new Conflict('Confirmed currency and amount must match the original record');
}

export function partnerRideLifecycleFunctions(db: Database, getFunctions: () => Functions) {
  return new Map<string, FunctionHandler>([
    ['preparePartnerRideQuote', async (input, context) => {
      const { provider, route } = inputs.preparePartnerRideQuote.parse(input);
      const task = context.execution?.task;
      if (!context.edit || !task || task.input.scheduledAction || context.objects.model.scenario)
        throw new Conflict('Prepare the quote in the original interactive PA task');
      const fn = partnerRideServices[provider].function;
      let raw: unknown;
      try {
        raw = await getFunctions().invoke(context.objects.model, fn, route, context);
      } catch (error) {
        if (error instanceof PARequestRequired) throw new ActionPARequestRequired(error.message, error.choices, error.permissions);
        throw error;
      }
      const estimate = partnerRideEstimateResult.parse(raw);
      if (estimate.status !== 'quoted') throw new Conflict('Partner ride quote unavailable: ' + estimate.reason);
      const quote = ownedRef(types.quote, context.principal.owner, estimate.paRequestId);
      return context.edit(quote, async graph => {
        if (!await existing(graph, quote)) await graph.create(quote, { id: quote.id, name: provider + ' estimate', estimate });
      });
    }],
    ['preparePartnerRideHandoff', async (input, context) => {
      const { quote, vehicleId } = inputs.preparePartnerRideHandoff.parse(input);
      readRef(quote, types.quote);
      if (!context.edit || context.objects.model.scenario) throw new Conflict('A live Action must own this handoff');
      const handoff = ownedRef(types.handoff, context.principal.owner, quote.id);
      return context.edit(handoff, async graph => {
        const original = await graph.read(quote);
        const estimate = partnerRideEstimateResult.options[1].parse(original.properties.estimate);
        graph.access.source(graph.model, estimate.provider);
        const vehicle = estimate.quotes.find(item => item.id === vehicleId);
        if (!vehicle) throw new Conflict('Select a vehicle from the original estimate');
        const observedUntil = Date.parse(estimate.observedAt) + quoteLifetime;
        const fareUntil = 'fare' in vehicle && vehicle.fare.expiresAt ? Date.parse(vehicle.fare.expiresAt) : observedUntil;
        const until = Math.min(observedUntil, fareUntil);
        if (until <= Date.now()) throw new Conflict('The original partner ride estimate expired');
        const current = await existing(graph, handoff);
        if (current) {
          if (current.properties.appLink !== vehicle.appLink) throw new Conflict('This quote already has a different selected handoff');
          return;
        }
        await graph.create(handoff, { id: handoff.id, name: estimate.provider + ' App handoff', appLink: vehicle.appLink,
          provider: estimate.provider, expiresAt: new Date(until).toISOString(), orderCreated: false, paymentInitiated: false });
        await graph.link({ type: links.handoff, from: quote, to: handoff });
      });
    }],
    ['readPartnerRideQuote', async (input, context) => {
      const { quote } = reads.readPartnerRideQuote.parameters.parse(input);
      const row = await context.objects.read(readRef(quote, types.quote));
      const result = reads.readPartnerRideQuote.result.parse(row.properties);
      context.objects.access.source(context.objects.model, result.estimate.provider);
      return result;
    }],
    ['readPartnerRideHandoff', async (input, context) => {
      const { handoff } = reads.readPartnerRideHandoff.parameters.parse(input);
      const row = await context.objects.read(readRef(handoff, types.handoff));
      const result = reads.readPartnerRideHandoff.result.parse(row.properties);
      context.objects.access.source(context.objects.model, result.provider);
      if (Date.parse(result.expiresAt) <= Date.now()) throw new Conflict('The partner ride handoff expired');
      return result;
    }],
    ['createSyntheticPartnerRideQuote', async (input, context) => {
      const { trialId, provider, route } = inputs.createSyntheticPartnerRideQuote.parse(input);
      const quote = ownedRef(types.trialQuote, context.principal.owner, trialId);
      return syntheticEdit(db, context)(quote, async graph => {
        const prior = await existing(graph, quote);
        if (prior) {
          if (prior.properties.provider !== provider || digest(prior.properties.route) !== digest(route))
            throw new Conflict('This trial already has a different provider or route');
          return;
        }
        await graph.create(quote, { id: quote.id, name: provider + ' synthetic quote', provider, route,
          evidence: 'synthetic', amountMinor: provider === 'Uber' ? 1250 : 1380, currency: 'SGD',
          expiresAt: new Date(Date.now() + quoteLifetime).toISOString() });
      });
    }],
    ['bookSyntheticPartnerRide', async (input, context) => {
      const { quote, amountMinor, currency } = inputs.bookSyntheticPartnerRide.parse(input);
      readRef(quote, types.trialQuote);
      const order = ownedRef(types.order, context.principal.owner, quote.id);
      return syntheticEdit(db, context)(order, async graph => {
        const { properties } = await graph.read(quote);
        validateAmount(properties, amountMinor, currency);
        if (await existing(graph, order)) return;
        if (Date.parse(String(properties.expiresAt)) <= Date.now()) throw new Conflict('The synthetic quote expired');
        await graph.create(order, { id: order.id, name: properties.provider + ' synthetic order',
          provider: properties.provider, evidence: 'synthetic', amountMinor, currency, state: 'ordered',
          orderId: order.id, status: 'synthetic order created', independentRead: false,
          observedAt: timestamp(), createdAt: timestamp(), canceledAt: null });
        await graph.link({ type: links.order, from: quote, to: order });
      });
    }],
    ['cancelSyntheticPartnerRide', async (input, context) => {
      const { order } = inputs.cancelSyntheticPartnerRide.parse(input);
      readRef(order, types.order);
      return syntheticEdit(db, context)(order, async graph => {
        const { properties, revision } = await graph.read(order);
        if (properties.state !== 'canceled') await graph.edit(order, revision, { state: 'canceled', status: 'synthetic order canceled', observedAt: timestamp(), canceledAt: timestamp() });
      });
    }],
    ['paySyntheticPartnerRide', async (input, context) => {
      const { order, amountMinor, currency } = inputs.paySyntheticPartnerRide.parse(input);
      readRef(order, types.order);
      const payment = ownedRef(types.payment, context.principal.owner, order.id);
      return syntheticEdit(db, context)(payment, async graph => {
        const { properties } = await graph.read(order);
        validateAmount(properties, amountMinor, currency);
        if (await existing(graph, payment)) return;
        if (properties.state !== 'ordered') throw new Conflict('A canceled synthetic ride cannot be paid');
        await graph.create(payment, { id: payment.id, name: properties.provider + ' synthetic payment',
          provider: properties.provider, evidence: 'synthetic', amountMinor, currency, state: 'paid', observedAt: timestamp() });
        await graph.link({ type: links.payment, from: order, to: payment });
      });
    }],
  ]);
}
