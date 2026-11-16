import type { z } from 'zod';
import { Conflict, NotFound, digest } from '../../core/identity.js';
import {
  petRideApproval, petRideData, petRideLookupReply, petRidePA, petRideQuoteReply,
  petRideReceipt, petRideRef, petRideSource, petRideSubmitReply, petRideTerms, petRideType,
} from '../../ontology/pet-ride.js';
import type { ObjectRef } from '../../ontology/schema.js';
import { json } from '../../ontology/service-contracts.js';
import { ActionPARequestRequired, PARequestRequired } from '../../runtime/clarification.js';
import type { Database, Sql } from '../../runtime/database.js';
import { ExternalOperations, UnknownExternalOperation } from '../../runtime/external-operations.js';
import type { FunctionContext, FunctionHandler } from '../../runtime/functions.js';
import { Objects } from '../../runtime/objects.js';
import { PARequests } from '../../runtime/pa.js';

type Handoff = z.infer<typeof petRideData>;
type HandoffUpdate = Pick<Handoff, 'state' | 'quote' | 'submittedOrderId' | 'receipt'>;
const quoteLifetime = 5 * 60_000;
class QuoteExpired extends Conflict {}

function originalTask(ctx: FunctionContext) {
  const execution = ctx.execution;
  if (!ctx.edit || !execution || execution.task.input.scheduledAction || ctx.objects.model.scenario)
    throw new Conflict('Use a formal Action on an interactive PA task for this synthetic trial');
  return execution;
}

async function ask<T extends z.ZodType>(
  ctx: FunctionContext, reference: string, capability: string, input: Record<string, unknown>, output: T,
  beforeDispatch?: (client: Sql) => Promise<void>,
) {
  const { task, tasks } = originalTask(ctx);
  try {
    const reply = await new PARequests(tasks).requestWithId(task, reference, capability,
      { environment: 'synthetic', reference, ...input }, json(output), undefined, beforeDispatch);
    return { ...reply, response: output.parse(reply.response) };
  } catch (error) {
    if (error instanceof PARequestRequired)
      throw new ActionPARequestRequired(error.message, error.choices, error.permissions);
    throw error;
  }
}

async function read(objects: Pick<Objects, 'read'>, handoff: ObjectRef) {
  if (handoff.type !== petRideType) throw new Conflict('Use an original pet ride handoff');
  const row = await objects.read(handoff);
  return { row, value: petRideData.parse(row.properties) };
}

export function petRideFunctions(db: Database): ReadonlyMap<string, FunctionHandler> {
  const operations = new ExternalOperations(db);
  return new Map<string, FunctionHandler>([
    ['preparePetRideHandoff', async (raw, ctx) => {
      const { task } = originalTask(ctx);
      const terms = petRideTerms.parse(raw);
      const ref = { type: petRideType, id: digest([petRideType, task.owner, task.id]) };
      return ctx.edit!(ref, async graph => {
        const prior = await read(graph, ref).catch(error => {
          if (error instanceof NotFound) return undefined;
          throw error;
        });
        if (prior) {
          if (digest(prior.value.terms) !== digest(terms))
            throw new Conflict('The original pet ride task already has different terms');
          return;
        }
        await graph.create(ref, petRideData.parse({ id: ref.id, name: '携宠出行测试', sourceTaskId: task.id,
          terms, state: 'prepared', quote: null, submittedOrderId: null, receipt: null }));
      });
    }],
    ['recordPetRideReceipt', async (raw, ctx) => {
      const { task } = originalTask(ctx), owner = ctx.principal.owner;
      const { handoff } = petRideRef.parse(raw);
      const { row, value } = await read(ctx.objects, handoff);
      if (value.state === 'prepared' && task.id !== value.sourceTaskId)
        throw new Conflict('Only the original PA task can start the synthetic ride');
      const unchanged = () => ctx.edit!(handoff, async () => {});
      if (value.state !== 'prepared' && value.state !== 'unknown') return unchanged();
      if (!ctx.assertDispatch) throw new Conflict('A formal Action must own this handoff');
      const assertDispatch = ctx.assertDispatch;
      const reference = digest([petRideType, handoff.id]);
      const { terms } = value, termsDigest = digest(terms);
      const finish = (update: HandoffUpdate) => ctx.edit!(handoff, async graph => {
        const current = await read(graph, handoff);
        if (current.value.state === 'recorded') return;
        if (current.row.revision !== row.revision) throw new Conflict('The original handoff changed');
        await graph.edit(handoff, row.revision, update);
      });
      let quote = value.quote;
      if (value.state === 'prepared') {
        const offered = await ask(ctx, reference, petRidePA.quote, { terms, termsDigest }, petRideQuoteReply);
        const response = offered.response;
        if (response.reference !== reference || response.termsDigest !== termsDigest)
          throw new Conflict('The quote belongs to a different pet ride');
        if (response.status === 'unavailable')
          return finish({ state: 'unavailable', quote: null, submittedOrderId: null, receipt: null });
        const observed = Date.parse(response.observedAt), expires = Date.parse(response.expiresAt);
        if (response.vehicle !== terms.vehicle || observed < offered.requestedAt.getTime() - 5000 ||
            observed > Date.now() + 5000 || expires <= observed || expires - observed > quoteLifetime)
          throw new Conflict('The PA quote does not match the requested vehicle or validity window');
        quote = response;
      }
      if (!quote) throw new Conflict('The original PA quote is unavailable');
      const approvedQuote = quote, quoteDigest = digest(approvedQuote);
      const scope = { handoff, sourceTaskId: value.sourceTaskId, termsDigest, quoteDigest };
      const guard = async (client: Sql) => {
        await assertDispatch(client);
        ctx.objects.access.source(ctx.objects.model, petRideSource);
        const current = await read(new Objects(db, ctx.objects.model, ctx.objects.access, client), handoff);
        if (current.value.sourceTaskId !== value.sourceTaskId || digest(current.value.terms) !== termsDigest)
          throw new Conflict('The original handoff terms changed');
      };
      const expired = () => finish({ state: 'expired', quote: approvedQuote, submittedOrderId: null, receipt: null });
      const assertFresh = () => {
        if (Date.parse(approvedQuote.expiresAt) <= Date.now()) throw new QuoteExpired('The approved quote expired');
      };
      let submittedOrderId = value.submittedOrderId;
      if (value.state === 'prepared') {
        // An existing dispatch survives quote expiry. Its PA response can still
        // be read on this task, but a second task cannot issue a submit request.
        const dispatch = await operations.inspect(owner, reference);
        if (!dispatch && Date.parse(approvedQuote.expiresAt) <= Date.now()) return expired();
        const approved = (await ask(ctx, reference, petRidePA.approve, {
          terms, quote: approvedQuote, quoteDigest,
        }, petRideApproval)).response;
        if (approved.reference !== reference || approved.quoteDigest !== quoteDigest)
          throw new Conflict('Approval does not match this exact pet ride quote');
        if (approved.decision === 'decline')
          return finish({ state: 'declined', quote: approvedQuote, submittedOrderId: null, receipt: null });
        try {
          const result = (await ask(ctx, reference, petRidePA.submit, {
            terms, quote: approvedQuote, quoteDigest,
          }, petRideSubmitReply, async client => {
            await guard(client);
            assertFresh();
            await operations.claimDispatch(client, owner, reference, scope, ctx.objects,
              { requestId: ctx.operationId, taskId: task.id });
          })).response;
          if (result.reference === reference && result.quoteDigest === quoteDigest)
            submittedOrderId = result.orderId ?? null;
        } catch (error) {
          if (error instanceof QuoteExpired) return expired();
          if (!(error instanceof UnknownExternalOperation)) throw error;
        }
      }
      const receipt = await operations.reconcile(owner, reference, scope, guard, async () => {
        const lookup = await ask(ctx, reference, petRidePA.lookup, {
          termsDigest, quoteDigest, orderId: submittedOrderId,
        }, petRideLookupReply);
        if (lookup.response.status !== 'found') return;
        const evidence = lookup.response.receipt, observed = Date.parse(evidence.observedAt);
        if (evidence.reference === reference && evidence.quoteDigest === quoteDigest &&
            (!submittedOrderId || evidence.orderId === submittedOrderId) &&
            observed >= lookup.requestedAt.getTime() - 5000 && observed <= Date.now() + 5000 &&
            Date.now() - observed <= quoteLifetime) return evidence;
      }, ctx.objects);
      return finish({ state: receipt ? 'recorded' : 'unknown', quote: approvedQuote,
        submittedOrderId, receipt: receipt ? petRideReceipt.parse(receipt) : null });
    }],
    ['readPetRideHandoff', async (raw, ctx) => (await read(ctx.objects, petRideRef.parse(raw).handoff)).value],
  ]);
}
