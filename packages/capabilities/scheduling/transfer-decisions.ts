import { scenarioDecisionApprovalSchema } from '../../ontology/scenario-decision.js';
import { Conflict, NotFound, digest } from '../../core/identity.js';
import {
  reviewTransferInput, transferDecisionType, transferEvidenceLink, transferJudgmentSchema, transferObservation,
  transferObservationFunction, transferObservationInput, transferObservationSource, transferObservationType,
  transferOfferLink, transferPlanLink, transferResultSchema,
} from '../../ontology/hotel-transfer-decisions.js';
import { transferLessonReference, type ScenarioDecisionMemory } from '../../ontology/scenario-decision.js';
import type { ObjectData, ObjectRef } from '../../ontology/schema.js';
import { Access, PermissionDenied } from '../../runtime/access.js';
import type { Database } from '../../runtime/database.js';
import type { FunctionHandler } from '../../runtime/functions.js';
import { Objects } from '../../runtime/objects.js';
import type { ScenarioDecisionContext, ScenarioDecisionSupport } from '../../runtime/scenarios.js';
import type { SourceProjection } from '../../runtime/sources.js';
import { z } from 'zod';

const minute = 60_000;
const offerType = 'RollingGoHotelOffer';
const routeSlot = z.object({ start: z.iso.datetime({ offset: true }), end: z.iso.datetime({ offset: true }) });
const matchFields = ['nativeId', 'bindingId', 'checkIn', 'evidence'];
const equal = (a: ObjectRef, b: ObjectRef) => a.type === b.type && a.id === b.id;
const denied = (error: unknown) => error instanceof PermissionDenied || error instanceof NotFound;

// Reuse Scenario's cross-account review policy: the author owns the data, and the invited reviewer
// must also be able to read the row and every field shown in the review.
function visible(graph: Objects, reviewer: Access, item: ObjectData, fields: readonly string[]) {
  reviewer.readRow(graph.model, item.ref.type, item.properties);
  if (fields.some(field => item.properties[field] == null || !reviewer.cell(graph.model, item.ref.type, field, item.properties))) {
    throw new PermissionDenied('Decision evidence requires visible properties');
  }
}
function localSlot(value: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const get = (key: string) => parts.find(part => part.type === key)!.value;
  return { date: [get('year'), get('month'), get('day')].join('-'), hour: get('hour') };
}

async function reviewTarget(db: Database, { model, owner, reviewer, client, review }: ScenarioDecisionContext) {
  if (!db.sandboxEnabled || !model.objects.has(transferDecisionType)) return;
  const offers = review.links.filter(link => !link.removed && link.type === offerType + 'Plan');
  if (offers.length !== 1) return;
  const { from: offerRef, to: planRef } = offers[0]!;
  const slots = review.links.filter(link => !link.removed && link.type === 'ActivityPlan' && equal(link.to, planRef));
  if (slots.length !== 1) return;
  const proposed = review.objects.find(change => equal(change.ref, slots[0]!.from));
  const slot = routeSlot.safeParse(proposed?.after);
  if (!slot.success || Date.parse(slot.data.end) <= Date.parse(slot.data.start)) return;
  const author = await Access.load(db, { owner, scopes: [] }, client);
  const graph = new Objects(db, model, author, client);
  const plan = await graph.read(planRef), offer = await graph.read(offerRef);
  visible(graph, reviewer, plan, ['timeZone']);
  visible(graph, reviewer, offer, matchFields);
  author.source(model, 'RollingGo');
  reviewer.source(model, 'RollingGo');
  reviewer.read(model, transferDecisionType);
  if (offer.properties.evidence !== 'synthetic') return;
  const proposedPlan = review.objects.find(change => equal(change.ref, planRef));
  const timeZone = String(proposedPlan?.after?.timeZone ?? plan.properties.timeZone);
  const { date, hour } = localSlot(slot.data.start, timeZone);
  if (date !== offer.properties.checkIn) return;
  const matchKey = digest([offer.properties.bindingId, offer.properties.nativeId, timeZone, hour]);
  return { graph, planRef, offerRef, date, matchKey, departure: slot.data.start, arriveBy: slot.data.end };
}

async function priorLesson(graph: Objects, reviewer: Access, item: ObjectData): Promise<ScenarioDecisionMemory['prior'][number] | undefined> {
  if (!item.properties.result) return;
  try {
    visible(graph, reviewer, item, ['date', 'judgment', 'result']);
    const result = transferResultSchema.parse(item.properties.result);
    const judgment = transferJudgmentSchema.parse(item.properties.judgment);
    const [plan] = await graph.follow(item.ref, 'plan');
    const [offer] = await graph.follow(item.ref, 'offer');
    const [observation] = await graph.follow(item.ref, 'observation');
    if (!plan || !offer || !observation || observation.revision !== result.observationRevision) return;
    for (const link of [transferPlanLink, transferOfferLink, transferEvidenceLink]) reviewer.definition(graph.model, 'link', link);
    reviewer.source(graph.model, transferObservationSource);
    graph.access.source(graph.model, transferObservationSource);
    visible(graph, reviewer, plan, ['timeZone']);
    visible(graph, reviewer, offer, matchFields);
    visible(graph, reviewer, observation, Object.keys(transferObservation.shape));
    if (digest(transferObservation.parse(observation.properties)) !== result.observationDigest) return;
    const { expectedBufferMinutes, ...decisionJudgment } = judgment;
    return {
      decision: item.ref, version: digest(result), date: String(item.properties.date),
      judgment: decisionJudgment, expectedBufferMinutes,
      actualTravelMinutes: result.actualTravelMinutes, actualBufferMinutes: result.actualBufferMinutes,
      assessment: result.assessment, lesson: result.lesson, appliesWhen: result.appliesWhen,
    };
  } catch (error) {
    if (!denied(error)) throw error;
  }
}

function decisionRef({ review, reviewer }: ScenarioDecisionContext) {
  return { type: transferDecisionType, id: digest([review.id, review.revision, review.snapshot, reviewer.principal.owner]) };
}

async function adoptedLessonIsCurrent(
  { graph, date, matchKey }: NonNullable<Awaited<ReturnType<typeof reviewTarget>>>,
  reviewer: Access, reference: z.output<typeof transferLessonReference>,
) {
  if (reference.decision.type !== transferDecisionType) return false;
  const decision = await graph.read(reference.decision);
  visible(graph, reviewer, decision, ['date', 'matchKey', 'reviewer']);
  if (decision.properties.matchKey !== matchKey || String(decision.properties.date) >= date ||
      decision.properties.reviewer !== reviewer.principal.owner) return false;
  const lesson = await priorLesson(graph, reviewer, decision);
  return Boolean(lesson && lesson.assessment !== 'insufficient' && lesson.version === reference.version);
}

export function transferDecisionSupport(db: Database): ScenarioDecisionSupport {
  return {
    parseDecision: input => scenarioDecisionApprovalSchema.parse(input),
    async inspect(context) {
      try {
        const target = await reviewTarget(db, context);
        if (!target) return;
        const { graph, date, matchKey, departure, arriveBy } = target;
        const candidates = await graph.query({
          type: transferDecisionType, where: { matchKey, reviewer: context.reviewer.principal.owner },
          filter: { op: 'lt', property: 'date', value: date },
          orderBy: [{ property: 'date', direction: 'desc' }], limit: 20,
        });
        const prior = [];
        for (const item of candidates.items) {
          const lesson = await priorLesson(graph, context.reviewer, item);
          if (lesson) prior.push(lesson);
          if (prior.length === 3) break;
        }
        await graph.access.refresh(context.client);
        return { departure, arriveBy, prior };
      } catch (error) {
        if (!denied(error)) throw error;
      }
    },
    async capture(context, raw, approvedAt) {
      const target = await reviewTarget(db, context);
      if (!target) throw new Conflict('This Scenario has no eligible synthetic hotel transfer');
      const { graph, planRef, offerRef, date, matchKey, departure, arriveBy } = target;
      const { adoptedLesson, ...judgment } = raw;
      if (adoptedLesson && !await adoptedLessonIsCurrent(target, context.reviewer, adoptedLesson)) {
        throw new Conflict('The adopted transfer lesson is no longer applicable or verified');
      }
      const expectedBufferMinutes = (Date.parse(arriveBy) - Date.parse(departure)) / minute - judgment.expectedTravelMinutes;
      if (expectedBufferMinutes < 0) throw new Conflict('The expected travel time does not fit the reviewed slot');
      const { review, reviewer } = context;
      const decision = decisionRef(context);
      const recorded = { judgment: { ...judgment, expectedBufferMinutes }, ...(adoptedLesson ? { adoptedLesson } : {}) };
      if (!approvedAt) {
        const existing = await graph.read(decision).catch(error => {
          if (!(error instanceof NotFound)) throw error;
        });
        const prior = { judgment: existing?.properties.judgment, adoptedLesson: existing?.properties.adoptedLesson };
        if (digest(prior) !== digest(recorded)) {
          throw new Conflict('The decision must match the reason captured at the original approval');
        }
        return;
      }
      if (approvedAt.getTime() > Date.parse(departure)) throw new Conflict('Capture the decision before departure');
      const writer = new Objects(db, graph.model, graph.access, context.client, {
        executor: { kind: 'client', id: reviewer.principal.owner },
      });
      await writer.create(decision, {
        id: decision.id, name: 'Hotel transfer ' + date, date, matchKey, scenarioId: review.id, scenarioRevision: review.revision,
        release: graph.model.release, snapshot: review.snapshot, reviewer: reviewer.principal.owner,
        approvedAt: approvedAt.toISOString(), departure, arriveBy,
        verifyBy: new Date(Date.parse(arriveBy) + 60 * minute).toISOString(),
        evidence: 'synthetic', ...recorded,
      });
      await writer.linkBatch([
        { type: transferPlanLink, from: decision, to: planRef },
        { type: transferOfferLink, from: decision, to: offerRef },
      ]);
      await graph.access.refresh(context.client);
    },
    async validateApproval(context) {
      const { model, owner, client, reviewer } = context;
      if (!model.objects.get(transferDecisionType)?.properties.adoptedLesson) return true;
      const ref = decisionRef(context);
      // Approvals that did not cite a lesson do not require access to the transfer pilot.
      const recorded = await db.query(
        `SELECT 1 FROM ${db.schema}.objects
          WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4 AND properties ? 'adoptedLesson'`,
        [model.projection, owner, ref.type, ref.id], client,
      );
      if (!recorded.rowCount) return true;
      const target = await reviewTarget(db, context);
      if (!target) return false;
      const source = await target.graph.read(ref);
      const adoption = transferLessonReference.safeParse(source.properties.adoptedLesson);
      return adoption.success && await adoptedLessonIsCurrent(target, reviewer, adoption.data);
    },
  };
}

export function transferDecisionFunctions(): ReadonlyMap<string, FunctionHandler> {
  return new Map<string, FunctionHandler>([
    [transferObservationFunction, async (raw, { objects }) => {
      const { observation } = transferObservationInput.parse(raw);
      if (observation.type !== transferObservationType) throw new Conflict('A transfer observation is required');
      return transferObservation.parse((await objects.read(observation)).properties);
    }],
    ['reviewHotelTransferOutcome', async (raw, context) => {
      const { decision, revision, observation, ...retrospect } = reviewTransferInput.parse(raw);
      if (!context.edit || context.objects.model.scenario || context.execution) {
        throw new Conflict('Confirm a transfer retrospective through the live Action as a reviewer');
      }
      return context.edit(decision, async graph => {
        graph.access.source(graph.model, transferObservationSource);
        const current = await graph.read(decision), evidence = await graph.read(observation);
        if (current.properties.result) throw new Conflict('This transfer retrospective is already confirmed');
        const fact = transferObservation.parse(evidence.properties);
        const departed = Date.parse(fact.departedAt), arrived = Date.parse(fact.arrivedAt), observed = Date.parse(fact.observedAt);
        const deadline = Date.parse(String(current.properties.arriveBy));
        if (fact.decisionId !== decision.id || departed < Date.parse(String(current.properties.approvedAt)) ||
            arrived <= departed || arrived > observed || observed < deadline ||
            observed > Date.parse(String(current.properties.verifyBy))) {
          throw new Conflict('Independent observation does not match the approved transfer or verification window');
        }
        await graph.edit(decision, revision, { result: {
          ...retrospect, actualTravelMinutes: (arrived - departed) / minute, actualBufferMinutes: (deadline - arrived) / minute,
          observationRevision: evidence.revision, observationDigest: digest(fact),
          reviewer: context.principal.owner, reviewedAt: new Date().toISOString(),
        } });
        await graph.link({ type: transferEvidenceLink, from: decision, to: observation });
      });
    }],
  ]);
}

/** The observation contract is a producer feed. Its writes use the ordinary Indexer submission path. */
export const transferObservationProjection: SourceProjection = {
  async assertCurrent() { throw new Conflict('Submit the synthetic observation through its authenticated producer feed'); },
  async apply() { throw new Conflict('Submit the synthetic observation through its authenticated producer feed'); },
};
