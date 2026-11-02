import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ParticipantBookingProgram } from '../../packages/capabilities/free-booking/program.js';
import { securityFixture } from './security.js';
import { participantFixture } from './free-booking.js';
import { securedProgramFixture } from './secured-program.js';
import { participantIntake } from './ontology-pipeline.js';
import { OntologyObjectStore } from '../../packages/ontology/object-store.js';
import type { PrepareObservation } from '../../packages/ontology/observation-contract.js';

/** Known synthetic source data and a completed fixture task. No model, source
 * call, business operation or live account is used to prepare a contract. */
export function observationContractFixture() {
  const source = participantFixture();
  let sourceCalls = 0;
  source.source.call = async () => { sourceCalls++; throw new Error('Contract preparation must not call a provider'); };
  const f = securedProgramFixture(() => new ParticipantBookingProgram(source.source), source.input, () => { throw new Error('No model may run for a contract'); }, securityFixture(() => Date.now()));
  const graph = f.jobs.ontology, now = Date.now(), at = new Date(now).toISOString();
  const intake = participantIntake(graph.model, f.program);
  const event = { type: 'Event', id: 'private-synthetic-event' }, scope = { type: 'RegistrationTask', id: 'private-synthetic-read-scope' };
  const fields = ['displayTitle', 'title', 'serviceUrl', 'kind', 'startsAt', 'endsAt', 'timeZone'];
  const values = { displayTitle: 'Synthetic event', title: 'Synthetic event', serviceUrl: 'https://luma.com/synthetic-watch', kind: 'event_registration',
    startsAt: new Date(now + 86400000).toISOString(), endsAt: new Date(now + 90000000).toISOString(), timeZone: 'Asia/Shanghai' };
  intake.mappings = [{ id: 'event', objectType: 'Event', nativeId: ['native'], maxAgeMs: 300000, fields: fields.map(field => ({ from: [field], to: [field], optional: false })) }];
  intake.fixtures = [{ mappingId: 'event', input: { native: 'private-native', ...values }, expected: values }];
  const namespace = f.jobs.definitions.namespace('eigos.business');
  let draft = f.jobs.definitions.createDraft(f.owner, namespace.id, 'Synthetic watch mapping', true);
  draft = f.jobs.definitions.putPipeline(f.owner, draft.id, draft.revision, intake, true);
  f.jobs.definitions.validatePipeline(f.owner, draft.id, draft.revision, intake.serviceId, new Date(now + 3600000).toISOString(), true);
  const release = f.jobs.definitions.publish(f.owner, draft.id, draft.revision, true).release;
  f.jobs.definitions.activate(f.owner, release, namespace.generation, true);
  const originalView = f.tasks.submit(f.p, { goal: 'Synthetic completed activity request', requestId: randomUUID(), capabilityRef: f.program.ref });
  const original = f.jobs.get(f.owner, originalView.id), db = new DatabaseSync(f.database), receipt = { type: 'SourceReceipt', id: 'synthetic-event-receipt' };
  const raw = new OntologyObjectStore(db, graph.model, Date.now, undefined, { skipLegacyMigration: true });
  raw.ingest(f.owner, { objects: [
    { ref: receipt, properties: { receiptId: receipt.id, displayTitle: 'Synthetic receipt', safeSummary: 'Synthetic source only', evidenceLevel: 'synthetic' } },
    { ref: event, properties: { [graph.model.object(event.type).primaryKey]: event.id, ...values } },
    { ref: scope, properties: { id: scope.id, displayTitle: 'Synthetic scope', requestRevision: 1, input: source.input, bindingDigest: f.program.configurationDigest, allowedActions: ['InspectRegistrationPage'] } },
  ], links: [{ type: 'EventEvidence', from: event, to: receipt }, { type: 'RegistrationTaskRequest', from: scope, to: { type: 'ServiceRequest', id: original.id } }] }, { kind: 'synthetic', id: 'observation-contract-fixture', observedAt: at });
  const old = f.jobs.security.taskGrant(f.jobs.security.agentContext(f.p), original.id);
  f.jobs.security.revokeGrant(f.owner, old.id, old.revision);
  const grant = f.jobs.security.issueTaskGrant({ ...old, id: randomUUID(), inputs: [
    { object: event, objectRevision: 1, fields: [graph.model.object(event.type).primaryKey, ...fields] }, { object: scope, objectRevision: 1, fields: ['id', 'displayTitle'] },
  ], operations: ['task.process', 'task.query', 'task.result.read', 'member_asset.read'] });
  original.state = 'completed'; original.delegation!.phase = 'accepted'; f.jobs.save(f.owner, original);
  const input = (): PrepareObservation => ({ action: 'prepare_observation_contract', originalTaskId: original.id, expectedRevision: original.revision!, requestId: randomUUID(), goal: 'Watch an explicitly selected synthetic event',
    source: { serviceId: intake.serviceId, mappingId: 'event', expectedSourceAccount: 'PRIVATE_ACCOUNT', expectedNativeId: 'PRIVATE_NATIVE' },
    target: { object: event, revision: 1, fields: ['title', 'startsAt'], relations: [] }, read: { action: 'InspectRegistrationPage', input: { scope } },
    startsAt: new Date().toISOString(), until: new Date(Date.now() + 60000).toISOString(), maxStalenessMs: 60000, strategy: { mode: 'poll', intervalMs: 10000 },
    terminal: { kind: 'horizon_only' }, perReadBudget: { timeoutMs: 1000, maxCost: { minor: '0', currency: 'CNY' } },
    lifetimeBudget: { maxReads: 10, maxModelTurns: 4, maxActiveMs: 10000, maxCost: { minor: '0', currency: 'CNY' } } });
  return { ...f, input, original, grant, event, scope, release, intake, raw, db, sourceCalls: () => sourceCalls, close: () => { db.close(); f.close(); source.store.close(); } };
}
