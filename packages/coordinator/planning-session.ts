import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../core/domain.js';
import { digest } from '../core/delegation.js';
import { objectRefSchema, type ObjectRef } from '../ontology/model.js';
import { objectQuerySchema, type OntologyObjectStore } from '../ontology/object-store.js';
import { functionCallSchema } from '../ontology/object-functions.js';
import { planningSnapshot, type PlanningReadReceipt, type ObjectSnapshot, type DecisionActionProposal, type PlanningSnapshot } from '../ontology/planning-contract.js';
import type { ResolvedCandidate, ServiceRequest } from '../ontology/execution.js';
import { assessConditions, hardConditionsPass } from './conditions.js';
import { serviceDomains } from '../ontology/service-domains.js';
import { businessConditionSchema } from '../ontology/business-model.js';
import type { DomainAssessment } from '../ontology/domain-rules.js';
import { compactSchema } from './prompt-data.js';

const describeSchema = z.object({ search: z.string().max(100).optional(), limit: z.number().int().min(1).max(5).optional(), after: z.string().max(80).optional(), actions: z.array(z.string().min(1).max(80)).max(8).optional().describe('Exact action IDs whose complete input schemas are needed; otherwise concise action summaries'), functions: z.array(z.string().min(1).max(80)).max(20).optional().describe('Exact registered function IDs; omit to discover all function definitions'), includeLinks: z.boolean().optional().describe('Default true; false omits relationship navigation, which can be retrieved separately when needed'), includeConditionSchema: z.boolean().optional().describe('Request the full typed business-condition contract when grounding domain conditions'), includeSchemas: z.boolean().optional().describe('Request full property and action schemas; default returns concise names, semantics and links') }).strict();
const assessmentSchema = z.object({ candidateId: z.string().max(200).optional(), subject: objectRefSchema.optional(), phase: z.enum(['precondition', 'result']).optional() }).strict();
const actionSchema = z.object({ action: z.string().min(1).max(80), inputs: z.array(z.object({ name: z.string().min(1).max(80), object: objectRefSchema, revision: z.number().int().positive() }).strict()).min(1).max(8) }).strict();
export const planningToolSchemas = { describe_ontology: describeSchema, query_ontology: objectQuerySchema, evaluate_ontology: functionCallSchema, assess_conditions: assessmentSchema, propose_action: actionSchema };
export const planningToolCatalog = () => Object.entries(planningToolSchemas).map(([name, schema]) => ({ name, inputSchema: compactSchema(z.toJSONSchema(schema)), readOnly: true, executionAllowed: false }));
const key = (ref: ObjectRef) => JSON.stringify(ref);
const contextLimits = { reads: 10, bytes: 80000, resultBytes: 30000, refs: 8 } as const;

function relevantProperties(ref: ObjectRef, properties: Record<string, unknown>, request: ServiceRequest) {
  if (ref.type !== 'ServiceRequest' || ref.id !== request.id) return properties;
  const { progress: _progress, projectionState: _coverage, ...business } = properties;
  return business;
}
export function snapshotObject(graph: OntologyObjectStore, owner: string, ref: ObjectRef, request: ServiceRequest): ObjectSnapshot {
  const object = graph.read(owner, ref);
  return { ref, revision: object.revision, propertiesDigest: digest(relevantProperties(ref, object.properties, request)), linksDigest: graph.relationshipDigest(owner, ref, { remaining: 1000 }) };
}
export function validatePlanningSnapshot(graph: OntologyObjectStore, owner: string, request: ServiceRequest, snapshot: PlanningSnapshot, fresh: boolean): void {
  const { digest: expected, ...body } = snapshot;
  if (!['model_queries', 'worker_context', 'worker_context_with_queries', 'trusted_template'].includes(snapshot.mode) || digest(body) !== expected || digest(snapshot.model) !== digest(graph.model.ref) || snapshot.requestRevision !== request.revision || snapshot.conditionsDigest !== digest(request.conditions ?? [])) throw new DomainError('CONFLICT', 'Ontology planning contract changed');
  if (snapshot.mode !== 'trusted_template' && (!snapshot.reads.some(r => r.tool === 'describe_ontology' && r.status === 'ok') || !snapshot.reads.some(r => r.tool === 'query_ontology' && r.status === 'ok'))) throw new DomainError('CONFLICT', 'A model plan requires actual definition and object reads');
  const contextReads = snapshot.reads.filter(r => r.origin === 'worker_context').length;
  if (snapshot.reads.some(read => read.origin !== undefined && !['worker_context', 'model'].includes(read.origin))) throw new DomainError('CONFLICT', 'Unrecognized planning read origin');
  if (snapshot.mode === 'worker_context' && contextReads !== snapshot.reads.length || snapshot.mode === 'worker_context_with_queries' && (!contextReads || contextReads === snapshot.reads.length) || snapshot.mode === 'model_queries' && contextReads) throw new DomainError('CONFLICT', 'Planning read attribution differs from its declared mode');
  if (!hardConditionsPass(snapshot.conditionChecks, 'precondition') || (request.conditions ?? []).some(c => c.phase === 'precondition' && c.strength === 'hard' && !snapshot.conditionChecks.some(r => r.conditionId === c.id && r.result === 'pass'))) throw new DomainError('CONFLICT', 'Hard business preconditions are unresolved');
  if (!fresh) return;
  for (const old of snapshot.objects) {
    const current = snapshotObject(graph, owner, old.ref, request);
    const currentRequest = old.ref.type === 'ServiceRequest' && old.ref.id === request.id;
    if ((!currentRequest && current.revision !== old.revision) || current.propertiesDigest !== old.propertiesDigest || current.linksDigest !== old.linksDigest) throw new DomainError('CONFLICT', 'An object used by the planner changed; replan before dispatch');
  }
  const bound = { ...request, conditions: request.conditions?.map(c => {
    const subject = snapshot.conditionChecks.find(check => check.conditionId === c.id)?.subject;
    return subject ? businessConditionSchema.parse({ ...c, subject: { ...c.subject, object: subject } }) : c;
  }) };
  if (!hardConditionsPass(assessConditions(graph, owner, bound, undefined, 'precondition'), 'precondition')) throw new DomainError('CONFLICT', 'Business precondition evidence expired or changed before dispatch');
}

/** One request-scoped model interaction. Data access uses the existing authenticated owner. */
export class OntologyPlanningSession {
  private reads: PlanningReadReceipt[] = [];
  private seen = new Map<string, ObjectSnapshot>();
  private proposals: DecisionActionProposal[] = [];
  private bytes = 0;
  private failures = new Map<string, number>();
  constructor(readonly graph: OntologyObjectStore, private owner: string, readonly request: ServiceRequest,
    private candidates: ResolvedCandidate[] = [], private active: () => void = () => {}, private onRead: (receipt: PlanningReadReceipt) => void = () => {}, private readScope: 'owner' | 'request' = 'owner', private boundRefs: ObjectRef[] = []) {}
  catalog() {
    return {
      model: this.graph.model.ref, tools: planningToolCatalog(),
      functions: this.graph.model.functionsFor(['ServiceRequest', ...this.boundRefs.map(ref => ref.type)]), functionNavigationOnly: true,
      boundObjects: this.boundRefs.map(ref => ({ ref, navigationOnly: true, readThisDecision: this.seen.has(key(ref)) })),
      actionInputReadPolicy: {
        appliesTo: 'Every direct ObjectRef value in the selected execute action arguments, including scope references',
        requiredEvidence: 'Object snapshot from actual ontology reads in THIS decision; use query_ontology for references supplied only in context/history',
        navigationAndHistoricalReadsSatisfy: false, missingReferencesQueriedAutomatically: false,
      },
      readScope: this.readScope,
      scopeNote: this.readScope === 'request' ? 'Only the current ServiceRequest, its direct relationships, explicitly bound program objects and exact objects already retrieved through this request. Unrelated owner data is unavailable in this session.' : 'Owned business objects only; restricted properties remain unavailable.',
      maxToolCalls: 20, maxResultBytes: 200000,
    };
  }
  receipts() { return structuredClone(this.reads); }
  retrievedRefs() { return [...this.seen.values()].map(o => o.ref); }
  /** Fresh task-local context only. Definitions determine pure source checks;
   * no adapter, source transport, business action or decision is invoked here. */
  prepareContext(options: { actions?: string[]; refs?: ObjectRef[] } = {}) {
    this.active();
    const startedAt = new Date().toISOString();
    if (this.reads.length) throw new DomainError('CONFLICT', 'Worker context must precede model queries in this decision');
    const definitions = (options.actions ?? []).map(id => this.graph.model.action(id));
    const functionIds = [...new Set(definitions.flatMap(action => action.read?.mcp ? [
      ...action.read.mcp.requires.map(dependency => dependency.evaluate),
      ...(action.read.module ? [action.read.module.completion.evaluate] : []),
    ] : []))];
    const entries: { call: { tool: string; argumentsJson: string }; result: unknown; receiptId: string }[] = [];
    const read = (tool: string, input: unknown) => {
      const remaining = contextLimits.bytes - this.bytes;
      if (entries.length >= contextLimits.reads || remaining < 1000) return false;
      const result = this.call(tool, input, { origin: 'worker_context', maxOutputBytes: Math.min(contextLimits.resultBytes, remaining) });
      const receipt = this.reads.at(-1)!;
      entries.push({ call: { tool, argumentsJson: JSON.stringify(input) }, result, receiptId: receipt.id });
      return receipt.status === 'ok';
    };
    read('describe_ontology', { search: 'ServiceRequest', limit: 1, actions: (options.actions ?? []).slice(0, 8), functions: functionIds.slice(0, 20), includeLinks: false });
    const refs = [{ type: 'ServiceRequest', id: this.request.id }, ...(options.refs ?? [])]
      .filter((ref, index, all) => all.findIndex(value => key(value) === key(ref)) === index).slice(0, contextLimits.refs);
    const queried: ObjectRef[] = [];
    for (const ref of refs) if (read('query_ontology', { object: ref })) queried.push(ref);
    for (const ref of queried) for (const id of functionIds) {
      if (this.graph.model.function(id).inputTypes.some(type => this.graph.model.implements(ref.type, type))) read('evaluate_ontology', { function: id, object: ref });
    }
    this.active();
    const metadata = { model: this.graph.model.ref, requestRevision: this.request.revision };
    return { entries, ...metadata, receiptIds: entries.map(entry => entry.receiptId), startedAt, preparedAt: new Date().toISOString(), digest: digest({ ...metadata, reads: this.receipts() }) };
  }
  private remember(ref: ObjectRef, expectedRevision?: number) {
    const next = snapshotObject(this.graph, this.owner, ref, this.request), old = this.seen.get(key(ref));
    if (expectedRevision !== undefined && next.revision !== expectedRevision) throw new DomainError('CONFLICT', 'Object changed after its query result');
    if (old && (old.propertiesDigest !== next.propertiesDigest || old.linksDigest !== next.linksDigest || ref.type !== 'ServiceRequest' && old.revision !== next.revision)) throw new DomainError('CONFLICT', 'Object changed between reasoning reads');
    this.seen.set(key(ref), next);
    if (this.seen.size > 150) throw new DomainError('CONFLICT', 'Planner object budget exceeded');
  }
  private retrieved(ref: ObjectRef, allowBoundQuery = false) {
    if (ref.type === 'ServiceRequest' && ref.id === this.request.id) return;
    if (allowBoundQuery && this.boundRefs.some(bound => key(bound) === key(ref))) return;
    if (!this.seen.has(key(ref))) throw new DomainError('FORBIDDEN', 'Read the owned object before using its reference');
  }
  call(tool: string, input: unknown, options?: { origin: 'worker_context'; maxOutputBytes: number }): unknown {
    this.active();
    if (this.reads.length >= 20) throw new DomainError('CONFLICT', 'Planner tool-call limit reached');
    const before = new Set(this.seen.keys());
    const priorObjects = options ? new Map(this.seen) : undefined;
    const datasetRevision = this.graph.revision(this.owner);
    let output: unknown, status: PlanningReadReceipt['status'] = 'ok';
    try {
      if (tool === 'describe_ontology') {
        const { includeSchemas = false, includeLinks = true, includeConditionSchema = false, actions, functions, ...args } = describeSchema.parse(input), result = this.graph.model.describe(args);
        const selected = actions ? actions.map(id => ({ ...this.graph.model.action(id), execution: 'definition_only' })) : result.actions;
        const describedActions = selected.map(action => {
          if (includeSchemas || actions) return action;
          const { read, operation, ...summary } = action;
          const compact = (metadata: NonNullable<typeof read | typeof operation>) => {
            const { inputSchema, ...rest } = metadata;
            return { ...rest, inputKeys: Object.keys((inputSchema as { properties?: object }).properties ?? {}), schemaAvailable: true };
          };
          return { ...summary, ...(read ? { read: compact(read) } : {}), ...(operation ? { operation: compact(operation) } : {}) };
        });
        output = { ...result, schemaDetail: includeSchemas ? 'full' : 'summary', types: result.types.map(type => {
          const value = type as { properties: Record<string, Record<string, unknown>>; links?: unknown };
          const { links, ...definition } = value;
          return { ...definition, ...(includeLinks ? { links } : { linksAvailable: true }), properties: includeSchemas ? value.properties : Object.fromEntries(Object.entries(value.properties).map(([name, p]) => { const { schema: _schema, ...metadata } = p; return [name, metadata]; })) };
        }), actions: describedActions, functions: functions ? functions.map(id => this.graph.model.function(id)) : result.functions, ...(includeConditionSchema ? { conditionSchema: z.toJSONSchema(businessConditionSchema) } : {}) };
      }
      else if (tool === 'query_ontology') {
        let query = objectQuerySchema.parse(input);
        if (this.readScope === 'request') {
          if ('type' in query) {
            if (query.type !== 'ServiceRequest') throw new DomainError('FORBIDDEN', 'This delegation lacks tasks:read for owner-wide object search');
            const { type: _type, ...fields } = query;
            query = { ...fields, object: { type: 'ServiceRequest', id: this.request.id } };
          } else if ('object' in query) this.retrieved(query.object, true);
          else if (query.from.type !== 'ServiceRequest' || query.from.id !== this.request.id) throw new DomainError('FORBIDDEN', 'This delegation permits only relationships of the current request');
        }
        if ('from' in query) this.retrieved(query.from);
        const result = this.graph.query(this.owner, query);
        for (const object of result.items) this.remember(object.ref, object.revision);
        output = result;
      } else if (tool === 'evaluate_ontology') {
        const args = functionCallSchema.parse(input);
        for (const value of Object.values(args)) { const ref = objectRefSchema.safeParse(value); if (ref.success) this.retrieved(ref.data); }
        const result = this.graph.evaluate(this.owner, args);
        for (const ref of [args.object, ...result.evidenceRefs]) this.remember(ref);
        output = result;
      } else if (tool === 'assess_conditions') {
        const args = assessmentSchema.parse(input), candidate = this.candidates.find(c => c.id === args.candidateId);
        if (args.candidateId && !candidate) throw new DomainError('FORBIDDEN', 'Unknown candidate');
        if (args.subject) this.retrieved(args.subject);
        if (args.subject && candidate?.ontologySubject && key(args.subject) !== key(candidate.ontologySubject)) throw new DomainError('CONFLICT', 'Candidate and selected condition subject differ');
        const checks = assessConditions(this.graph, this.owner, this.request, args.subject ?? candidate?.ontologySubject, args.phase);
        for (const check of checks) for (const ref of [...(check.subject ? [check.subject] : []), ...check.evidenceRefs]) this.remember(ref);
        output = { checks, grantsAuthority: false };
      } else if (tool === 'propose_action') {
        const args = actionSchema.parse(input), definition = this.graph.model.action(args.action);
        if (definition.read) throw new DomainError('INVALID_INPUT', 'Read actions are selected in an agent execute decision; this proposal-only tool never executes them');
        if (args.inputs.length !== Object.keys(definition.inputs).length || new Set(args.inputs.map(i => i.name)).size !== args.inputs.length) throw new DomainError('INVALID_INPUT', 'Action inputs must match the registered definition');
        const inputs: DecisionActionProposal['inputs'] = {};
        for (const item of args.inputs) {
          this.retrieved(item.object);
          if (!definition.inputs[item.name] || !this.graph.model.implements(item.object.type, definition.inputs[item.name]!)) throw new DomainError('INVALID_INPUT', 'Action input type mismatch');
          const actual = this.graph.read(this.owner, item.object);
          if (actual.revision !== item.revision) throw new DomainError('CONFLICT', 'Action proposal references a stale object revision');
          this.remember(item.object); inputs[item.name] = { object: item.object, revision: item.revision };
        }
        if (inputs.request?.object.id !== this.request.id) throw new DomainError('FORBIDDEN', 'Action belongs to another request');
        if (this.graph.read(this.owner, inputs.request.object).properties.revision !== this.request.revision) throw new DomainError('CONFLICT', 'Action request revision changed');
        const checks: DecisionActionProposal['checks'] = definition.submissionCriteria.map(criterion => ({ criterion, result: ['same_owner', 'current_request_revision'].includes(criterion) ? 'pass' : 'unknown' }));
        const domain = serviceDomains.find(d => d.action === args.action);
        if (domain) {
          const option = inputs.option!.object, requirements = inputs.requirements!.object;
          const related = this.graph.related(this.owner, option, 'requirements', { remaining: 1000 });
          const requestLinks = [option, requirements].map(ref => this.graph.related(this.owner, ref, 'request', { remaining: 1000 }));
          checks.find(c => c.criterion === 'same_request')!.result = requestLinks.every(rows => rows?.length === 1 && rows[0]!.ref.id === this.request.id) ? 'pass' : 'fail';
          checks.find(c => c.criterion === 'current_requirements')!.result = related?.length === 1 && key(related[0]!.ref) === key(requirements) && related[0]!.properties.requestRevision === this.request.revision ? 'pass' : 'fail';
          const eligibility = this.graph.evaluate(this.owner, { function: domain.eligibleFunction, object: option });
          for (const ref of eligibility.evidenceRefs) this.remember(ref);
          const status = (eligibility.value as DomainAssessment | undefined)?.status;
          checks.find(c => c.criterion === 'eligible_option')!.result = eligibility.status === 'unknown' || status === 'unknown' ? 'unknown' : status === 'satisfied' ? 'pass' : 'fail';
          // Proposal tools cannot manufacture a dispatch permit, even for a local itinerary.
        }
        if (['PrepareCheckout', 'CompleteCheckout'].includes(args.action)) {
          const requirements = this.graph.read(this.owner, inputs.requirements!.object), root = this.graph.related(this.owner, requirements.ref, 'request', { remaining: 1000 });
          checks.find(c => c.criterion === 'current_requirements')!.result = requirements.properties.requestRevision === this.request.revision && root?.length === 1 && root[0]!.ref.id === this.request.id ? 'pass' : 'fail';
          if (args.action === 'CompleteCheckout') {
            const session = this.graph.related(this.owner, requirements.ref, 'session', { remaining: 1000 });
            if (session?.length !== 1 || key(session[0]!.ref) !== key(inputs.checkout!.object)) checks.find(c => c.criterion === 'current_requirements')!.result = 'fail';
            const ready = this.graph.evaluate(this.owner, { function: 'checkoutReadiness', object: inputs.checkout!.object });
            for (const ref of ready.evidenceRefs) this.remember(ref);
            const status = (ready.value as { status?: string } | undefined)?.status;
            checks.find(c => c.criterion === 'checkout_ready')!.result = ready.status === 'unknown' || status === 'unknown' ? 'unknown' : status === 'satisfied' ? 'pass' : 'fail';
          }
        }
        if (inputs.offer) {
          const requests = this.graph.related(this.owner, inputs.offer.object, 'request', { remaining: 1000 });
          const sameRequest = checks.find(c => c.criterion === 'same_request'); if (sameRequest) sameRequest.result = requests?.length === 1 && requests[0]!.ref.id === this.request.id ? 'pass' : 'fail';
          const fresh = this.graph.evaluate(this.owner, { function: 'offerFreshness', object: inputs.offer.object });
          const freshness = checks.find(c => c.criterion === 'fresh_offer'); if (freshness) freshness.result = fresh.status === 'known' ? fresh.value ? 'pass' : 'fail' : 'unknown';
          const preconditions = checks.find(c => c.criterion === 'hard_preconditions_pass');
          if (preconditions) { const assessment = assessConditions(this.graph, this.owner, this.request, inputs.offer.object, 'precondition'); preconditions.result = assessment.some(c => c.strength === 'hard' && c.result === 'fail') ? 'fail' : hardConditionsPass(assessment, 'precondition') ? 'pass' : 'unknown'; }
        }
        const proposal: DecisionActionProposal = { action: args.action, definitionDigest: digest(definition), inputs, changes: definition.changes, checks, execution: 'proposal_only', executionAllowed: false };
        this.proposals.push(proposal); output = proposal;
      } else throw new DomainError('INVALID_INPUT', 'Unregistered planning tool');
      if (tool !== 'describe_ontology' && this.graph.revision(this.owner) !== datasetRevision) throw new DomainError('CONFLICT', 'Objects changed during the planning read');
    } catch (error) {
      if (!(error instanceof DomainError || error instanceof z.ZodError)) throw error;
      status = 'rejected'; output = { error: error instanceof DomainError ? error.code : 'INVALID_INPUT', message: error instanceof DomainError ? error.message : 'Input does not match the published tool schema' };
      const failure = digest({ tool, input, output }), count = (this.failures.get(failure) ?? 0) + 1; this.failures.set(failure, count);
      if (count >= 3) throw new DomainError('CONFLICT', 'Three identical planning read failures; stop and report the unresolved input');
    }
    if (options && Buffer.byteLength(JSON.stringify(output)) > options.maxOutputBytes) {
      this.seen = priorObjects!;
      status = 'rejected'; output = { error: 'CONTEXT_NOT_INCLUDED', message: 'This result exceeds the bounded initial Worker context. Request a narrower definition or object selection through the primitive ontology tools.' };
    }
    if (options && status === 'rejected') this.seen = priorObjects!;
    this.bytes += Buffer.byteLength(JSON.stringify(output));
    if (this.bytes > 200000) throw new DomainError('CONFLICT', 'Planner context byte budget exceeded');
    this.active();
    this.reads.push({ id: randomUUID(), at: new Date().toISOString(), tool, inputDigest: digest(input), outputDigest: digest(output), datasetRevision: this.graph.revision(this.owner), status, objects: [...this.seen].filter(([id]) => !before.has(id)).map(([, v]) => v), origin: options?.origin ?? 'model' });
    this.onRead(this.reads.at(-1)!);
    return output;
  }
  finish(candidate?: ResolvedCandidate): PlanningSnapshot {
    this.active();
    const conditionChecks = assessConditions(this.graph, this.owner, this.request, candidate?.ontologySubject);
    for (const check of conditionChecks) for (const ref of [...(check.subject ? [check.subject] : []), ...check.evidenceRefs]) this.remember(ref);
    const contextReads = this.reads.filter(read => read.origin === 'worker_context').length;
    const mode = contextReads ? contextReads === this.reads.length ? 'worker_context' : 'worker_context_with_queries' : 'model_queries';
    const result = planningSnapshot({ mode, model: this.graph.model.ref, requestRevision: this.request.revision, conditionsDigest: digest(this.request.conditions ?? []),
      reads: this.receipts(), objects: [...this.seen.values()], conditionChecks, actionProposals: structuredClone(this.proposals) });
    validatePlanningSnapshot(this.graph, this.owner, this.request, result, true);
    return result;
  }
}
