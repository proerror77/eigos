import { consentDeadline } from '../security/consent-lifetime.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError, ownerKey, requireScope, type Job, type Principal } from './domain.js';
import { BACKEND_VERSION } from '../ontology/execution.js';
import { DELEGATE, digest } from './delegation.js';
import type { JobStore } from './store.js';
import type { ExecutionCatalog } from './catalog.js';
import { TaskSecurity } from '../security/task-service.js';
import { prepareObservationSchema, type PrepareObservation, type ObservationPins } from '../ontology/observation-contract.js';
import { assertDefinitionJson } from '../ontology/definition-contracts.js';
import { objectRefSchema, type ObjectRef } from '../ontology/model.js';

const conflict = (message: string): never => { throw new DomainError('CONFLICT', message); };
/** Stage one: explicit, inactive delegation only. All actual source input/target
 * binding, polling and execution authorization remain future observer work. */
export class ObservationTasks {
  constructor(private store: JobStore, private catalog: ExecutionCatalog) {}
  prepare(p: Principal, input: unknown, contextId?: string): Job {
    requireScope(p, 'tasks:write'); requireScope(p, 'tasks:read');
    if (!this.store.security.enabled) throw new DomainError('FORBIDDEN', 'Observation contracts require Foundation task and source authority');
    const args = prepareObservationSchema.parse(input), owner = ownerKey(p), security = this.store.security, actor = security.agentContext(p);
    assertDefinitionJson(args.read.input);
    if (Buffer.byteLength(JSON.stringify(args.read.input)) > 16000) throw new DomainError('INVALID_INPUT', 'Observation read input exceeds its bound');
    const tasks = new TaskSecurity(this.store);
    return tasks.submit(p, () => this.store.onceInTransaction(owner, 'prepare_observation_contract', args.requestId,
      digest({ args, contextId, installationId: actor.installationId }), () => {
        tasks.get(p, args.originalTaskId);
        const original = this.store.get(owner, args.originalTaskId);
        if (contextId && contextId !== original.contextId) throw new DomainError('INVALID_INPUT', 'Context does not match the original task');
        if (original.state !== 'completed' || original.delegation?.backendVersion !== BACKEND_VERSION || original.delegation.observationContract
          || original.revision !== args.expectedRevision || original.delegation.recoveryPending) conflict('Select the current completed business task; its history cannot be reopened');
        if (this.store.intents(owner, original.id).some(intent => !['read', 'local'].includes(intent.effect) && ['dispatching', 'awaiting_remote', 'effect_unknown', 'needs_review'].includes(intent.state))) conflict('Reconcile the original business operation before delegating observation');
        const { declaration, pins } = security.withAgent(p, original.id, 'task.query', () => this.validate(p, original, args));
        const id = randomUUID(), at = new Date(security.now()).toISOString();
        const contract = this.store.watchContracts.create(owner, id, declaration, pins);
        const job: Job = { id, contextId: original.contextId, service: DELEGATE, state: 'paused', revision: 1, executionMode: 'worker', goal: args.goal,
          messages: [{ id: args.requestId, role: 'user', text: args.goal, at }], runs: [], createdAt: at, updatedAt: at,
          delegation: { backendVersion: BACKEND_VERSION, ontologyRelease: pins.release, ontologyReadScope: 'request',
            request: { id, revision: 1, originalGoal: args.goal, requirements: [], messages: [{ id: args.requestId, text: args.goal, receivedAt: at }] },
            phase: 'paused', observationContract: { id, digest: contract.digest }, events: [{ at, event: 'observation_contract_configured', evidence: contract.digest }] } };
        this.store.save(owner, job); return job;
      }));
  }
  private validate(p: Principal, original: Job, args: PrepareObservation): { declaration: PrepareObservation; pins: ObservationPins } {
    const owner = ownerKey(p), security = this.store.security, actor = security.agentContext(p), parent = security.agentGrant(actor.installationId);
    const release = this.store.ontologyReleaseForJob(owner, original), document = this.store.definitions.resolve(release).document;
    const selected = document.pipeline?.find(value => value.serviceId === args.source.serviceId);
    if (!selected) throw new DomainError('FORBIDDEN', 'The selected source read is not currently authorized');
    const graph = this.store.ontologyForJob(owner, original), intake = this.store.definitions.pipeline.intake(release.ontologyId, selected);
    const source = security.policies.sources(owner, actor.installationId).find(value => value.programId === intake.programRef.id && value.programDigest === intake.configurationDigest
      && value.operations.includes(args.read.action) && value.outputTypes.includes(args.target.object.type));
    if (!source) throw new DomainError('FORBIDDEN', 'The selected source read is not currently authorized');
    const active = this.store.definitions.active(release.ontologyId).document.pipeline?.find(value => value.serviceId === args.source.serviceId);
    if (active?.intakeDigest !== selected.intakeDigest) conflict('The source mapping changed; select a current source contract');
    if (this.store.definitions.pipeline.validateIntake(release.ontologyId, selected, graph.model).length) conflict('The published mapping needs current validation');
    const mapping = intake.mappings.find(value => value.id === args.source.mappingId) ?? conflict('The selected source mapping is unavailable');
    if (mapping.objectType !== args.target.object.type || args.maxStalenessMs > mapping.maxAgeMs) conflict('The selected object or freshness limit differs from the published mapping');
    const mappedFields = new Set(mapping.fields.map(field => field.to[0]));
    if (args.target.fields.some(field => !mappedFields.has(field))) conflict('Observed fields must be supplied by the selected source mapping');
    const program = this.catalog.forOntology(graph, owner).agentProgram(intake.programRef, owner) ?? conflict('The pinned source program is not configured');
    const definition = program.definition(graph, args.read.action), action = intake.actions.find(value => value.actionId === args.read.action);
    if (program.configurationDigest !== intake.configurationDigest || (program.capability().environment ?? 'local') !== intake.environment || !program.actionIds.includes(args.read.action) || !definition.read || definition.operation
      || definition.read.effect !== 'read' || !action || action.definitionDigest !== digest(definition)) conflict('Observation requires an exact published source read action');
    security.policies.requireResource(security.policies.scope(owner), 'actionType', args.read.action, 'action.execute');
    const until = Math.min(consentDeadline(parent.expiresAt), consentDeadline(source.expiresAt));
    if (Date.parse(args.until) > until) conflict('Observation cannot outlive the current installation and source permission');
    const input = z.record(z.string(), z.unknown()).parse(program.schema(args.read.action).parse(args.read.input));
    assertDefinitionJson(input);
    if (Buffer.byteLength(JSON.stringify(input)) > 16000) conflict('The normalized read input exceeds its bound');
    const target = graph.query(owner, { object: args.target.object, select: args.target.fields }).items[0] ?? conflict('The selected source object is unavailable');
    if (target.revision !== args.target.revision) conflict('The selected source object revision changed');
    for (const relation of args.target.relations) {
      const nav = graph.model.navigation(target.ref.type, relation);
      if (!mapping.links?.some(value => value.linkType === nav.link.id)) conflict('Observed relationships must come from the selected mapping');
      security.policies.requireResource(security.policies.scope(owner), 'linkType', nav.link.id);
    }
    if (args.terminal.kind === 'source_evidence') {
      const property = graph.model.properties(target.ref.type)[args.terminal.field];
      if (!property || !['string', 'boolean', 'integer', 'decimal', 'timestamp'].includes(property.kind) || !property.schema.safeParse(args.terminal.equals).success) conflict('Terminal evidence must match a selected scalar source property');
    }
    // Validate reference visibility without copying source values into the new
    // task or lending the original task's data grant to its guardian.
    const refs = new Map<string, ObjectRef>();
    const walk = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      const ref = objectRefSchema.safeParse(value);
      if (ref.success) { refs.set(digest(ref.data), ref.data); return; }
      for (const child of Object.values(value)) walk(child);
    };
    walk(input);
    if (refs.size > 20) conflict('The read input has too many source references');
    for (const ref of refs.values()) {
      const type = graph.model.object(ref.type);
      graph.query(owner, { object: ref, select: [...new Set([type.primaryKey, type.titleKey])] });
    }
    return { declaration: { ...args, read: { ...args.read, input } }, pins: { release, intakeDigest: selected.intakeDigest,
      sourceRevision: intake.source.revision, sourceDigest: intake.source.digest, programRef: program.ref, configurationDigest: program.configurationDigest,
      actionDigest: digest(definition), inputDigest: digest(input), installationId: actor.installationId, memberId: actor.memberId,
      parentGrant: { id: parent.id, revision: parent.revision }, sourceBindingId: source.bindingId, authEpoch: actor.authEpoch,
      policyVersion: actor.policyVersion, policyRevision: security.policies.revision(), expiresAt: new Date(until).toISOString() } };
  }
}
