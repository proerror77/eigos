import { z } from 'zod';
import { Conflict, NotFound, digest } from '../../core/identity.js';
import {
  alipayAgentPayRehearsal, alipayCheckoutTerms, alipayOrderObservation, alipayOrderPaymentLink,
  alipayOrderType, alipayPACapability, alipayPAReply, alipayPARequest, alipayPaymentType, alipayRegistrationInput,
  alipayPaymentResult, alipayRehearsalSource, alipaySubmission, alipayTransactionObservation,
} from '../../ontology/alipay-agent-pay.js';
import { paymentInput, preparePaymentInput } from '../../ontology/payments.js';
import type { ObjectData, ObjectRef } from '../../ontology/schema.js';
import { json } from '../../ontology/service-contracts.js';
import type { FunctionContext, FunctionHandler, VersionedFunction } from '../../runtime/functions.js';
import { ActionPARequestRequired, PARequestRequired } from '../../runtime/clarification.js';
import { ExternalOperations, UnknownExternalOperation } from '../../runtime/external-operations.js';
import { Objects } from '../../runtime/objects.js';
import { PARequests } from '../../runtime/pa.js';

type Observation = z.infer<typeof alipayOrderObservation>;
type Transaction = z.infer<typeof alipayTransactionObservation>;
type Terms = z.infer<typeof alipayCheckoutTerms>;
type Submission = z.infer<typeof alipaySubmission>;
type SubmissionState = NonNullable<z.infer<typeof alipayPaymentResult>['submissionState']>;

export type AlipayRehearsalAuthority = (owner: string) => Promise<{
  authorityId: string;
  readOrder(merchantOrderId: string, signal: AbortSignal): Promise<Observation>;
  readTransaction(transactionId: string, signal: AbortSignal): Promise<Transaction>;
  submitPayment(terms: Terms, operationId: string, signal: AbortSignal): Promise<Submission>;
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
  if (!context.execution) throw new Conflict('Use the original interactive task to prepare this payment');
  return context.execution;
}

export function alipayAgentPayRehearsalFunctions(resolve: AlipayRehearsalAuthority): VersionedFunction[] {
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
    return { order, terms, ...observation };
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
  function recordStatus(context: FunctionContext, ref: ObjectRef, observed: Observation, submissionState?: SubmissionState) {
    return requireEdit(context)(ref, async graph => {
      const current = await graph.read(ref);
      if (digest(checkout(current.properties)) !== digest(checkout(observed)))
        throw new Conflict('The recorded checkout changed');
      const stale = Date.parse(String(current.properties.observedAt)) > Date.parse(observed.observedAt);
      if (!stale && current.properties.transactionId && (current.properties.status !== observed.status
        || current.properties.transactionId !== observed.transactionId))
        throw new Conflict('The original payment was already verified with different evidence');
      const update = {
        ...(stale ? {} : statusFields(observed)),
        ...(submissionState && current.properties.submissionState !== 'accepted' ? { submissionState } : {}),
      };
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
    ['submitAlipayAgentPayRehearsal', async (raw, context) => {
      requireEdit(context);
      const { task, tasks } = requireTask(context), { payment: ref } = paymentInput.parse(raw);
      const assertDispatch = context.assertDispatch;
      if (!assertDispatch || task.input.scheduledAction || task.cognitive_context)
        throw new Conflict('Use the original interactive task for payment approval');
      const current = await readPayment(context, ref);
      if (current.payment.properties.taskId !== task.id) throw new Conflict('Use the original task for this payment');
      const { owner } = context.principal;
      const db = tasks.db, operations = new ExternalOperations(db);
      const key = 'alipay-rehearsal:' + ref.id;
      const scope = { payment: ref, taskId: task.id, authorityId: current.authority.authorityId, terms: current.terms };
      try {
        if (await operations.recover<Submission>(owner, key, scope, context.objects))
          return recordStatus(context, ref, current.snapshot, 'accepted');
      } catch (error) {
        if (!(error instanceof UnknownExternalOperation)) throw error;
        return recordStatus(context, ref, current.snapshot, 'unknown');
      }
      requirePayable(current.snapshot);
      const termsDigest = digest(scope);
      const input = alipayPARequest.parse({ payment: ref, ...current.terms, termsDigest, environment: 'synthetic' });
      try {
        const reply = alipayPAReply.parse(await new PARequests(tasks).request(task, termsDigest, alipayPACapability, input, json(alipayPAReply)));
        if (reply.termsDigest !== termsDigest) throw new Conflict('Approval does not match this payment');
        if (reply.decision === 'decline') return recordStatus(context, ref, current.snapshot, 'declined');
      } catch (error) {
        if (error instanceof PARequestRequired) throw new ActionPARequestRequired(error.message, error.choices, error.permissions);
        throw error;
      }
      const approved = await readPayment(context, ref);
      requirePayable(approved.snapshot);
      if (approved.authority.authorityId !== current.authority.authorityId || digest(approved.terms) !== digest(current.terms))
        throw new Conflict('The approved supplier order changed');
      try {
        await operations.run(owner, key, scope, async client => {
          await assertDispatch(client);
          context.objects.access.source(context.objects.model, alipayRehearsalSource);
          const graph = new Objects(db, context.objects.model, context.objects.access, client);
          const [payment, order] = await Promise.all([graph.read(ref), graph.read(approved.order.ref)]);
          if (payment.revision !== approved.payment.revision || order.revision !== approved.order.revision)
            throw new Conflict('The original order or payment changed before submission');
          if ((await resolve(owner)).authorityId !== approved.authority.authorityId)
            throw new Conflict('The payment connection changed before submission');
          requirePayable(approved.snapshot);
        }, async () => {
          context.signal.throwIfAborted();
          const result = alipaySubmission.parse(await approved.authority.submitPayment(approved.terms, key, context.signal));
          if (result.merchantOrderId !== approved.terms.merchantOrderId || result.checkoutDigest !== approved.terms.checkoutDigest)
            throw new Conflict('Payment submission refers to a different supplier order');
          return result;
        }, context.objects, { requestId: context.operationId, taskId: task.id });
      } catch (error) {
        if (!(error instanceof UnknownExternalOperation)) throw error;
        return recordStatus(context, ref, approved.snapshot, 'unknown');
      }
      return recordStatus(context, ref, approved.snapshot, 'accepted');
    }],
    ['refreshAlipayAgentPayRehearsal', async (raw, context) => {
      requireEdit(context);
      const { payment: ref } = paymentInput.parse(raw);
      return recordStatus(context, ref, (await readPayment(context, ref)).snapshot);
    }],
    ['readAlipayAgentPayRehearsal', async (raw, context) => {
      const { payment } = paymentInput.parse(raw);
      if (payment.type !== alipayPaymentType) throw new Conflict('Select the original Alipay rehearsal payment');
      const row = await context.objects.read(payment);
      return alipayPaymentResult.strip().parse({ payment, ...row.properties });
    }],
  ]);
  return alipayAgentPayRehearsal.functionTypes.map(definition => ({
    definition, implementationId: 'alipay-agent-pay-rehearsal-v1', handler: handlers.get(definition.apiName)!,
  }));
}
