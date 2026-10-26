import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { compositionSummary } from '../ontology/composition-contract.js';
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
import { isExecutionBookkeepingType } from '../ontology/execution-model.js';
import { isSharedManagedType } from '../ontology/managed-discovery.js';
import { assertTaskContextCurrent, instructionCoverageDigest, MAX_INSTRUCTION_READ_BYTES, readTaskContext, readTaskInstructions, taskContextSchema, taskInstructionsSchema, taskObjectMembership, type TaskContextBinding, type TaskContextRead } from './task-context.js';
import { actionDiscoverySchema, type ActionDiscoveryPage } from '../core/action-bindings.js';
import type { ExecutionCatalog } from '../core/catalog.js';
import { authorizationScope } from '../security/context.js';
import { accessDigest, secureRequest, assertModelChannel } from '../security/model.js';
import { describeAuthorized, secureFunctionCallSchema } from '../security/view.js';

const describeSchema = z.object({ functions: z.array(z.string().min(1).max(80)).max(20).optional(), includeLinks: z.boolean().optional(), kind: z.enum(['types', 'actions', 'functions']).optional().describe('Types return related contracts only; actions/functions pages enumerate their complete catalogues'), search: z.string().max(100).optional(), limit: z.number().int().min(1).max(5).optional(), after: z.string().max(80).optional(), actions: z.array(z.string().min(1).max(80)).max(8).optional().describe('Exact action IDs whose complete input schemas are needed; otherwise concise action summaries'), includeConditionSchema: z.boolean().optional().describe('Request the full typed business-condition contract when grounding domain conditions'), includeSchemas: z.boolean().optional().describe('Request full property and action schemas; default returns concise names, semantics and links') }).strict();
const assessmentSchema = z.object({ candidateId: z.string().max(200).optional(), subject: objectRefSchema.optional(), phase: z.enum(['precondition', 'result']).optional() }).strict();
const actionSchema = z.object({ action: z.string().min(1).max(80), inputs: z.array(z.object({ name: z.string().min(1).max(80), object: objectRefSchema, revision: z.number().int().positive() }).strict()).min(1).max(8) }).strict();
export const planningToolSchemas = { read_task_context: taskContextSchema, read_task_instructions: taskInstructionsSchema, describe_ontology: describeSchema, discover_actions: actionDiscoverySchema, query_ontology: objectQuerySchema, evaluate_ontology: functionCallSchema, assess_conditions: assessmentSchema, propose_action: actionSchema };
export const planningToolCatalog = (taskContext = false, actionCatalog = false, secured = false) => Object.entries(planningToolSchemas).filter(([name]) => (taskContext || !['read_task_context', 'read_task_instructions'].includes(name)) && (actionCatalog || name !== 'discover_actions')).map(([name, schema]) => ({ name, inputSchema: compactSchema(z.toJSONSchema(secured && name === 'evaluate_ontology' ? secureFunctionCallSchema : schema)), readOnly: true, executionAllowed: false }));
const key = (ref: ObjectRef) => JSON.stringify(ref);
const contextLimits = { reads: 10, bytes: 80000, resultBytes: 30000, refs: 8 } as const;
export const modelSessionKey = (owner: string, request: ServiceRequest, model: OntologyObjectStore['model']['ref']) => digest({ owner, requestId: request.id, revision: request.revision, model, accessDigest: accessDigest() });
export function contextDefinitionInput(graph: OntologyObjectStore, actions: string[]) {
  const functions = [...new Set(actions.flatMap(id => {
    const action = graph.model.action(id);
    return action.read?.mcp ? [...action.read.mcp.requires.flatMap(dependency => [dependency.evaluate, ...(dependency.derive ? [dependency.derive.function] : [])]), ...(action.read.module ? [action.read.module.completion.evaluate] : [])] : [];
  }))];
  return { search: 'ServiceRequest', limit: 1, actions: actions.slice(0, 8), functions: functions.slice(0, 20), includeLinks: false };
}
const MAX_CONTEXT_READ_BYTES = 200000;
const MAX_PLANNING_READS = 20;
const contextBudgetFeedback = { error: 'CONFLICT', message: 'This read exceeds the remaining context budget. Return a final decision using the successful receipts already delivered; unavailable evidence remains unknown.', nextAction: 'finalize_with_available_evidence' };
// Keep rejection feedback inside the existing result cap, including every call
// in a model-selected batch. Rejected payloads never become delivered evidence.
const contextFeedbackReserve = MAX_PLANNING_READS * Buffer.byteLength(JSON.stringify(contextBudgetFeedback));
class ContextReadBudgetExceeded extends DomainError {
  constructor() { super('CONFLICT', contextBudgetFeedback.message); }
}
export interface PlanningSessionOptions { taskContext?: TaskContextBinding; priorReads?: readonly PlanningReadReceipt[]; actionCatalog?: ExecutionCatalog }
function assertInstructionCoverage(context: NonNullable<PlanningReadReceipt['context']>, reads: PlanningReadReceipt[]) {
  if (!context.requireCompleteInstructions) return;
  const refs = [...new Map(reads.flatMap(receipt => receipt.instructionRefs ?? []).map(ref => [key(ref), ref])).values()];
  if (refs.length !== context.instructionCount || instructionCoverageDigest(refs) !== context.instructionRefsDigest) throw new DomainError('CONFLICT', 'Read the remaining original instruction pages before interpreting this request');
}

function relevantProperties(ref: ObjectRef, properties: Record<string, unknown>, request: ServiceRequest) {
  if (ref.type !== 'ServiceRequest' || ref.id !== request.id) return properties;
  const { progress: _progress, projectionState: _coverage, requestedOutcome: _selectedCapability, currentAssessment: _assessment, ...business } = properties;
  return business;
}
export function snapshotObject(graph: OntologyObjectStore, owner: string, ref: ObjectRef, request: ServiceRequest): ObjectSnapshot {
  const object = graph.read(owner, ref);
  return { ref, revision: object.revision, propertiesDigest: digest(relevantProperties(ref, object.properties, request)), linksDigest: graph.relationshipDigest(owner, ref, { remaining: 1000 }) };
}
export function validatePlanningSnapshot(graph: OntologyObjectStore, owner: string, request: ServiceRequest, snapshot: PlanningSnapshot, fresh: boolean): void {
  const check = () => validatePlanningSnapshotRaw(graph, owner, request, snapshot, fresh);
  return graph.security ? graph.security.readSnapshot(check) : check();
}
function validatePlanningSnapshotRaw(graph: OntologyObjectStore, owner: string, request: ServiceRequest, snapshot: PlanningSnapshot, fresh: boolean): void {
  if (graph.security && snapshot.accessDigest !== accessDigest()) throw new DomainError('FORBIDDEN', 'Planning authority changed; fresh authorized reads are required');
  graph = graph.forRequestReader(owner, request.id);
  const { digest: expected, ...body } = snapshot;
  if (!['model_queries', 'worker_context', 'worker_context_with_queries', 'trusted_template'].includes(snapshot.mode) || digest(body) !== expected || digest(snapshot.model) !== digest(graph.model.ref) || snapshot.requestRevision !== request.revision || snapshot.conditionsDigest !== digest(request.conditions ?? [])) throw new DomainError('CONFLICT', 'Ontology planning contract changed');
  if (snapshot.mode !== 'trusted_template') {
    if (snapshot.context) {
      const receipt = snapshot.reads.find(r => r.id === snapshot.context!.receiptId && r.tool === 'read_task_context' && r.status === 'ok');
      const { receiptId: _receiptId, ...context } = snapshot.context;
      if (!receipt?.context || digest(receipt.context) !== digest(context) || context.ownerDigest !== digest(owner) || context.requestId !== request.id || context.requestRevision !== request.revision || !receipt.definitions || digest(receipt.definitions.payload) !== receipt.definitions.payloadDigest || receipt.definitions.modelDigest !== graph.model.ref.digest || receipt.definitions.bindingDigest !== context.bindingDigest) throw new DomainError('CONFLICT', 'The model plan does not cite its actual owned task-context receipt');
      assertInstructionCoverage(context, snapshot.reads);
    } else if (!snapshot.reads.some(r => r.tool === 'describe_ontology' && r.status === 'ok') || !snapshot.reads.some(r => r.tool === 'query_ontology' && r.status === 'ok')) throw new DomainError('CONFLICT', 'A model plan requires actual definition and object reads');
  }
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
  private instructionBytes = 0;
  private contextBudgetExhausted = false;
  private failures = new Map<string, number>();
  private callObjects = new Map<string, ObjectSnapshot>();
  private callDelivered = new Map<string, ObjectSnapshot>();
  private acceptedIds?: Set<string>;
  private acceptedReadCount = 0;
  private knownRefs = new Map<string, ObjectRef>();
  constructor(readonly graph: OntologyObjectStore, private owner: string, readonly request: ServiceRequest,
    private candidates: ResolvedCandidate[] = [], private active: () => void = () => {}, private onRead: (receipt: PlanningReadReceipt) => void = () => {}, private readScope: 'owner' | 'request' = 'owner', private boundRefs: ObjectRef[] = [], private options: PlanningSessionOptions = {}) {
    this.graph = graph.forRequestReader(owner, request.id);
    if (options.taskContext) this.readScope = 'request';
    if (graph.security) this.boundRefs = [...new Map([...boundRefs, ...(authorizationScope()?.grant?.inputs.map(i => i.object) ?? [])].map(ref => [key(ref), ref])).values()];
  }
  /** A model has already selected the future bindings. Host verification reads
   * only their actual accepted objects; it never invents a new model decision. */
  hostEvidenceSession() {
    return new OntologyPlanningSession(this.graph, this.owner, this.request, this.candidates, this.active, this.onRead, this.readScope, this.boundRefs,
      {...this.options, taskContext:undefined, priorReads:undefined});
  }
  usesTaskContext() { return !!this.options.taskContext; }
  requiresFinalResponse() { return this.contextBudgetExhausted; }
  catalog() { return this.graph.security ? this.graph.security.readSnapshot(()=>this.catalogValue()) : this.catalogValue(); }
  private catalogValue() { const visible = this.graph.security ? describeAuthorized(this.graph.security.security, authorizationScope()!, {}, this.graph.model) : undefined; return { actionInputReadPolicy: { appliesTo: 'Every direct ObjectRef in selected action arguments', requiredEvidence: 'Actual current-decision ontology read', navigationAndHistoricalReadsSatisfy: false, missingReferencesQueriedAutomatically: false }, model: this.graph.model.ref, functions: visible?.functions ?? this.graph.model.functionsFor(['ServiceRequest', ...this.boundRefs.map(ref => ref.type)]), functionNavigationOnly: true, boundObjects: this.boundRefs.filter(ref => !this.graph.security || !!this.graph.security.binding(authorizationScope()!, ref)).map(ref => ({ ref, navigationOnly: true, readThisDecision: this.seen.has(key(ref)) })), tools: planningToolCatalog(this.usesTaskContext(), !!this.options.actionCatalog, !!this.graph.security), readScope: this.readScope, ...(this.usesTaskContext() ? { contextReadRequired: true, finalReceiptIdsRequired: true, instructionPages: { maxResultBytes: MAX_INSTRUCTION_READ_BYTES, completeReadRequired: this.options.taskContext!.purpose === 'grounding' } } : {}), scopeNote: this.readScope === 'request' ? 'Only the current task and its retrieved business objects. Traverse only task-owned nodes; shared provider or address metadata cannot be used to navigate into another request. Restricted properties remain unavailable.' : 'Owned business objects only; restricted properties remain unavailable.', maxToolCalls: MAX_PLANNING_READS, maxResultBytes: MAX_CONTEXT_READ_BYTES, remainingResultBytes: Math.max(0, MAX_CONTEXT_READ_BYTES - contextFeedbackReserve - this.bytes), finalResponseRequired: this.requiresFinalResponse() }; }
  receipts() { return structuredClone(this.reads); }
  lastReceipt() { return this.reads.length ? structuredClone(this.reads.at(-1)!) : undefined; }
  authorizeModel(channel?: string) { if (!this.graph.security) return; this.active(); this.graph.security.readSnapshot(()=>{secureRequest(this.graph,this.owner,this.request);assertModelChannel(this.graph,channel);}); }
  retrievedRefs() { return [...this.seen.values()].map(o => o.ref); }
  acceptReceipts(ids: string[]): void {
    this.active();
    if (!ids.length || ids.length > 20 || new Set(ids).size !== ids.length || ids.some(id => !this.reads.some(receipt => receipt.id === id && receipt.status === 'ok'))) throw new DomainError('CONFLICT', 'A decision must cite successful receipts actually returned in this model session');
    if (this.usesTaskContext()) {
      const current = this.reads.findLast(receipt => receipt.tool === 'read_task_context' && receipt.status === 'ok');
      if (!current?.context || !ids.includes(current.id)) throw new DomainError('CONFLICT', 'A decision must cite the current task-context receipt');
      assertTaskContextCurrent(this.graph, this.owner, current.context);
      assertInstructionCoverage(current.context, this.reads.filter(receipt => ids.includes(receipt.id)));
    }
    this.acceptedIds = new Set(ids); this.acceptedReadCount = this.reads.length;
  }
  modelSessionKey() { return modelSessionKey(this.owner, this.request, this.graph.model.ref); }
  /** Fresh task-local context only. Definitions determine pure source checks;
   * no adapter, source transport, business action or decision is invoked here. */
  prepareContext(options: { actions?: string[]; refs?: ObjectRef[] } = {}) {
    this.active();
    const startedAt = new Date().toISOString();
    if (this.reads.length) throw new DomainError('CONFLICT', 'Worker context must precede model queries in this decision');
    const definitionInput = contextDefinitionInput(this.graph, options.actions ?? []), functionIds = definitionInput.functions;
    const entries: { call: { tool: string; argumentsJson: string }; result: unknown; receiptId: string }[] = [];
    const read = (tool: string, input: unknown) => {
      const remaining = contextLimits.bytes - this.bytes;
      if (entries.length >= contextLimits.reads || remaining < 1000) return false;
      const result = this.call(tool, input, { origin: 'worker_context', maxOutputBytes: tool === 'read_task_context' ? remaining : Math.min(contextLimits.resultBytes, remaining) });
      const receipt = this.reads.at(-1)!;
      entries.push({ call: { tool, argumentsJson: JSON.stringify(input) }, result, receiptId: receipt.id });
      return receipt.status === 'ok';
    };
    if (this.usesTaskContext()) read('read_task_context', {});
    read('describe_ontology', definitionInput);
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
  private remember(ref: ObjectRef, expectedRevision?: number, delivered = false) {
    const next = snapshotObject(this.graph, this.owner, ref, this.request), old = this.seen.get(key(ref));
    if (expectedRevision !== undefined && next.revision !== expectedRevision) throw new DomainError('CONFLICT', 'Object changed after its query result');
    if (old && (old.propertiesDigest !== next.propertiesDigest || old.linksDigest !== next.linksDigest || ref.type !== 'ServiceRequest' && old.revision !== next.revision)) throw new DomainError('CONFLICT', 'Object changed between reasoning reads');
    this.seen.set(key(ref), next);
    this.callObjects.set(key(ref), next);
    if (delivered) this.callDelivered.set(key(ref), next);
    if (this.seen.size > 150) throw new DomainError('CONFLICT', 'Planner object budget exceeded');
  }
  private retrieved(ref: ObjectRef, allowBoundQuery = false) {
    if (ref.type === 'ServiceRequest' && ref.id === this.request.id) return;
    if (allowBoundQuery && (this.boundRefs.some(bound => key(bound) === key(ref)) || this.knownRefs.has(key(ref)))) return;
    if (!this.seen.has(key(ref))) throw new DomainError('FORBIDDEN', 'Read the owned object before using its reference');
  }
  private managedDiscovery() {
    return this.options.taskContext?.managedDiscoveryTypes && this.reads.some(read => read.tool === 'read_task_context' && read.status === 'ok')
      ? this.options.taskContext.managedDiscoveryTypes : undefined;
  }
  private managedRelationship(from: ObjectRef, link: string): boolean {
    if (!this.managedDiscovery() || !isSharedManagedType(this.graph.model, from.type)) return false;
    const navigation = this.graph.model.navigation(from.type, link);
    return navigation.direction === 'forward' && this.graph.model.linkWritePolicy(navigation.link.id) === 'managed'
      && this.graph.model.concreteTypes(navigation.other.type).every(type => isSharedManagedType(this.graph.model, type));
  }
  call(tool: string, input: unknown, options?: { origin: 'worker_context'; maxOutputBytes: number }): unknown {
    this.active();
    if (this.graph.security && !authorizationScope()?.synchronousRead) return this.graph.security.readSnapshot(() => this.call(tool, input, options));
    if (this.reads.length >= MAX_PLANNING_READS) throw new DomainError('CONFLICT', 'Planner tool-call limit reached');
    const before = new Map(this.seen), knownBefore = new Map(this.knownRefs), proposalCount = this.proposals.length, receiptId = randomUUID();
    this.callObjects = new Map(); this.callDelivered = new Map();
    const datasetRevision = this.graph.revision(this.owner);
    let output: unknown, status: PlanningReadReceipt['status'] = 'ok';
    let contextRead: TaskContextRead | undefined;
    let actionDiscovery: ActionDiscoveryPage | undefined;
    let instructionRefs: ObjectRef[] = [], instructionPage = false;
    try {
      if (this.contextBudgetExhausted) throw new ContextReadBudgetExceeded();
      if (tool === 'read_task_context') {
        if (!this.options.taskContext) throw new DomainError('FORBIDDEN', 'This session has no task-context binding');
        const args = taskContextSchema.parse(input);
        contextRead = readTaskContext(this.graph, this.owner, this.request.id, this.request.revision, this.options.taskContext, receiptId, [...(this.options.priorReads ?? []), ...this.reads], args);
        for (const ref of contextRead.deliveredRefs) this.remember(ref, undefined, true);
        for (const ref of contextRead.data.graph.unreadRefs) this.knownRefs.set(key(ref), ref);
        instructionRefs = contextRead.instructionRefs;
        output = contextRead.data;
      } else if (tool === 'read_task_instructions') {
        if (!this.options.taskContext || !this.reads.some(receipt => receipt.tool === 'read_task_context' && receipt.status === 'ok')) throw new DomainError('FORBIDDEN', 'Read the current task context before its original instruction pages');
        const result = readTaskInstructions(this.graph, this.owner, this.request.id, this.request.revision, taskInstructionsSchema.parse(input));
        for (const object of result.items) this.remember(object.ref, object.revision, true);
        instructionRefs = result.items.map(object => object.ref); instructionPage = true; output = result;
      } else if (tool === 'discover_actions') {
        if (!this.options.actionCatalog) throw new DomainError('FORBIDDEN', 'This planning session has no action catalog binding');
        if (this.usesTaskContext() && !this.reads.some(read => read.tool === 'read_task_context' && read.status === 'ok')) throw new DomainError('FORBIDDEN', 'Read the current task context before discovering action bindings');
        actionDiscovery = this.options.actionCatalog.discoverActions(this.graph, this.owner, this.request, actionDiscoverySchema.parse(input));
        output = actionDiscovery;
      } else if (tool === 'describe_ontology') {
        const { includeSchemas = false, includeLinks = true, includeConditionSchema = false, actions, functions, ...args } = describeSchema.parse(input), result = this.graph.model.describe(args);
        if (this.graph.security) {
          const visible=describeAuthorized(this.graph.security.security,authorizationScope()!,args,this.graph.model);
          if (actions?.some(id=>!visible.actions.some(a=>a.id===id)) || functions?.some(id=>!visible.functions.some(f=>f.id===id))) throw new DomainError('FORBIDDEN','Definition is not available');
          const selected=actions?visible.actions.filter(a=>actions.includes(a.id)):visible.actions;
          output={...visible,schemaDetail:includeSchemas?'full':'summary',types:visible.types.map(({properties,links,...definition})=>({
            ...definition,...(includeLinks?{links}:{linksAvailable:true}),properties:includeSchemas?properties:Object.fromEntries(Object.entries(properties).map(([name,{schema:_schema,...metadata}])=>[name,metadata])),
          })),actions:selected.map(action=>{
            if(includeSchemas || actions)return action;
            const {read,operation,...summary}=action;
            const compact=(metadata:NonNullable<typeof read|typeof operation>)=>{const {inputSchema,...rest}=metadata;return {...rest,inputKeys:Object.keys((inputSchema as {properties?:object}).properties??{}),schemaAvailable:true};};
            return {...summary,...(read?{read:compact(read)}:{}),...(operation?{operation:compact(operation)}:{})};
          }),functions:(functions?visible.functions.filter(f=>functions.includes(f.id)):visible.functions).map(fn=>{
            if(includeSchemas || functions)return fn;
            const {inputSchema,...summary}=fn;return {...summary,...(inputSchema?{schemaAvailable:true}:{})};
          }),
            ...(includeConditionSchema?{conditionSchema:z.toJSONSchema(businessConditionSchema)}:{})};
        } else {
        const selected = actions ? actions.map(id => ({ ...this.graph.model.action(id), execution: 'definition_only' })) : result.actions;
        const describedActions = selected.filter(action => !this.options.taskContext?.program || this.options.taskContext.program.actionIds.includes(action.id)).map(action => {
          if (includeSchemas || actions) return action;
          const { read, operation, inputSchema, implementation, composition, ...summary } = action;
          const compact = (metadata: NonNullable<typeof read | typeof operation>) => {
            const { inputSchema, ...rest } = metadata;
            return { ...rest, inputKeys: Object.keys((inputSchema as { properties?: object }).properties ?? {}), schemaAvailable: true };
          };
          return { ...summary, ...(read ? { read: compact(read) } : {}), ...(operation ? { operation: compact(operation) } : {}),
            ...(composition ? { compositionSummary: compositionSummary(composition) } : {}),
            ...(inputSchema ? { inputKeys: Object.keys((inputSchema as { properties?: object }).properties ?? {}), inputSchemaAvailable: true } : {}),
            ...(implementation ? { implementationSummary: implementation.kind === 'declarative' ? { kind: implementation.kind, version: implementation.version, mutations: implementation.mutations.length, conditions: implementation.conditions.length, ...(implementation.resultFacts ? { resultFacts: implementation.resultFacts } : {}) } : { kind: implementation.kind, handlerRef: implementation.handlerRef } } : {}) };
        });
        output = { ...result, schemaDetail: includeSchemas ? 'full' : 'summary', types: result.types.map(type => {
          const value = type as { properties: Record<string, Record<string, unknown>>; links?: unknown };
          const { links, ...definition } = value;
          return { ...definition, ...(includeLinks ? { links } : { linksAvailable: true }), properties: includeSchemas ? value.properties : Object.fromEntries(Object.entries(value.properties).map(([name, p]) => { const { schema: _schema, ...metadata } = p; return [name, metadata]; })) };
        }), actions: describedActions, functions: functions ? functions.map(id => this.graph.model.function(id)) : result.functions, ...(includeConditionSchema ? { conditionSchema: z.toJSONSchema(businessConditionSchema) } : {}) };
        }
      }
      else if (tool === 'query_ontology') {
        let query = objectQuerySchema.parse(input);
        let discovery = false;
        if (this.readScope === 'request' && !this.graph.security) {
          if ('type' in query) {
            if (query.type === 'ServiceRequest') {
              const { type: _type, ...fields } = query;
              query = { ...fields, object: { type: 'ServiceRequest', id: this.request.id } };
            } else {
              const allowed = this.managedDiscovery(), types = this.graph.model.concreteTypes(query.type);
              if (!allowed || !types.length || types.some(type => !allowed.includes(type) || !isSharedManagedType(this.graph.model, type))) throw new DomainError('FORBIDDEN', 'This task permits only bound objects and its host-authorized managed discovery types');
              discovery = true;
            }
          } else if ('object' in query) {
            this.retrieved(query.object, true);
            if (taskObjectMembership(this.graph, this.owner, this.request, query.object) === 'foreign') throw new DomainError('FORBIDDEN', 'Object belongs to another request or revision');
          } else if (taskObjectMembership(this.graph, this.owner, this.request, query.from) !== 'current') {
            if (!this.managedRelationship(query.from, query.link)) throw new DomainError('FORBIDDEN', 'Relationships require a current task object or an authorized forward managed link');
            discovery = true;
          }
        }
        if ('from' in query) this.retrieved(query.from);
        const queryScope = discovery ? digest({ requestId: this.request.id, requestRevision: this.request.revision, binding: this.options.taskContext?.program, types: this.managedDiscovery() }) : undefined;
        const result = this.graph.query(this.owner, query, undefined, queryScope);
        for (const object of result.items) {
          if (this.readScope === 'request' && !this.graph.security && taskObjectMembership(this.graph, this.owner, this.request, object.ref) === 'foreign') throw new DomainError('FORBIDDEN', 'Relationship points outside the current task revision');
          this.remember(object.ref, object.revision, true);
          if (object.ref.type === 'RequestInstruction' && typeof object.properties.text === 'string') instructionRefs.push(object.ref);
        }
        instructionPage = !!result.items.length && result.items.every(object => object.ref.type === 'RequestInstruction');
        output = this.graph.security ? { items: result.items.map(({ref, revision, properties, derived}) => ({ref, revision, properties, ...(derived ? {derived} : {})})), page: {limit: result.page.limit, hasMore: result.page.hasMore, cursor: result.page.cursor} } : result;
      } else if (tool === 'evaluate_ontology') {
        if (this.graph.security) { const candidate = secureFunctionCallSchema.parse(input); this.graph.security.requireResource(authorizationScope()!, 'function', candidate.function); }
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
        if (this.graph.security) this.graph.security.requireResource(authorizationScope()!, 'actionType', args.action);
        if (definition.read || definition.operation || this.graph.model.actionImplementation(definition.id)?.kind === 'declarative') throw new DomainError('INVALID_INPUT', 'Source reads, managed writes and sandbox operations are selected in an agent execute decision with their registered input and authorization checks; this tool only describes business decision proposals');
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
      if (!instructionPage && this.bytes + Buffer.byteLength(JSON.stringify(output)) > MAX_CONTEXT_READ_BYTES - contextFeedbackReserve) {
        this.contextBudgetExhausted = true;
        throw new ContextReadBudgetExceeded();
      }
    } catch (error) {
      if (!(error instanceof DomainError || error instanceof z.ZodError)) throw error;
      status = 'rejected'; output = error instanceof ContextReadBudgetExceeded ? { ...contextBudgetFeedback } : { error: error instanceof DomainError ? error.code : 'INVALID_INPUT', message: error instanceof DomainError ? error.message : 'Input does not match the published tool schema' };
      this.seen = before; this.knownRefs = knownBefore; this.proposals.length = proposalCount;
      this.callObjects.clear(); this.callDelivered.clear(); contextRead = undefined; actionDiscovery = undefined;
      instructionRefs = []; instructionPage = false;
      if (!(error instanceof ContextReadBudgetExceeded)) {
        const failure = digest({ tool, input, output }), count = (this.failures.get(failure) ?? 0) + 1; this.failures.set(failure, count);
        if (count >= 3) throw new DomainError('CONFLICT', 'Three identical planning read failures; stop and report the unresolved input');
      }
    }
    if (options && Buffer.byteLength(JSON.stringify(output)) > options.maxOutputBytes) {
      this.seen = before; this.knownRefs = knownBefore; this.proposals.length = proposalCount;
      this.callObjects.clear(); this.callDelivered.clear();
      contextRead = undefined; actionDiscovery = undefined; instructionRefs = []; instructionPage = false;
      status = 'rejected'; output = { error: 'CONTEXT_NOT_INCLUDED', message: 'The result exceeds the bounded initial Worker context. Request a narrower selection.' };
    }
    if (instructionPage) this.instructionBytes += Buffer.byteLength(JSON.stringify(output));
    else this.bytes += Buffer.byteLength(JSON.stringify(output));
    if (this.bytes > MAX_CONTEXT_READ_BYTES) throw new DomainError('CONFLICT', 'Planner context byte budget exceeded');
    if (this.instructionBytes > MAX_INSTRUCTION_READ_BYTES) throw new DomainError('CONFLICT', 'Original instruction read budget exhausted for this reasoning session');
    this.active();
    const receipt: PlanningReadReceipt = { id: receiptId, at: new Date().toISOString(), tool, inputDigest: digest(input), outputDigest: digest(output), datasetRevision: this.graph.revision(this.owner), status, origin: options?.origin ?? 'model', ...(this.graph.security ? { accessDigest: accessDigest(), ...(authorizationScope()!.lineage.size ? {securityEnvelope: this.graph.security.outputEnvelope(this.owner)} : {}) } : {}), outputBytes: Buffer.byteLength(JSON.stringify(output)),
      objects: [...this.callObjects.values()], deliveredObjects: [...this.callDelivered.values()], instructionRefs, ...(contextRead ? { context: contextRead.context, definitions: contextRead.definitions } : {}),
      ...(actionDiscovery ? { actionBindings: { snapshotDigest: actionDiscovery.snapshotDigest, pins: actionDiscovery.items.flatMap(item => item.bindings.map(binding => binding.pin)) } } : {}) };
    this.reads.push(receipt);
    this.onRead(receipt);
    return contextRead ? { data: output, receipt: { id: receipt.id, tool: receipt.tool, status: receipt.status, outputDigest: receipt.outputDigest } } : output;
  }
  finish(candidate?: ResolvedCandidate): PlanningSnapshot {
    this.active();
    if (this.usesTaskContext() && (!this.acceptedIds || this.acceptedReadCount !== this.reads.length)) throw new DomainError('CONFLICT', 'The model must acknowledge the actual task-context and read receipts after its last read');
    const reads = this.usesTaskContext() ? this.receipts().filter(receipt => this.acceptedIds!.has(receipt.id)) : this.receipts();
    const contextReceipt = this.usesTaskContext() ? reads.findLast(receipt => receipt.tool === 'read_task_context' && receipt.status === 'ok') : undefined;
    if (this.usesTaskContext()) {
      if (!contextReceipt?.context) throw new DomainError('CONFLICT', 'The model skipped the required task-context read');
      assertTaskContextCurrent(this.graph, this.owner, contextReceipt.context);
    }
    const conditionChecks = assessConditions(this.graph, this.owner, this.request, candidate?.ontologySubject);
    this.callObjects = new Map(); this.callDelivered = new Map();
    for (const check of conditionChecks) for (const ref of [...(check.subject ? [check.subject] : []), ...check.evidenceRefs]) this.remember(ref);
    const dependencies = this.usesTaskContext() ? new Map([...reads.flatMap(receipt => receipt.objects), ...this.callObjects.values()].map(object => [key(object.ref), object])) : this.seen;
    const deliveredObjects = [...new Map(reads.flatMap(receipt => receipt.deliveredObjects ?? []).map(object => [key(object.ref), object])).values()];
    const result = planningSnapshot({ mode: reads.some(read => read.origin === 'worker_context') ? reads.every(read => read.origin === 'worker_context') ? 'worker_context' : 'worker_context_with_queries' : 'model_queries', model: this.graph.model.ref, requestRevision: this.request.revision, conditionsDigest: digest(this.request.conditions ?? []), ...(this.graph.security ? {accessDigest: accessDigest()} : {}),
      reads, objects: [...dependencies.values()].filter(object => !this.usesTaskContext() || !isExecutionBookkeepingType(object.ref.type)), ...(this.usesTaskContext() ? { deliveredObjects, context: { ...contextReceipt!.context!, receiptId: contextReceipt!.id } } : {}),
      conditionChecks, actionProposals: structuredClone(this.proposals) });
    validatePlanningSnapshot(this.graph, this.owner, this.request, result, true);
    return result;
  }
}
