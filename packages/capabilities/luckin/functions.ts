import type { z } from 'zod';
import { Conflict, digest } from '../../core/identity.js';
import {
  luckinCreateCapability, luckinPreviewCapability, luckinReads, luckinReply, luckinShopSearch, pickupConfirmation, pickupCreated, pickupInput,
  pickupOrder, pickupOrderType, pickupQuote, pickupRefInput,
} from '../../ontology/luckin.js';
import { json } from '../../ontology/service-contracts.js';
import type { FunctionContext, FunctionHandler } from '../../runtime/functions.js';
import { PARequests } from '../../runtime/pa.js';
import { locationForService } from '../location.js';

async function request(ctx: FunctionContext, capability: string, input: Record<string, unknown>, schema: z.ZodType) {
  const execution = ctx.execution;
  if (!execution) throw new Conflict('Use the original authenticated PA task for Luckin');
  const reply = luckinReply(schema);
  const answer = reply.parse(await new PARequests(execution.tasks).request(
    execution.task, capability, capability, input, json(reply),
  ));
  if (answer.status !== 'available') throw new Conflict(`Luckin PA result: ${answer.status}`);
  const observed = Date.parse(answer.observedAt);
  if (observed > Date.now() + 5000 || capability !== luckinCreateCapability && observed < Date.now() - 300000)
    throw new Conflict('Luckin PA evidence is outside its freshness window');
  const { status: _status, ...observation } = answer;
  return observation;
}

const terms = (items: (z.infer<typeof pickupInput>['items'][number])[]) =>
  items.map(({ productId, sku, quantity }) => ({ productId, sku, quantity }));
function requireEdit(ctx: FunctionContext) {
  if (!ctx.edit || !ctx.execution || ctx.objects.model.scenario) throw new Conflict('Use a live Luckin pickup Action on the original authenticated PA task');
  return { stage: ctx.edit, taskId: ctx.execution.task.id };
}

export function luckinFunctions(): ReadonlyMap<string, FunctionHandler> {
  const handlers = new Map<string, FunctionHandler>();
  for (const [name, operation] of Object.entries(luckinReads)) {
    handlers.set(name, async (raw, ctx) => {
      const input = operation.input.parse(raw);
      const observation = await request(ctx, operation.capability, input, operation.result);
      const result = observation.data as { productId?: number; orderId?: string };
      if ('productId' in input && result.productId !== input.productId ||
          'orderId' in input && result.orderId !== input.orderId)
        throw new Conflict('The Luckin PA returned a different product or order');
      return observation;
    });
  }
  handlers.set('findLuckinShops', async (raw, ctx) => {
    const input = luckinShopSearch.parse(raw);
    const point = 'latitude' in input ? input : (await locationForService(ctx, input, 'luckin_pickup', 'wgs84')).position;
    const { latitude, longitude } = point;
    return request(ctx, luckinReads.findLuckinShops.capability,
      { latitude, longitude, ...(input.shopName ? { shopName: input.shopName } : {}) }, luckinReads.findLuckinShops.result);
  });
  handlers.set('previewLuckinPickup', async (raw, ctx) => {
    const { stage, taskId } = requireEdit(ctx), input = pickupInput.parse(raw);
    if (new Set(input.items.map(item => `${item.productId}:${item.sku}`)).size !== input.items.length)
      throw new Conflict('Combine quantities for identical Luckin SKUs');
    const answer = await request(ctx, luckinPreviewCapability, input, pickupQuote);
    const quote = pickupQuote.parse(answer.data);
    if (quote.shop.shopId !== input.shopId || digest(terms(quote.items)) !== digest(input.items))
      throw new Conflict('Luckin preview differs from the selected store or items');
    if (quote.totalMinor > quote.originalTotalMinor) throw new Conflict('Luckin preview returned inconsistent pricing');
    const quoteDigest = digest(quote);
    const order = { type: pickupOrderType, id: digest([ctx.principal.owner, taskId, quoteDigest]) };
    return stage(order, async graph => {
      await graph.create(order, {
        id: order.id, name: quote.shop.name, quote, quoteDigest,
        connectionRef: answer.connectionRef, sourceTaskId: taskId, observedAt: answer.observedAt,
        expiresAt: new Date(Date.parse(answer.observedAt) + 300000).toISOString(),
        state: 'previewed', merchantOrderId: null, merchantAmountMinor: null, evidence: answer.evidence,
      });
    });
  });
  handlers.set('submitLuckinPickup', async (raw, ctx) => {
    const { stage, taskId } = requireEdit(ctx), { order } = pickupRefInput.parse(raw);
    if (order.type !== pickupOrderType) throw new Conflict('Reference the original Luckin pickup preview');
    const current = await ctx.objects.read(order), p = pickupOrder.parse(current.properties);
    if (p.sourceTaskId !== taskId || p.state !== 'previewed')
      throw new Conflict('Use the Luckin preview from this original PA task');
    // Same provider request key when the authenticated PA resumes this task.
    const confirmation = pickupConfirmation.parse({ order, quote: p.quote, quoteDigest: p.quoteDigest, connectionRef: p.connectionRef, expiresAt: p.expiresAt });
    const answer = await request(ctx, luckinCreateCapability, confirmation, pickupCreated);
    const receipt = pickupCreated.parse(answer.data);
    if (answer.connectionRef !== p.connectionRef || receipt.quoteDigest !== p.quoteDigest ||
        Date.parse(receipt.dispatchedAt) > Date.parse(p.expiresAt) || Date.parse(receipt.dispatchedAt) < Date.parse(p.observedAt) ||
        Date.parse(receipt.dispatchedAt) > Date.parse(answer.observedAt))
      throw new Conflict('Luckin order receipt differs from the approved preview; read the original merchant order');
    return stage(order, async graph => {
      const latest = await graph.read(order);
      if (latest.revision !== current.revision) throw new Conflict('The original Luckin preview has changed');
      const priceChanged = receipt.totalMinor !== p.quote.totalMinor;
      const state = priceChanged ? 'price_changed' : receipt.paymentRequired ? 'awaiting_payment' : 'placed';
      await graph.edit(order, latest.revision, { state, merchantOrderId: receipt.orderId,
        merchantAmountMinor: receipt.totalMinor, observedAt: answer.observedAt });
    });
  });
  handlers.set('readLuckinPickup', async (raw, ctx) => {
    const { order } = pickupRefInput.parse(raw);
    if (order.type !== pickupOrderType) throw new Conflict('Reference a Luckin pickup order');
    const { connectionRef: _connection, sourceTaskId: _task, ...details } = pickupOrder.parse((await ctx.objects.read(order)).properties);
    return { order, details };
  });
  return handlers;
}
