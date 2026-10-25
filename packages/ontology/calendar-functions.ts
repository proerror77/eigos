import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import { calendarResultSchema, calendarInputSchema, calendarEntry } from './calendar.js';
import { sourceProof } from './object-evidence.js';
import { objectRefSchema, type ObjectRef } from './model.js';
import type { Computation } from './object-functions.js';
import { linkSnapshotDigest, type OntologyObjectStore, type ReadBudget, type ObjectWrite } from './object-store.js';
import type { AgentActionContext } from '../core/agent-program.js';
import type { CalendarResult } from './calendar.js';

const snapshotSchema = calendarResultSchema.extend({ scope: objectRefSchema.extend({ type: z.literal('CalendarTask') }), bindingDigest: z.string() });
function fail(message: string): never { throw new DomainError('CONFLICT', message); }
export function readCalendar(graph: OntologyObjectStore, owner: string, ref: ObjectRef, historical = false, budget: ReadBudget = { remaining: 5000 }) {
  if (ref.type !== 'CalendarObservation') fail('Expected a calendar source observation');
  const object = graph.read(owner, ref, budget), snapshot = snapshotSchema.parse(object.properties.snapshot), scope = graph.read(owner, snapshot.scope, budget);
  const roots = graph.related(owner, ref, 'request', budget), tasks = graph.related(owner, ref, 'task', budget), proof = sourceProof(graph, owner, ref, budget);
  if (!proof || !proof.levels.every(level => level === snapshot.evidenceLevel) || digest(object.properties.data) !== digest(snapshot.data) || snapshot.receipt.payloadDigest !== digest({ data: snapshot.data, expiresAt: snapshot.expiresAt })
    || snapshot.receipt.ownerDigest !== digest(owner) || roots?.length !== 1 || roots[0]!.ref.id !== snapshot.receipt.requestId || roots[0]!.properties.revision !== snapshot.receipt.requestRevision
    || tasks?.length !== 1 || digest(tasks[0]!.ref) !== digest(snapshot.scope) || scope.properties.bindingDigest !== snapshot.bindingDigest) fail('Calendar evidence differs from its source, owner or task');
  const at = historical ? Date.parse(snapshot.receipt.receivedAt) : graph.now();
  if (Date.parse(snapshot.data.observedAt) > at || Date.parse(snapshot.expiresAt) <= at) fail('Calendar observation is stale');
  const input = calendarInputSchema.parse(scope.properties.input);
  if (input.eventKey !== snapshot.data.eventKey || scope.properties.originalEventId && snapshot.data.providerEventId && scope.properties.originalEventId !== snapshot.data.providerEventId) fail('Calendar source substituted the original event');
  if (!historical) for (const other of graph.related(owner, snapshot.scope, 'observations', budget) ?? []) {
    if (other.ref.id === ref.id) continue;
    const newer = snapshotSchema.parse(other.properties.snapshot);
    const version = (value: string | null) => value?.match(/^version-(\d+)$/)?.[1];
    const newerVersion = version(newer.data.providerVersion), oldVersion = version(snapshot.data.providerVersion);
    if ((Date.parse(newer.receipt.startedAt) > Date.parse(snapshot.receipt.startedAt) || newerVersion && BigInt(newerVersion) > BigInt(oldVersion ?? '0'))
      && digest(newer.data.entry) !== digest(snapshot.data.entry) && sourceProof(graph, owner, other.ref, budget)) fail('A newer calendar read changed the selected arrangement');
  }
  return snapshot;
}
export function calendarStatus(graph: OntologyObjectStore, owner: string, ref: ObjectRef, budget?: ReadBudget) {
  const source = readCalendar(graph, owner, ref, false, budget), scope = graph.read(owner, source.scope, budget), input = calendarInputSchema.parse(scope.properties.input);
  return { data: source.data, independentRead: source.data.independentRead && source.receipt.action === 'ReadCalendarEntry',
    matches: source.data.state === 'present' && digest(source.data.entry) === digest(calendarEntry(input)), evidenceLevel: source.evidenceLevel, validUntil: source.expiresAt };
}
export function evaluateCalendarFunction(graph: OntologyObjectStore, owner: string, input: { function: string; object: ObjectRef }, budget: ReadBudget): Computation | undefined {
  if (input.function !== 'calendarStatus') return;
  try { const result = calendarStatus(graph, owner, input.object, budget); return { status: 'known', value: result, evidenceRefs: [input.object], evidenceLevels: [result.evidenceLevel] }; }
  catch (error) { return { status: 'unknown', reason: error instanceof DomainError ? error.message : 'Calendar evidence is invalid', evidenceRefs: [input.object], evidenceLevels: [] }; }
}
export function projectCalendar(ctx: AgentActionContext, action: string, result: CalendarResult): ObjectRef {
  const receipt = result.receipt;
  if (receipt.ownerDigest !== digest(ctx.owner) || receipt.requestId !== ctx.request.id || receipt.requestRevision !== ctx.request.revision || receipt.planId !== ctx.planId || receipt.intentId !== ctx.intentId
    || receipt.attemptId !== ctx.attemptId || receipt.modelRunId !== ctx.modelRunId || receipt.operationKey !== ctx.operationKey || receipt.action !== action || receipt.payloadDigest !== digest({ data: result.data, expiresAt: result.expiresAt })) fail('Calendar receipt belongs to another operation');
  if (result.data.independentRead !== (action === 'ReadCalendarEntry')) fail('A calendar write receipt cannot become independent readback');
  const ref = { type: 'CalendarObservation', id: receipt.id }, evidence = { type: 'SourceReceipt', id: `calendar:${receipt.id}` }, root = { type: 'ServiceRequest', id: ctx.request.id };
  const properties = { id: ref.id, displayTitle: result.data.entry?.title ?? '日历事项查询', requestRevision: ctx.request.revision, data: result.data, snapshot: { ...result, scope: ctx.state.scope, bindingDigest: ctx.state.programDigest } };
  const links = [{ type: 'CalendarObservationTask', from: ref, to: ctx.state.scope }, { type: 'CalendarObservationRequest', from: ref, to: root }, { type: 'CalendarObservationEvidence', from: ref, to: evidence }, { type: 'ReceiptRequest', from: evidence, to: root }];
  const objects: ObjectWrite[] = [{ ref, properties }, { ref: evidence, properties: { receiptId: evidence.id, displayTitle: '日历来源回执', sourceIdentity: receipt.sourceIdentity, sourceEventId: receipt.id, scope: 'calendar', observedAt: receipt.receivedAt, evidenceLevel: result.evidenceLevel,
    contentDigest: receipt.responseSha256, subjects: [{ object: ref, digest: digest(properties), linksDigest: linkSnapshotDigest(ref, links) }], safeSummary: result.evidenceLevel === 'synthetic' ? '合成日历事项，非用户真实日历' : '已绑定账号的原日历事项回读' } }];
  const scope = ctx.graph.read(ctx.owner, ctx.state.scope);
  if (result.data.providerEventId && !scope.properties.originalEventId) objects.push({ ref: scope.ref, expectedRevision: scope.revision, properties: { ...scope.properties, originalEventId: result.data.providerEventId } });
  ctx.graph.ingest(ctx.owner, { objects, links }, { kind: 'synthetic', id: receipt.sourceIdentity, observedAt: receipt.receivedAt });
  readCalendar(ctx.graph, ctx.owner, ref, action !== 'ReadCalendarEntry');
  return ref;
}
