import { z } from 'zod';
import { Conflict, NotFound, digest } from '../../core/identity.js';
import {
  alipayAgentPayRehearsal, alipayCheckoutTerms, alipayOrderObservation, alipayOrderPaymentLink,
  alipayOrderType, alipayPACapability, alipayPAReply, alipayPARequest, alipayPaymentType, alipayRegistrationInput,
  alipayTransactionObservation,
} from '../../ontology/alipay-agent-pay.js';
import { paymentInput, preparePaymentInput } from '../../ontology/payments.js';
import type { ObjectData, ObjectRef } from '../../ontology/schema.js';
import { json } from '../../ontology/service-contracts.js';
import type { FunctionContext, FunctionHandler, VersionedFunction } from '../../runtime/functions.js';
import { PARequests } from '../../runtime/pa.js';

type Observation = z.infer<typeof alipayOrderObservation>;
type Transaction = z.infer<typeof alipayTransactionObservation>;

export type AlipayRehearsalOrderReader = (owner: string) => Promise<{
  authorityId: string;
  readOrder(merchantOrderId: string, signal: AbortSignal): Promise<Observation>;
  readTransaction(transactionId: string, signal: AbortSignal): Promise<Transaction>;
}>;

function requireEdit(context: FunctionContext) {
  if (!context.edit || context.objects.model.scenario) throw new Conflict('Use the live payment rehearsal Action');
  return context.edit;
}

function checkout(observation: ObjectData['properties']) {
  return alipayCheckoutTerms.strip().parse(observation);
}

function requirePayable(snapshot: Observation) {
  if (snapshot.status !== 'awaiting_payment' || Date.parse(snapshot.expiresAt) <= Date.now())
    throw new Conflict('The original checkout is unavailable for payment');
}

function requireTask(context: FunctionContext) {
  if (!context.execution) throw new Conflict('Prepare and hand off payment from the original PA task');
  return context.execution;
}

export function alipayAgentPayRehearsalFunctions(resolve: AlipayRehearsalOrderReader): VersionedFunction[] {
  async function observe(context: FunctionContext, merchantOrderId: string) {
    const authority = await resolve(context.principal.owner);
    const snapshot = alipayOrderObservation.parse(await authority.readOrder(merchantOrderId, context.signal));
    if (snapshot.merchantOrderId !== merchantOrderId) throw new Conflict('Supplier returned a different order');
    if (Date.parse(snapshot.observedAt) > Date.now() + 5000)
      throw new Conflict('Supplier observation is dated in the future');
    return { authority, snapshot };
  }
  async function readOrder(context: FunctionContext, ref: ObjectRef) {
    if (ref.type !== alipayOrderType) throw new Conflict('Select the original Alipay rehearsal order');
    const order = await context.objects.read(ref), terms = checkout(order.properties);
    const observation = await observe(context, terms.merchantOrderId);
    if (order.properties.authorityId !== observation.authority.authorityId
      || digest(terms) !== digest(checkout(observation.snapshot)))
      throw new Conflict('The original supplier order or checkout terms changed');
    return { terms, ...observation };
  }
  async function readPayment(context: FunctionContext, ref: ObjectRef) {
    if (ref.type !== alipayPaymentType) throw new Conflict('Select the original Alipay rehearsal payment');
    const payment = await context.objects.read(ref), linked = await context.objects.follow(ref, 'order');
    if (linked.length !== 1) throw new Conflict('Payment has no unique original supplier order');
    const order = await readOrder(context, linked[0]!.ref);
    if (digest(checkout(payment.properties)) !== digest(order.terms))
      throw new Conflict('Payment differs from the original supplier order');
    if (order.snapshot.status === 'paid') {
      const transaction = alipayTransactionObservation.parse(await order.authority.readTransaction(order.snapshot.transactionId!, context.signal));
      const { merchantOrderId, merchant, amountMinor, currency, checkoutDigest } = order.terms;
      const expected = { merchantOrderId, merchant, amountMinor, currency, checkoutDigest,
        transactionId: order.snapshot.transactionId, evidence: 'synthetic' };
      if (digest(transaction) !== digest(expected)) throw new Conflict('Payment receipt differs from the original supplier order');
    }
    return { payment, ...order };
  }
  const statusFields = (value: Observation) => ({
    status: value.status, observedAt: value.observedAt, evidence: value.evidence, independentRead: true,
    ...(value.transactionId ? { transactionId: value.transactionId } : {}),
  });
  function recordStatus(context: FunctionContext, ref: ObjectRef, observed: Observation) {
    return requireEdit(context)(ref, async graph => {
      const current = await graph.read(ref);
      if (digest(checkout(current.properties)) !== digest(checkout(observed)))
        throw new Conflict('The recorded checkout changed');
      if (Date.parse(String(current.properties.observedAt)) > Date.parse(observed.observedAt)) return;
      if (current.properties.transactionId && (current.properties.status !== observed.status
        || current.properties.transactionId !== observed.transactionId))
        throw new Conflict('The original payment was already verified with different evidence');
      const update = statusFields(observed);
      if (Object.entries(update).every(([field, value]) => current.properties[field] === value)) return;
      await graph.edit(ref, current.revision, update);
    });
  }

  const handlers = new Map<string, FunctionHandler>([
    ['registerAlipayRehearsalOrder', async (raw, context) => {
      const edit = requireEdit(context);
      const { merchantOrderId } = alipayRegistrationInput.parse(raw);
      const observed = await observe(context, merchantOrderId);
      requirePayable(observed.snapshot);
      const terms = checkout(observed.snapshot);
      const ref = { type: alipayOrderType, id: digest([alipayOrderType, observed.authority.authorityId, merchantOrderId]) };
      return edit(ref, async graph => {
        const previous = await graph.read(ref).catch(error => { if (!(error instanceof NotFound)) throw error; });
        if (previous) {
          if (digest(checkout(previous.properties)) !== digest(terms))
            throw new Conflict('This order already has different checkout terms');
          return;
        }
        await graph.create(ref, { id: ref.id, ...terms, authorityId: observed.authority.authorityId });
      });
    }],
    ['prepareAlipayAgentPayRehearsal', async (raw, context) => {
      const edit = requireEdit(context), { task } = requireTask(context);
      const { order: orderRef } = preparePaymentInput.parse(raw);
      const { terms, snapshot } = await readOrder(context, orderRef);
      const ref = { type: alipayPaymentType, id: digest([orderRef, alipayPaymentType]) };
      return edit(ref, async graph => {
        const existing = (await graph.follow(orderRef, 'payment'))[0];
        if (existing) {
          if (existing.ref.id !== ref.id || existing.properties.taskId !== task.id)
            throw new Conflict('This payment belongs to the original PA task');
          return;
        }
        requirePayable(snapshot);
        await graph.create(ref, { id: ref.id, ...terms, ...statusFields(snapshot), taskId: task.id });
        await graph.link({ type: alipayOrderPaymentLink, from: orderRef, to: ref });
      });
    }],
    ['handoffAlipayAgentPayRehearsal', async (raw, context) => {
      requireEdit(context);
      const { task, tasks } = requireTask(context), { payment: ref } = paymentInput.parse(raw);
      let { payment, terms, snapshot } = await readPayment(context, ref);
      if (payment.properties.taskId !== task.id) throw new Conflict('Use the original PA task for this payment');
      if (snapshot.status === 'awaiting_payment' && Date.parse(snapshot.expiresAt) > Date.now()
        && payment.properties.status === 'awaiting_payment') {
        const reply = alipayPAReply.parse(await new PARequests(tasks).request(task, ref.id, alipayPACapability,
          alipayPARequest.parse({ payment: ref, ...terms, environment: 'synthetic' }), json(alipayPAReply), { payment: ref, checkout: terms.checkoutDigest }));
        if (reply.decision === 'check_status') ({ snapshot } = await readPayment(context, ref));
      }
      return recordStatus(context, ref, snapshot);
    }],
    ['refreshAlipayAgentPayRehearsal', async (raw, context) => {
      requireEdit(context);
      const { payment: ref } = paymentInput.parse(raw);
      return recordStatus(context, ref, (await readPayment(context, ref)).snapshot);
    }],
  ]);
  return alipayAgentPayRehearsal.functionTypes.map(definition => ({
    definition, implementationId: 'alipay-agent-pay-rehearsal-v1', handler: handlers.get(definition.apiName)!,
  }));
}
