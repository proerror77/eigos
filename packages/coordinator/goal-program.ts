import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError, ConnectionAuthorizationRequired } from '../core/domain.js';
import type { AgentProgram, AgentProgramContext } from '../core/agent-program.js';
import type { ExecutionCatalog, Delivery } from '../core/catalog.js';
import { assertAcceptedOutputCurrent, componentContext } from '../core/composed-actions.js';
import { assertGoalContract, type GoalAssessment, type GoalContract } from '../core/goal-contract.js';
import type { AgentExecutionState } from '../ontology/agent-actions.js';
import type { PlanningSnapshot } from '../ontology/planning-contract.js';
import type { CandidateFacts, ServiceCapability, ServiceRequest } from '../ontology/execution.js';
import { checkRequirements } from '../ontology/requirement-checks.js';
import { assessConditions } from './conditions.js';
import { goalCompletionSchema } from '../ontology/goal-completion-contract.js';
export { goalCompletionSchema } from '../ontology/goal-completion-contract.js';

function fail(message: string): never { throw new DomainError('CONFLICT', message); }
const same = (a: unknown, b: unknown) => digest(a) === digest(b);
export function goalState(request: ServiceRequest, goal: GoalContract): AgentExecutionState {
  return { version: '2', programRef: { id: 'eigos.goal', version: '1' }, programDigest: digest({ engine: 'eigos.goal@1', goal: goal.digest, release: goal.ontologyRelease }),
    scope: { type: 'ServiceRequest', id: request.id }, input: {}, requestRevision: request.revision, plans: [], observations: [], feedback: [],
    composition: { version: '1', contexts: [], goal } };
}
/** Preserve observed source data on interruption without calling it accepted
 * whole-goal delivery. Large objects remain available through their exact refs. */
export function partialGoalArtifact(ctx: AgentProgramContext): Delivery['artifact'] | undefined {
  if (!ctx.state.composition || !ctx.state.observations.length) return;
  const accepted = (ctx.intents ?? []).filter(intent => intent.state === 'effect_confirmed' && intent.acceptedOutput?.object);
  let bytes = 0;
  const observations = ctx.state.observations.slice(-12).flatMap<Record<string, unknown>>(ref => {
    const intent = accepted.find(intent => same(intent.acceptedOutput!.object, ref));
    if (!intent) return [];
    let object;
    try { object = ctx.graph.read(ctx.owner, ref); }
    catch (error) {
      if (!(error instanceof DomainError) || !['NOT_FOUND', 'CONFLICT'].includes(error.code)) throw error;
      return [{ object: ref, intentId: intent.id, evidenceRefs: intent.lastVerifiedResult?.evidenceRefs ?? [], contentIncluded: false, currentObjectUnavailable: true }];
    }
    const size = Buffer.byteLength(JSON.stringify(object.properties)), contentIncluded = bytes + size <= 64000;
    if (contentIncluded) bytes += size;
    return [{ object: ref, revision: object.revision, source: object.source, intentId: intent.id, evidenceRefs: intent.lastVerifiedResult?.evidenceRefs ?? [],
      contentIncluded, ...(contentIncluded ? { properties: object.properties } : {}) }];
  });
  if (!observations.length) return;
  const result = { version: '1', goalDigest: ctx.state.composition.goal.digest, accepted: false,
    criteria: ctx.state.composition.goal.criteria.map(criterion => ({ id: criterion.id, description: criterion.description, status: 'unknown' })),
    observedResults: observations, omittedObservationCount: Math.max(0, ctx.state.observations.length - 12),
    meaning: 'Accepted action observations remain available. Required whole-goal conditions have not all passed independent verification.' };
  return { id: digest(result), name: 'partial-goal-result.json', data: { goal: ctx.request.originalGoal, deliverable: '已保留原任务取得的来源结果；整个目标尚未完成。', execution: 'partial', result } };
}

/** Task-level policy only. All source calls are resolved from the selected step;
 * this program contains no business operation, adapter or action sequence. */
export class GoalProgram implements AgentProgram {
  readonly ref = { id: 'eigos.goal', version: '1' };
  readonly actionIds: string[] = [];
  readonly completionSchema = z.toJSONSchema(goalCompletionSchema);
  readonly guidance = 'Discover exact task-scoped actions. Prepare a pure context for each selected program, then choose actions and dependencies from current evidence. Complete every fixed goal criterion using independently verified component results.';
  readonly configurationDigest: string;
  constructor(private goal: GoalContract) { this.configurationDigest = digest({ engine: 'eigos.goal@1', goal: goal.digest, release: goal.ontologyRelease }); }
  permitted() { return true; }
  capability(): ServiceCapability {
    return { ref: this.ref, ontologyRef: { id: this.goal.ontologyRelease.ontologyId, version: this.goal.ontologyRelease.digest },
      name: 'Whole-goal evidence verification', description: this.guidance, tags: [], inputSchema: {}, ontology: { goal: structuredClone(this.goal) }, actions: [],
      predicates: this.goal.criteria.map(criterion => ({ id: criterion.predicate, description: criterion.description })), outcomePredicates: this.goal.criteria.map(criterion => criterion.predicate),
      verifierRef: { id: 'eigos.goal.independent', version: '1' }, completion: 'domain', environment: 'local' };
  }
  assertContext(ctx: AgentProgramContext) { assertGoalContract(this.goal, ctx.request, ctx.graph.releaseRef); }
  initialize(): never { return fail('Goal initialization requires the frozen request contract'); }
  schema(): never { return fail('Select an exact discovered action binding'); }
  definition(): never { return fail('Select an exact discovered action binding'); }
  validate(): never { return fail('Select an exact discovered action binding'); }
  async invoke(): Promise<never> { return fail('The goal policy has no executable business action'); }
  project(): never { return fail('The goal policy cannot manufacture source observations'); }
  complete(): never { return fail('Goal completion requires all component verifiers'); }
}

/** Conflicting facts stay unknown. Economic totals require an explicit identity
 * whenever multiple observations would otherwise be added or overwritten. */
export function aggregateGoalFacts(deliveries: Delivery[]): CandidateFacts {
  const result: CandidateFacts = {};
  const unique = (values: unknown[]) => {
    const present = values.filter(value => value !== undefined), candidates = [...new Map(present.map(value => [digest(value), value])).values()];
    return candidates.length === 1 ? structuredClone(candidates[0]) : undefined;
  };
  for (const name of ['quantity', 'locationRef', 'searchArea'] as const) {
    const value = unique(deliveries.map(delivery => delivery.facts[name]));
    if (value !== undefined) Object.assign(result, { [name]: value });
  }
  for (const name of ['quantities', 'locations'] as const) {
    const keys = new Set(deliveries.flatMap(delivery => Object.keys(delivery.facts[name] ?? {}))), values: Record<string, unknown> = {};
    for (const key of keys) {
      const value = unique(deliveries.map(delivery => (delivery.facts[name] as Record<string, unknown> | undefined)?.[key]));
      if (value !== undefined) values[key] = value;
    }
    if (Object.keys(values).length) Object.assign(result, { [name]: values });
  }
  const dates = deliveries.map(delivery => delivery.facts.deliveryBy).filter((value): value is string => !!value);
  if (dates.length) result.deliveryBy = dates.sort().at(-1);
  const deadlineKeys = new Set(deliveries.flatMap(delivery => Object.keys(delivery.facts.deadlines ?? {})));
  for (const key of deadlineKeys) {
    const values = deliveries.map(delivery => (delivery.facts.deadlines as Record<string, string> | undefined)?.[key]).filter((value): value is string => !!value);
    (result.deadlines ??= {})[key as keyof NonNullable<CandidateFacts['deadlines']>] = values.sort().at(-1)!;
  }
  const monetary = (role?: keyof NonNullable<CandidateFacts['amounts']>) => {
    const relevant = deliveries.filter(delivery => (role ? delivery.facts.amounts?.[role] : delivery.facts.totalPrice) !== undefined);
    if (!relevant.length) return;
    if (relevant.length === 1) return structuredClone(role ? relevant[0]!.facts.amounts![role] : relevant[0]!.facts.totalPrice);
    const facts = relevant.flatMap(delivery => {
      const amount = role ? delivery.facts.amounts![role] : delivery.facts.totalPrice;
      return (delivery.economicFacts ?? []).filter(fact => (fact.role ?? 'service_total') === (role ?? 'service_total') && fact.phase !== 'refund' && same(fact.amount, amount)
        && fact.key && fact.evidenceRefs.length && fact.evidenceRefs.every(ref => delivery.evidenceRefs.includes(ref)));
    });
    if (relevant.some(delivery => !(delivery.economicFacts ?? []).some(fact => (fact.role ?? 'service_total') === (role ?? 'service_total') && facts.includes(fact)))) return;
    const groups = new Map<string, typeof facts>();
    for (const fact of facts) groups.set(fact.key, [...(groups.get(fact.key) ?? []), fact]);
    if ([...groups.values()].some(group => new Set(group.map(fact => digest(fact.amount))).size !== 1)) return;
    const amounts = [...groups.values()].map(group => group[0]!.amount);
    if (!amounts.length || new Set(amounts.map(amount => amount.currency)).size !== 1) return;
    return { minor: String(amounts.reduce((total, amount) => total + BigInt(amount.minor), 0n)), currency: amounts[0]!.currency };
  };
  result.totalPrice = monetary();
  const amountKeys = new Set(deliveries.flatMap(delivery => Object.keys(delivery.facts.amounts ?? {})));
  for (const key of amountKeys) { const amount = monetary(key as keyof NonNullable<CandidateFacts['amounts']>); if (amount) (result.amounts ??= {})[key as keyof NonNullable<CandidateFacts['amounts']>] = amount; }
  result.conditions = [...new Set(deliveries.flatMap(delivery => delivery.facts.conditions ?? []))];
  return result;
}

export function assessGoal(catalog: ExecutionCatalog, ctx: AgentProgramContext, proposal: unknown, reads: PlanningSnapshot): { assessment: GoalAssessment; delivery: Delivery } {
  const composition = ctx.state.composition ?? fail('Missing whole-goal state');
  assertGoalContract(composition.goal, ctx.request, ctx.graph.releaseRef);
  const parsed = goalCompletionSchema.safeParse(proposal);
  if (!parsed.success) {
    const roots = new Set(['components', 'criteria', 'conditions']);
    const fields = [...new Set(parsed.error.issues.map(issue => roots.has(String(issue.path[0])) ? String(issue.path[0]) : 'completion'))];
    fail(`Whole-goal completion schema mismatch at ${fields.join(', ')}. Use components:[{contextId,proposalJson:JSON text}], criteria:[{id,contextIds:[contextId]}] and conditions:[{conditionId,contextId}]; include conditions:[] when none are required.`);
  }
  const selected = parsed.data;
  for (const [items, id] of [[selected.components, (item: { contextId: string }) => item.contextId], [selected.criteria, (item: { id: string }) => item.id], [selected.conditions, (item: { conditionId: string }) => item.conditionId]] as const) {
    const keys = items.map(item => (id as (item: unknown) => string)(item));
    if (new Set(keys).size !== keys.length) fail('Completion repeats a component, criterion or condition');
  }
  if (selected.criteria.some(item => !composition.goal.criteria.some(criterion => criterion.id === item.id))
    || selected.conditions.some(item => !ctx.request.conditions?.some(condition => condition.id === item.conditionId))) fail('Completion references an unknown fixed criterion');
  const capabilities = new Map<string, ServiceCapability>();
  const origins = new Map<string, Set<import('../ontology/composition-contract.js').EvidenceOrigin>>();
  const components: GoalAssessment['components'] = selected.components.map(item => {
    try {
      const component = composition.contexts.find(value => value.id === item.contextId) ?? fail('Unknown completion component');
      const { program } = catalog.resolveActionBinding(ctx.graph, ctx.owner, ctx.request, component.initializedBy.binding);
      const scoped = componentContext(ctx, component, program), accepted = (scoped.intents ?? []).filter(intent => intent.state === 'effect_confirmed');
      program.assertContext?.(scoped);
      if (!accepted.length) fail('A component result requires its accepted original operation');
      const delivery = program.complete(scoped, JSON.parse(item.proposalJson), reads);
      for (const receiptDigest of delivery.consumedPorts ?? []) {
        const source = (ctx.intents ?? []).flatMap(intent => ((intent.acceptedOutput?.ports ?? []) as import('../ontology/composition-contract.js').AcceptedPortValue[]).map(port => ({ intent, port }))).find(value => value.port.digest === receiptDigest) ?? fail('Component cites an output outside this accepted task history');
        assertAcceptedOutputCurrent(catalog, ctx, source.intent, source.port.port);
      }
      const evidence = new Set(accepted.flatMap(intent => [intent.id, ...(intent.lastVerifiedResult?.evidenceRefs ?? [])]));
      if (!delivery.evidenceRefs.length || delivery.evidenceRefs.some(ref => !evidence.has(ref))) fail('Component completion is not supported by its original accepted observations');
      const ports = accepted.flatMap(intent => ((intent.acceptedOutput?.ports ?? []) as import('../ontology/composition-contract.js').AcceptedPortValue[])
        .filter(port => delivery.evidenceRefs.includes(intent.id) || port.evidence.refs.some(ref => delivery.evidenceRefs.includes(ref))));
      if (!ports.length) fail('Component completion has no typed accepted output evidence');
      origins.set(item.contextId, new Set(ports.map(port => port.evidence.origin)));
      capabilities.set(item.contextId, program.capability());
      return { contextId: item.contextId, status: 'verified', delivery };
    } catch (error) {
      if (error instanceof ConnectionAuthorizationRequired) throw error;
      return { contextId: item.contextId, status: 'unverified', reason: error instanceof DomainError ? error.message : 'Component evidence could not be independently verified' };
    }
  });
  const criteria: GoalAssessment['criteria'] = composition.goal.criteria.map(criterion => {
    const choice = selected.criteria.find(item => item.id === criterion.id), ids = choice?.contextIds ?? [];
    const proofs = ids.map(id => components.find(component => component.contextId === id));
    const passed = ids.length > 0 && new Set(ids).size === ids.length && proofs.every(component => component?.status === 'verified'
      && component.delivery?.facts.conditions?.includes(criterion.predicate)
      && [...(origins.get(component.contextId) ?? [])].every(origin => ctx.request.executionEnvironment === 'sandbox' && origin === 'synthetic' || (criterion.phase === 'artifact' ? ['model', 'managed', 'user'].includes(origin) : origin === 'provider'))
      && capabilities.get(component.contextId)?.goalOutcomes?.some(outcome => outcome.predicate === criterion.predicate && outcome.phase === criterion.phase));
    return { id: criterion.id, result: passed ? 'pass' : 'unknown', reason: passed ? 'Current component verifiers prove the exact required outcome and business phase' : 'A required outcome has no complete current component proof',
      contextIds: ids, evidenceRefs: passed ? [...new Set(proofs.flatMap(proof => proof!.delivery!.evidenceRefs))] : [], subjects: passed ? proofs.flatMap(proof => proof!.delivery!.conditionSubject ? [proof!.delivery!.conditionSubject] : []) : [] };
  });
  const verified = components.filter(component => component.status === 'verified');
  const requirements = [...ctx.request.requirements, ...(ctx.request.successCriteria ?? [])].map(requirement => {
    const related = composition.goal.criteria.filter(criterion => criterion.requirementIds.includes(requirement.id));
    if (!related.length || related.some(criterion => criteria.find(check => check.id === criterion.id)?.result !== 'pass')) return { requirementId: requirement.id, result: 'unknown' as const, reason: 'A contributing required goal remains incomplete', evidenceRefs: [] };
    const ids = new Set(related.flatMap(criterion => criteria.find(check => check.id === criterion.id)!.contextIds));
    const matching = requirement.kind === 'budget' && !requirement.role ? verified : verified.filter(component => ids.has(component.contextId));
    const deliveries = matching.map(component => component.delivery!), facts = aggregateGoalFacts(deliveries), evidenceRefs = [...new Set(deliveries.flatMap(delivery => delivery.evidenceRefs))];
    const capabilityPredicates = [...new Set(matching.flatMap(component => { const capability = capabilities.get(component.contextId); return [...(capability?.predicates.map(predicate => predicate.id) ?? []), ...(capability?.outcomePredicates ?? [])]; }))];
    return checkRequirements({ ...ctx.request, requirements: [requirement] }, facts, evidenceRefs, capabilityPredicates,
      matching.length === 1 ? capabilities.get(matching[0]!.contextId)?.locationSemantics : undefined)[0]!;
  });
  const conditions = (ctx.request.conditions ?? []).filter(condition => condition.phase === 'result').map(condition => {
    const choice = selected.conditions.find(item => item.conditionId === condition.id), proof = verified.find(component => component.contextId === choice?.contextId);
    if (!proof) return { conditionId: condition.id, phase: 'result' as const, strength: condition.strength, result: 'unknown' as const, reason: 'Select a verified component subject for this required condition', evidenceRefs: [], evidenceLevels: [] };
    return assessConditions(ctx.graph, ctx.owner, { ...ctx.request, conditions: [condition] }, proof.delivery!.conditionSubject, 'result')[0]!;
  });
  const accepted = criteria.every(check => check.result === 'pass')
    && [...ctx.request.requirements, ...(ctx.request.successCriteria ?? [])].filter(requirement => requirement.strength === 'hard').every(requirement => requirements.find(check => check.requirementId === requirement.id)?.result === 'pass')
    && conditions.filter(condition => condition.strength === 'hard').every(condition => condition.result === 'pass');
  const assessment: GoalAssessment = { version: '1', goalDigest: composition.goal.digest, accepted, at: new Date().toISOString(), criteria, requirements, conditions, components };
  const deliveries = verified.map(component => component.delivery!), evidenceRefs = [...new Set(deliveries.flatMap(delivery => delivery.evidenceRefs))];
  const artifact: Delivery['artifact'] = { id: digest({ goal: composition.goal.digest, assessment }), name: 'goal-result.json', data: {
    goal: ctx.request.originalGoal, deliverable: accepted ? '所有必需目标条件已由原始执行结果独立核验。' : '已保留核验通过的部分成果；整个目标仍有条件未满足。', execution: accepted ? 'completed' : 'partial',
    result: { version: '1', goalDigest: composition.goal.digest, criteria, requirements, conditions,
      components: components.map(component => ({ contextId: component.contextId, status: component.status, ...(component.reason ? { reason: component.reason } : {}), ...(component.delivery ? { artifact: component.delivery.artifact, evidenceRefs: component.delivery.evidenceRefs } : {}) })) },
  } };
  return { assessment, delivery: { artifact, facts: aggregateGoalFacts(deliveries), evidenceRefs } };
}
