import {digest} from '../core/delegation.js';
import {DomainError,ConnectionAuthorizationRequired} from '../core/domain.js';
import type {AgentProgramContext} from '../core/agent-program.js';
import type {Delivery} from '../core/catalog.js';
import {componentContext} from '../core/composed-actions.js';
import {assertGoalContract,type GoalAssessment} from '../core/goal-contract.js';
import type {AgentComponentContext} from '../ontology/agent-actions.js';
import type {ActionIntent} from '../ontology/actions.js';
import type {AcceptedPortValue,EvidenceOrigin} from '../ontology/composition-contract.js';
import type {CandidateFacts,ServiceCapability} from '../ontology/execution.js';
import type {PlanningSnapshot} from '../ontology/planning-contract.js';
import {checkRequirements} from '../ontology/requirement-checks.js';
import {graphRead,type ProjectionMetadata,type GraphProgram} from '../ontology/graph-program.js';
import {assessConditionsProgram} from './conditions.js';
import {goalCompletionSchema} from '../ontology/goal-completion-contract.js';

export type GoalAssessmentContext=Omit<AgentProgramContext,'graph'>&{graph:ProjectionMetadata};
/** Server-owned, registered semantic programs. No model/provider execution or
 * raw synchronous store belongs at this boundary. Missing programs must deny. */
export interface GoalCompletionProgram {
  readonly ref:{id:string;version:string};readonly configurationDigest:string;
  capability():ServiceCapability;
  assertContextProgram?:(context:GoalAssessmentContext)=>GraphProgram<void>;
  completeProgram:(context:GoalAssessmentContext,proposal:unknown,reads:PlanningSnapshot)=>GraphProgram<Delivery>;
}
export interface GoalAssessmentPorts {
  /** The enclosing admitted transaction retains its original claim, role,
   * grant and semantic-evidence deadlines through commit and egress. These
   * semantic programs do not grant authority or renew any evidence. */
  /** Re-resolve the exact original pin, source/configuration and registration. */
  resolveProgram:(context:GoalAssessmentContext,component:AgentComponentContext)=>GraphProgram<GoalCompletionProgram>;
  verifyHostSetup?:(component:AgentComponentContext)=>void;
  /** Current accepted receipt plus the real producer's output semantics. */
  assertAcceptedOutputCurrentProgram:(context:GoalAssessmentContext,intent:ActionIntent,port:string)=>GraphProgram<AcceptedPortValue>;
}
function fail(message:string):never{throw new DomainError('CONFLICT',message);}
const same=(a:unknown,b:unknown)=>digest(a)===digest(b);

export function* partialGoalArtifactProgram(ctx: GoalAssessmentContext): GraphProgram<Delivery['artifact'] | undefined> {
  if (!ctx.state.composition || !ctx.state.observations.length) return;
  const accepted = (ctx.intents ?? []).filter(intent => intent.state === 'effect_confirmed' && intent.acceptedOutput?.object);
  let bytes = 0;
  const observations:Record<string,unknown>[]=[];
  for(const ref of ctx.state.observations.slice(-12)){
    const intent = accepted.find(intent => same(intent.acceptedOutput!.object, ref));
    if (!intent) continue;
    let object;
    try { object = yield* graphRead(ctx.owner, ref); }
    catch (error) {
      if (!(error instanceof DomainError) || !['NOT_FOUND', 'CONFLICT'].includes(error.code)) throw error;
      observations.push({ object: ref, intentId: intent.id, evidenceRefs: intent.lastVerifiedResult?.evidenceRefs ?? [], contentIncluded: false, currentObjectUnavailable: true });continue;
    }
    const size = Buffer.byteLength(JSON.stringify(object.properties)), contentIncluded = bytes + size <= 64000;
    if (contentIncluded) bytes += size;
    observations.push({ object: ref, revision: object.revision, source: object.source, intentId: intent.id, evidenceRefs: intent.lastVerifiedResult?.evidenceRefs ?? [],
      contentIncluded, ...(contentIncluded ? { properties: object.properties } : {}) });
  }
  if (!observations.length) return;
  const result = { version: '1', goalDigest: ctx.state.composition.goal.digest, accepted: false,
    criteria: ctx.state.composition.goal.criteria.map(criterion => ({ id: criterion.id, description: criterion.description, status: 'unknown' })),
    observedResults: observations, omittedObservationCount: Math.max(0, ctx.state.observations.length - 12),
    meaning: 'Accepted action observations remain available. Required whole-goal conditions have not all passed independent verification.' };
  return { id: digest(result), name: 'partial-goal-result.json', data: { goal: ctx.request.originalGoal, deliverable: '已保留原任务取得的来源结果；整个目标尚未完成。', execution: 'partial', result } };
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

export function* assessGoalProgram(ctx:GoalAssessmentContext,proposal:unknown,reads:PlanningSnapshot,ports:GoalAssessmentPorts):GraphProgram<{assessment:GoalAssessment;delivery:Delivery}>{
  if(!ports||typeof ports.resolveProgram!=='function'||typeof ports.assertAcceptedOutputCurrentProgram!=='function')fail('Whole-goal semantic ports are not installed');
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
  const origins = new Map<string,Set<EvidenceOrigin>>();
  const components:GoalAssessment['components']=[];
  for(const item of selected.components){
    try {
      const component = composition.contexts.find(value => value.id === item.contextId) ?? fail('Unknown completion component');
      const program=yield* ports.resolveProgram(ctx,component);
      const scoped = componentContext(ctx, component, program, ports.verifyHostSetup), accepted = (scoped.intents ?? []).filter(intent => intent.state === 'effect_confirmed');
      if(program.assertContextProgram)yield* program.assertContextProgram(scoped);
      if (!accepted.length) fail('A component result requires its accepted original operation');
      const delivery=yield* program.completeProgram(scoped,JSON.parse(item.proposalJson),reads);
      for (const receiptDigest of delivery.consumedPorts ?? []) {
        const source = (ctx.intents ?? []).flatMap(intent => ((intent.acceptedOutput?.ports ?? []) as import('../ontology/composition-contract.js').AcceptedPortValue[]).map(port => ({ intent, port }))).find(value => value.port.digest === receiptDigest) ?? fail('Component cites an output outside this accepted task history');
        const current=yield* ports.assertAcceptedOutputCurrentProgram(ctx,source.intent,source.port.port);
        if(!same(current,source.port))fail('The consumed output differs from its original current accepted receipt');
      }
      const evidence = new Set(accepted.flatMap(intent => [intent.id, ...(intent.lastVerifiedResult?.evidenceRefs ?? [])]));
      if (!delivery.evidenceRefs.length || delivery.evidenceRefs.some(ref => !evidence.has(ref))) fail('Component completion is not supported by its original accepted observations');
      const acceptedPorts = accepted.flatMap(intent => ((intent.acceptedOutput?.ports ?? []) as import('../ontology/composition-contract.js').AcceptedPortValue[])
        .filter(port => delivery.evidenceRefs.includes(intent.id) || port.evidence.refs.some(ref => delivery.evidenceRefs.includes(ref))));
      if (!acceptedPorts.length) fail('Component completion has no typed accepted output evidence');
      origins.set(item.contextId, new Set(acceptedPorts.map(port => port.evidence.origin)));
      capabilities.set(item.contextId, program.capability());
      components.push({contextId:item.contextId,status:'verified',delivery});
    } catch (error) {
      if (error instanceof ConnectionAuthorizationRequired) throw error;
      components.push({contextId:item.contextId,status:'unverified',reason:error instanceof DomainError?error.message:'Component evidence could not be independently verified'});
    }
  }
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
  const conditions:GoalAssessment['conditions']=[];
  for(const condition of (ctx.request.conditions??[]).filter(condition=>condition.phase==='result')){
    const choice = selected.conditions.find(item => item.conditionId === condition.id), proof = verified.find(component => component.contextId === choice?.contextId);
    if(!proof){conditions.push({conditionId:condition.id,phase:'result',strength:condition.strength,result:'unknown',reason:'Select a verified component subject for this required condition',evidenceRefs:[],evidenceLevels:[]});continue;}
    conditions.push((yield* assessConditionsProgram(ctx.graph,ctx.owner,{...ctx.request,conditions:[condition]},proof.delivery!.conditionSubject,'result'))[0]!);
  }
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
