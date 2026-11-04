import { graphRead, graphQuery, graphRelated, graphEvaluate, graphRevision, graphRelationshipDigest, graphMap, graphPlanningCall, graphRecordPlanningRead, graphDiscoverActions, type GraphProgram, type ProjectionMetadata } from '../ontology/graph-program.js';
import type { SecurityEnvelope } from '../security/envelope.js';
import { readRequestedFactsProgram, type RequestedFactsResult, requestedFactsSchema, type RequestedFacts } from './requested-facts.js';
import { randomUUID } from 'node:crypto';
import { assertPersonalFactsCurrentProgram } from '../core/personal-context.js';
import { z } from 'zod';
import { compositionSummary } from '../ontology/composition-contract.js';
import { DomainError } from '../core/domain.js';
import { digest } from '../core/delegation.js';
import { objectRefSchema, linkSearchSchema, type ObjectRef } from '../ontology/model.js';
import { objectQuerySchema, type OntologyObjectStore, type ObjectQuery, type OntologyQueryResult, type ObjectView } from '../ontology/object-store.js';
import { functionCallSchema } from '../ontology/object-functions.js';
import { planningSnapshot, type PlanningReadReceipt, type ObjectSnapshot, type DecisionActionProposal, type PlanningSnapshot } from '../ontology/planning-contract.js';
import type { ResolvedCandidate, ServiceRequest } from '../ontology/execution.js';
import { assessConditionsProgram, hardConditionsPass } from './conditions.js';
import { serviceDomains } from '../ontology/service-domains.js';
import { businessConditionSchema } from '../ontology/business-model.js';
import type { DomainAssessment } from '../ontology/domain-rules.js';
import { compactSchema } from './prompt-data.js';
import { isExecutionBookkeepingType } from '../ontology/execution-model.js';
import { isSharedManagedType } from '../ontology/managed-discovery.js';
import {  assertTaskContextCurrentProgram, instructionCoverageDigest, MAX_INSTRUCTION_READ_BYTES,  readTaskContextProgram,  readTaskInstructionsProgram, taskContextSchema, taskInstructionsSchema,  taskObjectMembershipProgram, type TaskContextBinding, type TaskContextRead } from './task-context.js';
import { actionDiscoverySchema, type ActionDiscoveryPage } from '../core/action-bindings.js';
import type { ExecutionCatalog } from '../core/catalog.js';
import type { authorizedDefinitions, describeAuthorized } from '../security/view.js';
import { secureFunctionCallSchema } from '../security/view-contracts.js';

export interface PlanningAuthority {
 accessDigest():string|undefined;
 definitions():ReturnType<typeof authorizedDefinitions>;
 describe(input:Parameters<typeof describeAuthorized>[2]):ReturnType<typeof describeAuthorized>;
 binding(ref:ObjectRef):boolean;
 requireResource(kind:string,id:string):void;
 receipt():{accessDigest?:string;securityEnvelope?:SecurityEnvelope};
}
export type PlanningMetadata=ProjectionMetadata & {
 readonly authorization?:PlanningAuthority;
 /** Host-only synchronous read window. Async storage omits this port and
  * continues yielding checked operations inside its existing transaction. */
 readonly runReadWindow?:<T>(owner:string,program:GraphProgram<T>)=>T;
};
function authority(graph:PlanningMetadata):PlanningAuthority {if(!graph.authorization)throw new DomainError('FORBIDDEN','Planning authority is unavailable');return graph.authorization;}
export interface PreparedPlanningContext {
 entries:{call:{tool:string;argumentsJson:string};result:unknown;receiptId:string}[];
 model:OntologyObjectStore['model']['ref'];requestRevision:number;receiptIds:string[];startedAt:string;preparedAt:string;digest:string;
}

const describeSchema = z.object({ functions: z.array(z.string().min(1).max(80)).max(20).optional(), includeLinks: z.boolean().optional(), linkSearch: linkSearchSchema, kind: z.enum(['types', 'actions', 'functions']).optional().describe('Types return related contracts only; actions/functions pages enumerate their complete catalogues'), search: z.string().max(100).optional(), limit: z.number().int().min(1).max(5).optional(), after: z.string().max(80).optional(), actions: z.array(z.string().min(1).max(80)).max(8).optional().describe('Exact action IDs whose complete input schemas are needed; otherwise concise action summaries'), includeConditionSchema: z.boolean().optional().describe('Request the full typed business-condition contract when grounding domain conditions'), includeSchemas: z.boolean().optional().describe('Request full property and action schemas; default returns concise names, semantics and links') }).strict();
const assessmentSchema = z.object({ candidateId: z.string().max(200).optional(), subject: objectRefSchema.optional(), phase: z.enum(['precondition', 'result']).optional() }).strict();
const actionSchema = z.object({ action: z.string().min(1).max(80), inputs: z.array(z.object({ name: z.string().min(1).max(80), object: objectRefSchema, revision: z.number().int().positive() }).strict()).min(1).max(8) }).strict();
export const planningQuerySchema = z.union([...objectQuerySchema.options, z.object({ facts: requestedFactsSchema }).strict()]);
export const planningToolSchemas = { read_task_context: taskContextSchema, read_task_instructions: taskInstructionsSchema, describe_ontology: describeSchema, discover_actions: actionDiscoverySchema, query_ontology: planningQuerySchema, evaluate_ontology: functionCallSchema, assess_conditions: assessmentSchema, propose_action: actionSchema };
export const planningToolCatalog = (taskContext = false, actionCatalog = false, secured = false) => Object.entries(planningToolSchemas).filter(([name]) => (taskContext || !['read_task_context', 'read_task_instructions'].includes(name)) && (actionCatalog || name !== 'discover_actions')).map(([name, schema]) => {
  const input = secured && name === 'evaluate_ontology' ? secureFunctionCallSchema : schema;
  const described = name === 'evaluate_ontology' ? input.describe('Outer status known means the computation returned a result; inspect value for the business verdict. Source-specific observation checks validate their own snapshot, not whether a newer observation supersedes it. Check current business facts through their registered observation contract.') : input;
  return { name, inputSchema: compactSchema(z.toJSONSchema(described)), readOnly: true, executionAllowed: false };
});
const key = (ref: ObjectRef) => JSON.stringify(ref);
const contextLimits = { reads: 10, bytes: 80000, resultBytes: 30000, refs: 8 } as const;
export const modelSessionKey = (owner: string, request: ServiceRequest, model: OntologyObjectStore['model']['ref'], access: string | undefined = undefined) => digest({ owner, requestId: request.id, revision: request.revision, model, accessDigest: access });
export function contextDefinitionInput(graph: ProjectionMetadata, actions: string[]) {
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
export function* snapshotObjectProgram(graph: PlanningMetadata, owner: string, ref: ObjectRef, request: ServiceRequest):GraphProgram<ObjectSnapshot> {
  const object = (yield* graphRead(owner, ref));
  return { ref, revision: object.revision, propertiesDigest: digest(relevantProperties(ref, object.properties, request)), linksDigest: (yield* graphRelationshipDigest(owner, ref, { remaining: 1000 })) };
}

export function* validatePlanningSnapshotProgram(graph: PlanningMetadata, owner: string, request: ServiceRequest, snapshot: PlanningSnapshot, fresh: boolean):GraphProgram<void> {
  if (fresh) (yield* assertPersonalFactsCurrentProgram(graph, owner, request));
  if (graph.security && snapshot.accessDigest !== authority(graph).accessDigest()) throw new DomainError('FORBIDDEN', 'Planning authority changed; fresh authorized reads are required');
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
    const current = (yield* snapshotObjectProgram(graph, owner, old.ref, request));
    const currentRequest = old.ref.type === 'ServiceRequest' && old.ref.id === request.id;
    if ((!currentRequest && current.revision !== old.revision) || current.propertiesDigest !== old.propertiesDigest || current.linksDigest !== old.linksDigest) throw new DomainError('CONFLICT', 'An object used by the planner changed; replan before dispatch');
  }
  const bound = { ...request, conditions: request.conditions?.map(c => {
    const subject = snapshot.conditionChecks.find(check => check.conditionId === c.id)?.subject;
    return subject ? businessConditionSchema.parse({ ...c, subject: { ...c.subject, object: subject } }) : c;
  }) };
  if (!hardConditionsPass((yield* assessConditionsProgram(graph, owner, bound, undefined, 'precondition')), 'precondition')) throw new DomainError('CONFLICT', 'Business precondition evidence expired or changed before dispatch');
}

/** One request-scoped model interaction. Data access uses the existing authenticated owner. */
export class PlanningSessionState {
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
constructor(readonly graph: PlanningMetadata, private owner: string, readonly request: ServiceRequest, private candidates: ResolvedCandidate[] = [], private active: () => void = () => {}, private readScope: 'owner' | 'request' = 'owner', private boundRefs: ObjectRef[] = [], private options: PlanningSessionOptions = {}) {if(options.taskContext)this.readScope='request';}
/** Fork only data state for one RPC. An outer transaction adopts it after
 * COMMIT; a failed read, receipt write or commit leaves the old state intact. */
fork(graph: PlanningMetadata) {
  const next = new PlanningSessionState(graph, this.owner, this.request, this.candidates, this.active, this.readScope, this.boundRefs, this.options);
  next.adopt(this); return next;
}
adopt(other: PlanningSessionState) {
  if (this.owner !== other.owner || digest(this.request) !== digest(other.request) || digest(this.graph.model.ref) !== digest(other.graph.model.ref)) throw new DomainError('CONFLICT', 'Planning session state belongs to another request');
  this.reads = structuredClone(other.reads); this.seen = structuredClone(other.seen); this.proposals = structuredClone(other.proposals);
  this.bytes = other.bytes; this.instructionBytes = other.instructionBytes; this.contextBudgetExhausted = other.contextBudgetExhausted;
  this.failures = new Map(other.failures); this.callObjects = structuredClone(other.callObjects); this.callDelivered = structuredClone(other.callDelivered);
  this.acceptedIds = other.acceptedIds && new Set(other.acceptedIds); this.acceptedReadCount = other.acceptedReadCount;
  this.knownRefs = structuredClone(other.knownRefs);
}

usesTaskContext() { return !!this.options.taskContext; }
requiresFinalResponse() { return this.contextBudgetExhausted; }
readBudget() {
    return {readsRemaining:Math.max(0,MAX_PLANNING_READS-this.reads.length),maxResultBytes:MAX_CONTEXT_READ_BYTES,
      remainingResultBytes:Math.max(0,MAX_CONTEXT_READ_BYTES-contextFeedbackReserve-this.bytes),finalResponseRequired:this.requiresFinalResponse()};
  }
catalog() { const visible = this.graph.security ? authority(this.graph).definitions() : undefined; return { actionInputReadPolicy: { appliesTo: 'Every direct ObjectRef in selected action arguments', requiredEvidence: 'Actual current-decision ontology read', navigationAndHistoricalReadsSatisfy: false, missingReferencesQueriedAutomatically: false }, model: this.graph.model.ref, functions: visible?.functions ?? this.graph.model.functionsFor(['ServiceRequest', ...this.boundRefs.map(ref => ref.type)]), functionNavigationOnly: true, boundObjects: this.boundRefs.filter(ref => !this.graph.security || !!authority(this.graph).binding(ref)).map(ref => ({ ref, navigationOnly: true, readThisDecision: this.seen.has(key(ref)) })), tools: planningToolCatalog(this.usesTaskContext(), !!this.options.actionCatalog, !!this.graph.security), readScope: this.readScope, ...(this.usesTaskContext() ? { contextReadRequired: true, finalReceiptIdsRequired: true, instructionPages: { maxResultBytes: MAX_INSTRUCTION_READ_BYTES, completeReadRequired: this.options.taskContext!.purpose === 'grounding' } } : {}), scopeNote: this.readScope === 'request' ? 'Only the current task and its retrieved business objects. Traverse only task-owned nodes; shared provider or address metadata cannot be used to navigate into another request. Restricted properties remain unavailable.' : 'Owned business objects only; restricted properties remain unavailable.', maxToolCalls: MAX_PLANNING_READS, maxResultBytes: MAX_CONTEXT_READ_BYTES, remainingResultBytes: Math.max(0, MAX_CONTEXT_READ_BYTES - contextFeedbackReserve - this.bytes), finalResponseRequired: this.requiresFinalResponse() }; }
receipts() { return structuredClone(this.reads); }
lastReceipt() { return this.reads.length ? structuredClone(this.reads.at(-1)!) : undefined; }
retrievedRefs() { return [...this.seen.values()].map(o => o.ref); }
*acceptReceiptsProgram(ids: string[]):GraphProgram<void> {
    this.active();
    if (!ids.length || ids.length > 20 || new Set(ids).size !== ids.length || ids.some(id => !this.reads.some(receipt => receipt.id === id && receipt.status === 'ok'))) throw new DomainError('CONFLICT', 'A decision must cite successful receipts actually returned in this model session');
    if (this.usesTaskContext()) {
      const current = this.reads.findLast(receipt => receipt.tool === 'read_task_context' && receipt.status === 'ok');
      if (!current?.context || !ids.includes(current.id)) throw new DomainError('CONFLICT', 'A decision must cite the current task-context receipt');
      (yield* assertTaskContextCurrentProgram(this.graph, this.owner, current.context));
      assertInstructionCoverage(current.context, this.reads.filter(receipt => ids.includes(receipt.id)));
    }
    this.acceptedIds = new Set(ids); this.acceptedReadCount = this.reads.length;
  }
modelSessionKey() {return modelSessionKey(this.owner,this.request,this.graph.model.ref,this.graph.security?authority(this.graph).accessDigest():undefined);}
*prepareContextProgram(options: { actions?: string[]; refs?: ObjectRef[]; includeDefinitions?: boolean; includeLinkedFacts?: boolean } = {}):GraphProgram<PreparedPlanningContext> {
    this.active();
    const startedAt = new Date().toISOString();
    if (this.reads.length) throw new DomainError('CONFLICT', 'Worker context must precede model queries in this decision');
    const definitionInput = contextDefinitionInput(this.graph, options.actions ?? []), functionIds = definitionInput.functions;
    const entries: { call: { tool: string; argumentsJson: string }; result: unknown; receiptId: string }[] = [];
    const readProgram = (function* (this: PlanningSessionState, tool: string, input: unknown){
      const remaining = contextLimits.bytes - this.bytes;
      if (entries.length >= contextLimits.reads || remaining < 1000) return false;
      const result = (yield* graphPlanningCall(tool, input, { origin: 'worker_context', maxOutputBytes: tool === 'read_task_context' ? remaining : Math.min(contextLimits.resultBytes, remaining) }));
      const receipt = this.reads.at(-1)!;
      entries.push({ call: { tool, argumentsJson: JSON.stringify(input) }, result, receiptId: receipt.id });
      return receipt.status === 'ok';
    }).bind(this);
    const hasContext = this.usesTaskContext() && (yield* readProgram('read_task_context', {
      ...(options.includeDefinitions === false ? { includeDefinitions: false } : {}), ...(options.includeLinkedFacts ? { includeLinkedFacts: true } : {}),
    }));
    (yield* readProgram('describe_ontology', definitionInput));
    const refs = [{ type: 'ServiceRequest', id: this.request.id }, ...(options.refs ?? [])]
      .filter((ref, index, all) => all.findIndex(value => key(value) === key(ref)) === index).slice(0, contextLimits.refs);
    const queried: ObjectRef[] = [];
    for (const ref of refs) {
      const delivered = hasContext && this.reads[0]?.deliveredObjects?.some(object => key(object.ref) === key(ref));
      if (delivered || (yield* readProgram('query_ontology', { object: ref }))) queried.push(ref);
    }
    for (const ref of queried) for (const id of functionIds) {
      if (this.graph.model.function(id).inputTypes.some(type => this.graph.model.implements(ref.type, type))) (yield* readProgram('evaluate_ontology', { function: id, object: ref }));
    }
    this.active();
    const metadata = { model: this.graph.model.ref, requestRevision: this.request.revision };
    return { entries, ...metadata, receiptIds: entries.map(entry => entry.receiptId), startedAt, preparedAt: new Date().toISOString(), digest: digest({ ...metadata, reads: this.receipts() }) };
  }
private *rememberProgram(ref: ObjectRef, expectedRevision?: number, delivered = false):GraphProgram<void> {
    const next = (yield* snapshotObjectProgram(this.graph, this.owner, ref, this.request)), old = this.seen.get(key(ref));
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
private *queryDataProgram(input: ObjectQuery):GraphProgram<OntologyQueryResult> {
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
        if ((yield* taskObjectMembershipProgram(this.graph, this.owner, this.request, query.object)) === 'foreign') throw new DomainError('FORBIDDEN', 'Object belongs to another request or revision');
      } else if ((yield* taskObjectMembershipProgram(this.graph, this.owner, this.request, query.from)) !== 'current') {
        if ((yield* taskObjectMembershipProgram(this.graph, this.owner, this.request, query.from)) === 'foreign') throw new DomainError('FORBIDDEN', 'Relationship origin belongs to another request or revision');
        const nav = this.graph.model.navigation(query.from.type, query.link, query.as);
        const view = query.as && (this.graph.model.describeType(query.as) as { projectionOnly?: boolean }).projectionOnly && nav.direction === 'forward';
        if (!view && !this.managedRelationship(query.from, nav.side.name)) throw new DomainError('FORBIDDEN', 'Relationships require a current task object or an authorized forward managed link');
        discovery = true;
      }
    }
    if ('from' in query) this.retrieved(query.from, !!query.as);
    const queryScope = discovery ? digest({ requestId: this.request.id, requestRevision: this.request.revision, binding: this.options.taskContext?.program, types: this.managedDiscovery() }) : undefined;
    const result = (yield* graphQuery(this.owner, query, undefined, queryScope));
    if ('from' in query && query.as) (yield* this.rememberProgram(query.from));
    for (const object of result.items) {
      if (this.readScope === 'request' && !this.graph.security && (yield* taskObjectMembershipProgram(this.graph, this.owner, this.request, object.ref)) === 'foreign') throw new DomainError('FORBIDDEN', 'Relationship points outside the current task revision');
      (yield* this.rememberProgram(object.ref, object.revision, true));
    }
    return result;
  }
private *requestedFactsProgram(input: RequestedFacts):GraphProgram<RequestedFactsResult> {
    const before = (yield* graphRevision(this.owner));
    const facts = (yield* readRequestedFactsProgram(input, (function* (this: PlanningSessionState, query: ObjectQuery){ return (yield* this.queryDataProgram(query)); }).bind(this), (function* (this: PlanningSessionState, object: ObjectView){
      if (!this.graph.model.implements(object.ref.type, 'ObservedFact')) return undefined;
      const result = (yield* graphEvaluate(this.owner, { function: 'businessFactStatus', object: object.ref }));
      for (const ref of [object.ref, ...result.evidenceRefs]) (yield* this.rememberProgram(ref));
      return result;
    }).bind(this)));
    if ((yield* graphRevision(this.owner)) !== before) throw new DomainError('CONFLICT', 'Facts changed during the context read; retry against the current versions');
    return facts;
  }
*callProgram(tool: string, input: unknown, options?: { origin: 'worker_context'; maxOutputBytes: number }):GraphProgram<unknown> {
    this.active();

    if (this.reads.length >= MAX_PLANNING_READS) throw new DomainError('CONFLICT', 'Planner tool-call limit reached');
    const before = new Map(this.seen), knownBefore = new Map(this.knownRefs), proposalCount = this.proposals.length, receiptId = randomUUID();
    const bytesBefore = this.bytes, instructionBytesBefore = this.instructionBytes, exhaustedBefore = this.contextBudgetExhausted;
    this.callObjects = new Map(); this.callDelivered = new Map();
    const datasetRevision = (yield* graphRevision(this.owner));
    let output: unknown, status: PlanningReadReceipt['status'] = 'ok';
    let contextRead: TaskContextRead | undefined;
    let actionDiscovery: ActionDiscoveryPage | undefined;
    let instructionRefs: ObjectRef[] = [], instructionPage = false;
    try {
      const read = function* (this: PlanningSessionState): GraphProgram<void> {
      if (this.contextBudgetExhausted) throw new ContextReadBudgetExceeded();
      if (tool === 'read_task_context') {
        if (!this.options.taskContext) throw new DomainError('FORBIDDEN', 'This session has no task-context binding');
        const args = taskContextSchema.parse(input);
        contextRead = (yield* readTaskContextProgram(this.graph, this.owner, this.request.id, this.request.revision, this.options.taskContext, receiptId, [...(this.options.priorReads ?? []), ...this.reads], args, this.graph.security ? authority(this.graph).definitions() : undefined));
        for (const ref of contextRead.deliveredRefs) (yield* this.rememberProgram(ref, undefined, true));
        for (const ref of contextRead.data.graph.unreadRefs) this.knownRefs.set(key(ref), ref);
        instructionRefs = contextRead.instructionRefs;
        if (args.facts) contextRead.data.requestedFacts = (yield* this.requestedFactsProgram(args.facts));
        output = contextRead.data;
      } else if (tool === 'read_task_instructions') {
        if (!this.options.taskContext || !this.reads.some(receipt => receipt.tool === 'read_task_context' && receipt.status === 'ok')) throw new DomainError('FORBIDDEN', 'Read the current task context before its original instruction pages');
        const result = (yield* readTaskInstructionsProgram(this.graph, this.owner, this.request.id, this.request.revision, taskInstructionsSchema.parse(input)));
        for (const object of result.items) (yield* this.rememberProgram(object.ref, object.revision, true));
        instructionRefs = result.items.map(object => object.ref); instructionPage = true; output = result;
      } else if (tool === 'discover_actions') {
        if (!this.options.actionCatalog) throw new DomainError('FORBIDDEN', 'This planning session has no action catalog binding');
        if (this.usesTaskContext() && !this.reads.some(read => read.tool === 'read_task_context' && read.status === 'ok')) throw new DomainError('FORBIDDEN', 'Read the current task context before discovering action bindings');
        actionDiscovery = (yield* graphDiscoverActions(this.owner, this.request, actionDiscoverySchema.parse(input)));
        output = actionDiscovery;
      } else if (tool === 'describe_ontology') {
        const { includeSchemas = false, includeLinks = true, includeConditionSchema = false, actions, functions, ...args } = describeSchema.parse(input), result = this.graph.model.describe(args);
        if (this.graph.security) {
          const visible=authority(this.graph).describe({...args, actions, functions});
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
        const parsed = planningQuerySchema.parse(input);
        if ('facts' in parsed) output = (yield* this.requestedFactsProgram(parsed.facts));
        else {
          const result = (yield* this.queryDataProgram(parsed));
          for (const object of result.items) if (object.ref.type === 'RequestInstruction' && typeof object.properties.text === 'string') instructionRefs.push(object.ref);
          instructionPage = !!result.items.length && result.items.every(object => object.ref.type === 'RequestInstruction');
          output = this.graph.security ? { items: result.items.map(({ref, revision, properties, derived}) => ({ref, revision, properties, ...(derived ? {derived} : {})})), page: {limit: result.page.limit, hasMore: result.page.hasMore, cursor: result.page.cursor} } : result;
        }
      } else if (tool === 'evaluate_ontology') {
        if (this.graph.security) { const candidate = secureFunctionCallSchema.parse(input); authority(this.graph).requireResource('function', candidate.function); }
        const args = functionCallSchema.parse(input);
        for (const value of Object.values(args)) { const ref = objectRefSchema.safeParse(value); if (ref.success) this.retrieved(ref.data); }
        const result = (yield* graphEvaluate(this.owner, args));
        for (const ref of [args.object, ...result.evidenceRefs]) (yield* this.rememberProgram(ref));
        output = result;
      } else if (tool === 'assess_conditions') {
        const args = assessmentSchema.parse(input), candidate = this.candidates.find(c => c.id === args.candidateId);
        if (args.candidateId && !candidate) throw new DomainError('FORBIDDEN', 'Unknown candidate');
        if (args.subject) this.retrieved(args.subject);
        if (args.subject && candidate?.ontologySubject && key(args.subject) !== key(candidate.ontologySubject)) throw new DomainError('CONFLICT', 'Candidate and selected condition subject differ');
        const checks = (yield* assessConditionsProgram(this.graph, this.owner, this.request, args.subject ?? candidate?.ontologySubject, args.phase));
        for (const check of checks) for (const ref of [...(check.subject ? [check.subject] : []), ...check.evidenceRefs]) (yield* this.rememberProgram(ref));
        output = { checks, grantsAuthority: false };
      } else if (tool === 'propose_action') {
        const args = actionSchema.parse(input), definition = this.graph.model.action(args.action);
        if (this.graph.security) authority(this.graph).requireResource('actionType', args.action);
        if (definition.read || definition.operation || this.graph.model.actionImplementation(definition.id)?.kind === 'declarative') throw new DomainError('INVALID_INPUT', 'Source reads, managed writes and sandbox operations are selected in an agent execute decision with their registered input and authorization checks; this tool only describes business decision proposals');
        if (args.inputs.length !== Object.keys(definition.inputs).length || new Set(args.inputs.map(i => i.name)).size !== args.inputs.length) throw new DomainError('INVALID_INPUT', 'Action inputs must match the registered definition');
        const inputs: DecisionActionProposal['inputs'] = {};
        for (const item of args.inputs) {
          this.retrieved(item.object);
          if (!definition.inputs[item.name] || !this.graph.model.implements(item.object.type, definition.inputs[item.name]!)) throw new DomainError('INVALID_INPUT', 'Action input type mismatch');
          const actual = (yield* graphRead(this.owner, item.object));
          if (actual.revision !== item.revision) throw new DomainError('CONFLICT', 'Action proposal references a stale object revision');
          (yield* this.rememberProgram(item.object)); inputs[item.name] = { object: item.object, revision: item.revision };
        }
        if (inputs.request?.object.id !== this.request.id) throw new DomainError('FORBIDDEN', 'Action belongs to another request');
        if ((yield* graphRead(this.owner, inputs.request.object)).properties.revision !== this.request.revision) throw new DomainError('CONFLICT', 'Action request revision changed');
        const checks: DecisionActionProposal['checks'] = definition.submissionCriteria.map(criterion => ({ criterion, result: ['same_owner', 'current_request_revision'].includes(criterion) ? 'pass' : 'unknown' }));
        const domain = serviceDomains.find(d => d.action === args.action);
        if (domain) {
          const option = inputs.option!.object, requirements = inputs.requirements!.object;
          const related = (yield* graphRelated(this.owner, option, 'requirements', { remaining: 1000 }));
          const requestLinks = (yield* graphMap([option, requirements], (function* (this: PlanningSessionState, ref: ObjectRef){ return (yield* graphRelated(this.owner, ref, 'request', { remaining: 1000 })); }).bind(this)));
          checks.find(c => c.criterion === 'same_request')!.result = requestLinks.every(rows => rows?.length === 1 && rows[0]!.ref.id === this.request.id) ? 'pass' : 'fail';
          checks.find(c => c.criterion === 'current_requirements')!.result = related?.length === 1 && key(related[0]!.ref) === key(requirements) && related[0]!.properties.requestRevision === this.request.revision ? 'pass' : 'fail';
          const eligibility = (yield* graphEvaluate(this.owner, { function: domain.eligibleFunction, object: option }));
          for (const ref of eligibility.evidenceRefs) (yield* this.rememberProgram(ref));
          const status = (eligibility.value as DomainAssessment | undefined)?.status;
          checks.find(c => c.criterion === 'eligible_option')!.result = eligibility.status === 'unknown' || status === 'unknown' ? 'unknown' : status === 'satisfied' ? 'pass' : 'fail';
          // Proposal tools cannot manufacture a dispatch permit, even for a local itinerary.
        }
        if (['PrepareCheckout', 'CompleteCheckout'].includes(args.action)) {
          const requirements = (yield* graphRead(this.owner, inputs.requirements!.object)), root = (yield* graphRelated(this.owner, requirements.ref, 'request', { remaining: 1000 }));
          checks.find(c => c.criterion === 'current_requirements')!.result = requirements.properties.requestRevision === this.request.revision && root?.length === 1 && root[0]!.ref.id === this.request.id ? 'pass' : 'fail';
          if (args.action === 'CompleteCheckout') {
            const session = (yield* graphRelated(this.owner, requirements.ref, 'session', { remaining: 1000 }));
            if (session?.length !== 1 || key(session[0]!.ref) !== key(inputs.checkout!.object)) checks.find(c => c.criterion === 'current_requirements')!.result = 'fail';
            const ready = (yield* graphEvaluate(this.owner, { function: 'checkoutReadiness', object: inputs.checkout!.object }));
            for (const ref of ready.evidenceRefs) (yield* this.rememberProgram(ref));
            const status = (ready.value as { status?: string } | undefined)?.status;
            checks.find(c => c.criterion === 'checkout_ready')!.result = ready.status === 'unknown' || status === 'unknown' ? 'unknown' : status === 'satisfied' ? 'pass' : 'fail';
          }
        }
        if (inputs.offer) {
          const requests = (yield* graphRelated(this.owner, inputs.offer.object, 'request', { remaining: 1000 }));
          const sameRequest = checks.find(c => c.criterion === 'same_request'); if (sameRequest) sameRequest.result = requests?.length === 1 && requests[0]!.ref.id === this.request.id ? 'pass' : 'fail';
          const fresh = (yield* graphEvaluate(this.owner, { function: 'offerFreshness', object: inputs.offer.object }));
          const freshness = checks.find(c => c.criterion === 'fresh_offer'); if (freshness) freshness.result = fresh.status === 'known' ? fresh.value ? 'pass' : 'fail' : 'unknown';
          const preconditions = checks.find(c => c.criterion === 'hard_preconditions_pass');
          if (preconditions) { const assessment = (yield* assessConditionsProgram(this.graph, this.owner, this.request, inputs.offer.object, 'precondition')); preconditions.result = assessment.some(c => c.strength === 'hard' && c.result === 'fail') ? 'fail' : hardConditionsPass(assessment, 'precondition') ? 'pass' : 'unknown'; }
        }
        const proposal: DecisionActionProposal = { action: args.action, definitionDigest: digest(definition), inputs, changes: definition.changes, checks, execution: 'proposal_only', executionAllowed: false };
        this.proposals.push(proposal); output = proposal;
      } else throw new DomainError('INVALID_INPUT', 'Unregistered planning tool');
      };
      const program = read.call(this);
      if (this.graph.runReadWindow && ['read_task_context', 'read_task_instructions', 'query_ontology', 'evaluate_ontology', 'assess_conditions'].includes(tool))
        this.graph.runReadWindow(this.owner, program);
      else yield* program;
      if (tool !== 'describe_ontology' && (yield* graphRevision(this.owner)) !== datasetRevision) throw new DomainError('CONFLICT', 'Objects changed during the planning read');
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
    const receipt: PlanningReadReceipt = { id: receiptId, at: new Date().toISOString(), tool, inputDigest: digest(input), outputDigest: digest(output), datasetRevision: (yield* graphRevision(this.owner)), status, origin: options?.origin ?? 'model', ...(this.graph.security ? authority(this.graph).receipt() : {}), outputBytes: Buffer.byteLength(JSON.stringify(output)),
      objects: [...this.callObjects.values()], deliveredObjects: [...this.callDelivered.values()], instructionRefs, ...(contextRead ? { context: contextRead.context, definitions: contextRead.definitions } : {}),
      ...(actionDiscovery ? { actionBindings: { snapshotDigest: actionDiscovery.snapshotDigest, pins: actionDiscovery.items.flatMap(item => item.bindings.map(binding => binding.pin)) } } : {}) };
    try { (yield* graphRecordPlanningRead(receipt)); }
    catch (error) {
      // An uncommitted receipt cannot authorize a later decision or consume a
      // model's delivered context. Preserve the original error for diagnosis.
      this.seen = before; this.knownRefs = knownBefore; this.proposals.length = proposalCount;
      this.callObjects.clear(); this.callDelivered.clear();
      this.bytes = bytesBefore; this.instructionBytes = instructionBytesBefore; this.contextBudgetExhausted = exhaustedBefore;
      throw error;
    }
    this.reads.push(receipt);
    return contextRead ? { data: output, receipt: { id: receipt.id, tool: receipt.tool, status: receipt.status, outputDigest: receipt.outputDigest } } : output;
  }
*finishProgram(candidate?: ResolvedCandidate):GraphProgram<PlanningSnapshot> {
    this.active();
    if (this.usesTaskContext() && (!this.acceptedIds || this.acceptedReadCount !== this.reads.length)) throw new DomainError('CONFLICT', 'The model must acknowledge the actual task-context and read receipts after its last read');
    const reads = this.usesTaskContext() ? this.receipts().filter(receipt => this.acceptedIds!.has(receipt.id)) : this.receipts();
    const contextReceipt = this.usesTaskContext() ? reads.findLast(receipt => receipt.tool === 'read_task_context' && receipt.status === 'ok') : undefined;
    if (this.usesTaskContext()) {
      if (!contextReceipt?.context) throw new DomainError('CONFLICT', 'The model skipped the required task-context read');
      (yield* assertTaskContextCurrentProgram(this.graph, this.owner, contextReceipt.context));
    }
    const conditionChecks = (yield* assessConditionsProgram(this.graph, this.owner, this.request, candidate?.ontologySubject));
    this.callObjects = new Map(); this.callDelivered = new Map();
    for (const check of conditionChecks) for (const ref of [...(check.subject ? [check.subject] : []), ...check.evidenceRefs]) (yield* this.rememberProgram(ref));
    const dependencies = this.usesTaskContext() ? new Map([...reads.flatMap(receipt => receipt.objects), ...this.callObjects.values()].map(object => [key(object.ref), object])) : this.seen;
    const deliveredObjects = [...new Map(reads.flatMap(receipt => receipt.deliveredObjects ?? []).map(object => [key(object.ref), object])).values()];
    const result = planningSnapshot({ mode: reads.some(read => read.origin === 'worker_context') ? reads.every(read => read.origin === 'worker_context') ? 'worker_context' : 'worker_context_with_queries' : 'model_queries', model: this.graph.model.ref, requestRevision: this.request.revision, conditionsDigest: digest(this.request.conditions ?? []), ...(this.graph.security ? {accessDigest: authority(this.graph).accessDigest()} : {}),
      reads, objects: [...dependencies.values()].filter(object => !this.usesTaskContext() || !isExecutionBookkeepingType(object.ref.type)), ...(this.usesTaskContext() ? { deliveredObjects, context: { ...contextReceipt!.context!, receiptId: contextReceipt!.id } } : {}),
      conditionChecks, actionProposals: structuredClone(this.proposals) });
    (yield* validatePlanningSnapshotProgram(this.graph, this.owner, this.request, result, true));
    return result;
  }
}
