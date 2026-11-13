import { Conflict, NotFound, digest } from '../../core/identity.js';
import {
  createSandboxOrderInput, paymentInput, paymentReply, preparePaymentInput, recoverSandboxOrderInput,
  sandboxOrderType, stripePaymentType,
} from '../../ontology/payments.js';
import type { ObjectData, ObjectRef } from '../../ontology/schema.js';
import { json } from '../../ontology/service-contracts.js';
import type { Database } from '../../runtime/database.js';
import { ExternalOperations } from '../../runtime/external-operations.js';
import type { FunctionContext, FunctionHandler } from '../../runtime/functions.js';
import { PARequests } from '../../runtime/pa.js';
import { sandboxItem, type PaymentSnapshot, type StripeSandboxResolver } from './stripe-sandbox.js';

function stage(context: FunctionContext) {
  if (!context.edit || context.objects.model.scenario) throw new Conflict('Use a live payment Action');
  return context.edit;
}

function paymentFacts(snapshot: PaymentSnapshot, evidence: 'provider_sandbox' | 'synthetic', independentRead: boolean) {
  return {
    status: snapshot.status, expiresAt: snapshot.expiresAt, observedAt: snapshot.observedAt, evidence, independentRead,
    ...(snapshot.transactionId ? { transactionId: snapshot.transactionId } : {}),
  };
}

export function stripePaymentFunctions(db: Database, resolve: StripeSandboxResolver): ReadonlyMap<string, FunctionHandler> {
  const operations = new ExternalOperations(db);
  const connector = async (context: FunctionContext, order?: ObjectData) => {
    const merchant = await resolve(context.principal.owner);
    if (order && (order.properties.authorityId !== merchant.authorityId || order.properties.merchant !== merchant.merchant))
      throw new Conflict('Stripe sandbox merchant changed');
    return merchant;
  };
  const readOrder = async (context: FunctionContext, orderRef: ObjectRef) => {
    if (orderRef.type !== sandboxOrderType) throw new Conflict('Expected the original Stripe sandbox order');
    const order = await context.objects.read(orderRef);
    const merchant = await connector(context, order);
    const snapshot = await merchant.read(
      String(order.properties.merchantOrderId), String(order.properties.sessionId), context.signal,
    );
    if (snapshot.sessionId !== order.properties.sessionId || snapshot.merchantOrderId !== order.properties.merchantOrderId)
      throw new Conflict('Stripe sandbox payment differs from the original order');
    return { order, merchant, snapshot };
  };
  const readPayment = async (context: FunctionContext, ref: ObjectRef) => {
    if (ref.type !== stripePaymentType) throw new Conflict('Expected the original Stripe Link payment request');
    const payment = await context.objects.read(ref);
    const [order, ...extra] = await context.objects.follow(ref, 'order');
    if (!order || extra.length) throw new Conflict('Payment has no unique original merchant order');
    return { payment, ...await readOrder(context, order.ref) };
  };
  const projectStatus = (
    context: FunctionContext, ref: ObjectRef, snapshot: PaymentSnapshot, evidence: 'provider_sandbox' | 'synthetic',
  ) => stage(context)(ref, async graph => {
    const current = await graph.read(ref);
    if (Date.parse(String(current.properties.observedAt)) > Date.parse(snapshot.observedAt)) return;
    const previous = current.properties.status;
    if (previous === 'paid' || previous === 'paid_other_method') {
      if (snapshot.status !== previous || snapshot.transactionId !== current.properties.transactionId)
        throw new Conflict('Stripe sandbox payment evidence differs from the recorded transaction');
    }
    await graph.edit(ref, current.revision, paymentFacts(snapshot, evidence, true));
  });
  const readIfAvailable = (read: FunctionContext['objects']['read'], ref: ObjectRef) =>
    read(ref).catch(error => {
      if (!(error instanceof NotFound)) throw error;
    });
  const registerOrder = (
    context: FunctionContext, merchant: Awaited<ReturnType<StripeSandboxResolver>>,
    snapshot: Pick<PaymentSnapshot, 'merchantOrderId' | 'sessionId'>,
  ) => {
    const ref = { type: sandboxOrderType, id: snapshot.merchantOrderId };
    return stage(context)(ref, async graph => {
      const current = await readIfAvailable(graph.read.bind(graph), ref);
      if (current) {
        if (current.properties.sessionId !== snapshot.sessionId || current.properties.authorityId !== merchant.authorityId)
          throw new Conflict('Stripe sandbox order already has a different checkout');
        return;
      }
      await graph.create(ref, {
        id: ref.id, ...sandboxItem, merchant: merchant.merchant, merchantOrderId: ref.id,
        authorityId: merchant.authorityId, sessionId: snapshot.sessionId,
      });
    });
  };

  return new Map<string, FunctionHandler>([
    ['createStripeSandboxOrder', async (raw, context) => {
      stage(context);
      const { orderKey } = createSandboxOrderInput.parse(raw);
      if (!context.directAction || !context.assertCurrent) throw new Conflict('The PA must explicitly create the sandbox order');
      context.objects.access.read(context.objects.model, sandboxOrderType);
      const merchant = await connector(context);
      const merchantOrderId = digest(['stripe-sandbox-order', context.principal.owner, orderKey]);
      const existing = await readIfAvailable(context.objects.read.bind(context.objects), { type: sandboxOrderType, id: merchantOrderId });
      if (existing) {
        if (existing.properties.authorityId !== merchant.authorityId) throw new Conflict('Stripe sandbox merchant changed');
        return registerOrder(context, merchant, { merchantOrderId, sessionId: String(existing.properties.sessionId) });
      }
      await merchant.verifyAccount(context.signal);
      const snapshot = await operations.run(
        context.principal.owner, merchantOrderId, { orderKey, authorityId: merchant.authorityId, item: sandboxItem },
        context.assertCurrent, async () => {
          const { checkoutUrl: _checkoutUrl, ...receipt } = await merchant.create(merchantOrderId, context.signal);
          return receipt;
        }, context.objects,
      );
      return registerOrder(context, merchant, snapshot);
    }],
    ['recoverStripeSandboxOrder', async (raw, context) => {
      stage(context);
      if (!context.directAction) throw new Conflict('The PA must explicitly recover the sandbox order');
      const { merchantOrderId, sessionId } = recoverSandboxOrderInput.parse(raw);
      context.objects.access.read(context.objects.model, sandboxOrderType);
      const operation = await operations.inspect(context.principal.owner, merchantOrderId);
      if (operation?.state !== 'unknown' && operation?.state !== 'dispatched')
        throw new Conflict('No unresolved Stripe sandbox operation exists for this PA');
      const merchant = await connector(context);
      const snapshot = await merchant.read(merchantOrderId, sessionId, context.signal);
      return registerOrder(context, merchant, snapshot);
    }],
    ['prepareStripeLinkPayment', async (raw, context) => {
      const edit = stage(context), { order: orderRef } = preparePaymentInput.parse(raw);
      const { order, merchant, snapshot } = await readOrder(context, orderRef);
      const ref = { type: stripePaymentType, id: digest([orderRef, 'manual-payment']) };
      return edit(ref, async graph => {
        if ((await graph.follow(orderRef, 'payment')).some(item => item.ref.id === ref.id)) return;
        if (snapshot.status !== 'awaiting_payment') throw new Conflict('The original Stripe sandbox order is not payable');
        await graph.create(ref, {
          id: ref.id, ...sandboxItem, merchant: merchant.merchant, merchantOrderId: order.properties.merchantOrderId,
          ...paymentFacts(snapshot, merchant.evidence, true),
        });
        await graph.link({ type: 'SandboxOrderPayment', from: orderRef, to: ref });
      });
    }],
    ['handoffStripeLinkPayment', async (raw, context) => {
      stage(context);
      const { payment: ref } = paymentInput.parse(raw), execution = context.execution;
      if (!execution) throw new Conflict('Hand off Stripe Link from the original PA task');
      const { merchant, snapshot } = await readPayment(context, ref);
      if (snapshot.status === 'awaiting_payment') {
        const decision = paymentReply.parse(await new PARequests(execution.tasks).request(
          execution.task, ref.id, 'payments.manual_checkout', {
            payment: ref, merchant: merchant.merchant, merchantOrderId: snapshot.merchantOrderId,
            ...sandboxItem, expiresAt: snapshot.expiresAt, checkoutUrl: snapshot.checkoutUrl,
            environment: 'sandbox', paymentMethod: 'stripe_link',
            instruction: 'Show this Stripe sandbox checkout to the user. The user pays manually using their own sandbox Link wallet.',
          }, json(paymentReply), { payment: ref, session: snapshot.sessionId },
        ));
        if (decision.decision === 'check_status') {
          const current = await readPayment(context, ref);
          return projectStatus(context, ref, current.snapshot, current.merchant.evidence);
        }
      }
      return projectStatus(context, ref, snapshot, merchant.evidence);
    }],
    ['refreshStripeLinkPayment', async (raw, context) => {
      stage(context);
      const { payment: ref } = paymentInput.parse(raw);
      const { snapshot, merchant } = await readPayment(context, ref);
      return projectStatus(context, ref, snapshot, merchant.evidence);
    }],
  ]);
}
