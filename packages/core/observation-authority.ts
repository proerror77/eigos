import { DomainError, ownerKey, type Principal } from './domain.js';
import { digest } from './delegation.js';
import type { JobStore } from './store.js';
import type { ExecutionCatalog } from './catalog.js';
import { moneySchema } from '../ontology/execution.js';
import { SecurityError } from '../security/store.js';
import type { ObservationRuntimeState, ObservationTarget } from '../ontology/observation-runtime.js';

function deny(): never { throw new DomainError('FORBIDDEN', 'Observation source authority or binding is unavailable'); }
/** Delegated observer-only authorization. It uses the existing controller,
 * subject, source, field and channel policies; it grants no Agent executor or
 * consumer access to canonical source facts. */
export class ObservationAuthority {
  constructor(private store: JobStore, private catalog: ExecutionCatalog) {}
  validate(owner: string, taskId: string, principal: Principal) {
    const contract = this.store.watchContracts.get(owner, taskId), p = contract.pins, security = this.store.security;
    const actor = security.agentContext(principal), parent = security.agentGrant(actor.installationId), d = contract.declaration;
    if (ownerKey(principal) !== owner || actor.installationId !== p.installationId || actor.memberId !== p.memberId || actor.authEpoch !== p.authEpoch
      || parent.id !== p.parentGrant.id || parent.revision !== p.parentGrant.revision || contract.status !== 'configured'
      || Date.parse(d.until) <= security.now() || Date.parse(p.expiresAt) <= security.now()) deny();
    return security.withAgent(principal, taskId, 'task.process', scope => {
      if (!scope.grant?.operations.includes('task.result.read') || !scope.grant.channels.includes('agent_response')) deny();
      const release = this.store.definitions.resolve(p.release), ref = release.document.pipeline?.find(value => value.serviceId === d.source.serviceId);
      const active = this.store.definitions.active(p.release.ontologyId).document.pipeline?.find(value => value.serviceId === d.source.serviceId);
      if (!ref || ref.intakeDigest !== p.intakeDigest || active?.intakeDigest !== ref.intakeDigest) deny();
      const intake = this.store.definitions.pipeline.intake(p.release.ontologyId, ref), mapping = intake.mappings.find(value => value.id === d.source.mappingId);
      if (!mapping || mapping.objectType !== d.target.object.type || this.store.definitions.pipeline.validateIntake(p.release.ontologyId, ref, release.model).length) deny();
      const program = this.catalog.configuredProgram(p.programRef, owner), adapter = this.catalog.observationAdapter(p.programRef, owner);
      const definition = release.model.action(d.read.action);
      if (!program || !adapter || program.configurationDigest !== p.configurationDigest || intake.configurationDigest !== p.configurationDigest
        || digest(definition) !== p.actionDigest || !definition.read || definition.operation || !program.actionIds.includes(d.read.action)) deny();
      security.policies.requireResource(scope, 'actionType', d.read.action, 'action.execute');
      security.policies.requireResource(scope, 'objectType', mapping.objectType);
      const source = security.policies.sources(owner, actor.installationId).find(value => value.bindingId === p.sourceBindingId && value.programId === p.programRef.id
        && value.programDigest === p.configurationDigest && value.operations.includes(d.read.action) && value.outputTypes.includes(mapping.objectType));
      if (!source) deny();
      const type = release.model.object(mapping.objectType), fields = [...new Set([type.primaryKey, type.titleKey, ...mapping.fields.map(field => field.to[0]!)])];
      if (fields.some(field => !parent.resources.some(resource => resource.type === type.id && resource.fields.includes(field)) || security.policies.fieldPolicy(type.id, field) === 'internal_only')) deny();
      const graph = this.store.observationProducer(p.release), object = graph.readPrivate(owner, d.target.object);
      // This is producer qualification, not a consumer read or regrant. Keep
      // field classification/markings/channel restrictions, without pretending
      // that the control-only guardian consumed an existing fact version.
      const labels = security.policies.envelope(owner, object.ref, object.revision, fields, {}, scope.grant.channels);
      security.policies.requireRecipient(scope, { ...labels, lineage: [] }, 'agent_response');
      for (const link of mapping.links ?? []) security.policies.requireResource(scope, 'linkType', link.linkType);
      const cost = moneySchema.parse(adapter.maximumCost);
      if (cost.currency !== d.perReadBudget.maxCost.currency || BigInt(cost.minor) > BigInt(d.perReadBudget.maxCost.minor)) deny();
      if (release.model.implements(type.id, 'EvidenceBacked') && !adapter.evidenceScope) deny();
      scope.assertCurrent();
      return { contract, intake, mapping, adapter, object, graph, cost };
    });
  }
  bind(owner: string, taskId: string, principal: Principal) {
    const bound = this.validate(owner, taskId, principal), d = bound.contract.declaration;
    const selected = this.store.security.withAgent(principal, d.originalTaskId, 'task.query', () =>
      this.store.ontologyForJob(owner, d.originalTaskId).query(owner, { object: d.target.object, select: d.target.fields }).items[0]);
    if (!selected || selected.revision !== d.target.revision) return deny();
    const target = bound.adapter.bind({ owner, declaration: structuredClone(d), object: structuredClone(selected), mapping: bound.mapping, source: bound.intake.source });
    this.assertTarget(owner, target, bound);
    return { ...bound, target, bindingDigest: digest({ pins: bound.contract.pins, adapter: bound.adapter.ref, target, cost: bound.cost, evidenceScope: bound.adapter.evidenceScope ?? null }) };
  }
  checked(owner: string, taskId: string, runtimeId: string, allowEnding = false) {
    const runtime = this.store.watchContracts.runtime(owner, taskId);
    if (!runtime || runtime.id !== runtimeId || runtime.state !== 'active' && !(allowEnding && ['paused', 'ended'].includes(runtime.state))) return deny();
    const bound = this.validate(owner, taskId, runtime.principal);
    this.assertTarget(owner, runtime.target, bound);
    if (runtime.bindingDigest !== digest({ pins: bound.contract.pins, adapter: bound.adapter.ref, target: runtime.target, cost: bound.cost, evidenceScope: bound.adapter.evidenceScope ?? null })) return deny();
    return { ...bound, runtime };
  }
  transient(owner: string, taskId: string, runtimeId: string): boolean {
    try { this.checked(owner, taskId, runtimeId); return false; }
    catch (error) { return error instanceof SecurityError && error.reason === 'AUTHORITY_UNAVAILABLE'; }
  }
  current(owner: string, taskId: string, runtimeId: string, allowEnding = false): boolean {
    try { this.checked(owner, taskId, runtimeId, allowEnding); return true; } catch { return false; }
  }
  private assertTarget(owner: string, target: ObservationTarget, bound: ReturnType<ObservationAuthority['validate']>) {
    const d = bound.contract.declaration;
    if (!target || typeof target.sourceAccount !== 'string' || typeof target.nativeId !== 'string' || !target.orderingScope || target.orderingScope.length > 500
      || !['provider_version', 'independent_read'].includes(target.ordering) || target.sourceAccount !== d.source.expectedSourceAccount || target.nativeId !== d.source.expectedNativeId) deny();
    const canonical = `pipeline:${digest({ owner, source: bound.intake.source.id, account: target.sourceAccount, type: bound.mapping.objectType, nativeId: target.nativeId })}`;
    if (d.target.object.id !== canonical) throw new DomainError('CONFLICT', 'The observer must bind the existing canonical source identity; it cannot create a duplicate entity');
  }
}
