import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import type { Ref, ServiceRequest } from '../ontology/execution.js';
import type { ActionDefinition, ObjectRef } from '../ontology/model.js';
import type { LinkWrite, ObjectView, OntologyObjectStore } from '../ontology/object-store.js';
import { readCapabilityCatalog, readPreparedCapability, readPreparedResolution, type PreparedCapability, type PreparedResolution } from '../ontology/capability-catalog.js';
import { actionProperties, readExecutionContext, readOntologyRequest, type ExecutionContextView } from '../ontology/execution-projection.js';
import { isExecutionBookkeepingType } from '../ontology/execution-model.js';
import type { PlanningContextReceipt, PlanningDefinitionReceipt, PlanningReadReceipt } from '../ontology/planning-contract.js';

export const taskContextSchema = z.strictObject({
  definitionReceiptId: z.string().min(1).max(200).optional().describe('Reuse a previously returned definition bundle only when its current model and binding still match'),
});
export const taskInstructionsSchema = z.strictObject({
  cursor: z.string().min(1).max(4000).optional(),
  limit: z.number().int().min(1).max(20).optional(),
  messageIds: z.array(z.string().min(1).max(200)).min(1).max(8).optional().describe('Read exact source messages from the current specification; cannot be combined with a cursor'),
});
const instructionCursorSchema = z.strictObject({ owner: z.string(), requestId: z.string(), requestRevision: z.number().int().positive(), requestDigest: z.string(), modelDigest: z.string(), after: z.number().int().min(-1) });
export const MAX_INSTRUCTION_READ_BYTES = 600000;
const INSTRUCTION_PAGE_BYTES = 60000;
export type TaskRequestView = ServiceRequest & { messageView: 'complete' | 'partial' };
export interface TaskContextBinding {
  purpose: 'grounding' | 'planning' | 'agent';
  /** An authority boundary to verify against the graph, never an injected business state. */
  program?: { ref: Ref; configurationDigest: string; actionIds: readonly string[] };
  refs?: readonly ObjectRef[];
}
export interface TaskContextPayload {
  version: '1';
  requestRef: ObjectRef;
  request: TaskRequestView;
  instructions: { total: number; complete: boolean; included: { ref: ObjectRef; messageId: string; sequence: number }[]; nextCursor?: string; originalGoalSource?: { ref: ObjectRef; messageId: string; content: 'request.originalGoal' } };
  execution?: Omit<ExecutionContextView, 'objects' | 'links'>;
  capabilities: ReturnType<typeof readCapabilityCatalog>;
  resolution?: PreparedResolution;
  capability?: PreparedCapability;
  graph: { objects: ObjectView[]; links: LinkWrite[]; unreadRefs: ObjectRef[]; pendingRelationships: { from: ObjectRef; link: string; cursor?: string }[] };
  definitions: { digest: string; originalReceiptId: string; reused: boolean; bundle: Record<string, unknown> };
}
export interface TaskContextRead {
  data: TaskContextPayload;
  context: PlanningContextReceipt;
  definitions: PlanningDefinitionReceipt;
  deliveredRefs: ObjectRef[];
  instructionRefs: ObjectRef[];
}

const refKey = (ref: ObjectRef) => JSON.stringify([ref.type, ref.id]);
const same = (a: unknown, b: unknown) => a === undefined || b === undefined ? a === b : digest(a) === digest(b);
const conflict = (message: string): never => { throw new DomainError('CONFLICT', message); };
const requestLinks = ['specifications', 'capabilities', 'currentResolution'] as const;
export const instructionCoverageDigest = (refs: ObjectRef[]) => digest([...new Set(refs.map(refKey))].sort());

function instructionRows(graph: OntologyObjectStore, owner: string, request: ServiceRequest): { specification: ObjectView; rows: ObjectView[] } {
  const specifications = graph.query(owner, { from: { type: 'ServiceRequest', id: request.id }, link: 'specifications', where: [{ property: 'requestRevision', op: 'eq', value: request.revision }], limit: 2 });
  if (specifications.items.length !== 1 || specifications.page.hasMore) return conflict('Current request specification is missing or ambiguous');
  const specification = specifications.items[0]!, rows: ObjectView[] = []; let cursor: string | undefined;
  do {
    const page = graph.query(owner, { from: specification.ref, link: 'instructions', limit: 50, ...(cursor ? { cursor } : {}) });
    rows.push(...page.items); cursor = page.page.cursor;
    if (rows.length > 2000) return conflict('Instruction index exceeds the supported task bound');
  } while (cursor);
  rows.sort((a, b) => Number(a.properties.sequence) - Number(b.properties.sequence));
  if (rows.length !== request.messages.length || rows.some((row, index) => row.properties.sequence !== index || row.properties.messageId !== request.messages[index]!.id || row.properties.text !== request.messages[index]!.text)) return conflict('Current instruction graph differs from its authenticated request');
  return { specification, rows };
}
function instructionCursor(graph: OntologyObjectStore, owner: string, request: ServiceRequest, after: number): string {
  return Buffer.from(JSON.stringify({ owner: digest(owner), requestId: request.id, requestRevision: request.revision, requestDigest: digest(request), modelDigest: graph.model.ref.digest, after })).toString('base64url');
}
function initialInstructions(request: ServiceRequest, rows: ObjectView[]) {
  const selected = new Set<number>(), first = request.messages[0];
  let bytes = 0;
  // The original goal already carries the initial instruction verbatim. Keep
  // small requests backward-compatible without copying a large goal twice.
  if (first && Buffer.byteLength(first.text) <= 12000) { selected.add(0); bytes += Buffer.byteLength(JSON.stringify(first)); }
  for (let i = request.messages.length - 1; i >= 0 && selected.size < 24; i--) {
    if (selected.has(i)) continue;
    const size = Buffer.byteLength(JSON.stringify(request.messages[i]));
    if (bytes + size > 24000 && selected.size) continue;
    selected.add(i); bytes += size;
  }
  const goalSource = first?.text === request.originalGoal ? rows[0] : undefined;
  const delivered = new Set([...selected, ...(goalSource ? [0] : [])]);
  return { selected, delivered, goalSource, missing: rows.findIndex((_row, index) => !delivered.has(index)) };
}
export function readTaskInstructions(graph: OntologyObjectStore, owner: string, requestId: string, requestRevision: number, input: z.infer<typeof taskInstructionsSchema>) {
  if (input.cursor && input.messageIds) throw new DomainError('INVALID_INPUT', 'Choose an instruction page or exact message IDs');
  const request = readOntologyRequest(graph, owner, requestId);
  if (request.revision !== requestRevision) return conflict('Instruction request revision changed');
  const { rows } = instructionRows(graph, owner, request);
  let after = -1;
  if (input.cursor) {
    let cursor: z.infer<typeof instructionCursorSchema>;
    try { cursor = instructionCursorSchema.parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString())); }
    catch { throw new DomainError('INVALID_INPUT', 'Invalid instruction cursor'); }
    if (cursor.owner !== digest(owner) || cursor.requestId !== requestId || cursor.requestRevision !== requestRevision || cursor.requestDigest !== digest(request) || cursor.modelDigest !== graph.model.ref.digest) throw new DomainError('FORBIDDEN', 'Instruction cursor belongs to another task or revision');
    after = cursor.after;
  }
  const candidates = input.messageIds ? rows.filter(row => input.messageIds!.includes(String(row.properties.messageId))) : rows.filter(row => Number(row.properties.sequence) > after);
  if (input.messageIds && candidates.length !== new Set(input.messageIds).size) throw new DomainError('FORBIDDEN', 'Instruction is not a member of the current request specification');
  const items: ObjectView[] = []; let bytes = 0;
  for (const row of candidates) {
    const size = Buffer.byteLength(JSON.stringify(row));
    if (items.length >= (input.limit ?? 12) || bytes + size > INSTRUCTION_PAGE_BYTES) break;
    items.push(row); bytes += size;
  }
  if (!items.length && candidates.length) return conflict('Instruction exceeds its registered message size bound');
  const hasMore = items.length < candidates.length;
  return { requestRef: { type: 'ServiceRequest', id: requestId }, requestRevision, items,
    page: { total: rows.length, returned: items.length, hasMore, ...(hasMore && !input.messageIds ? { nextCursor: instructionCursor(graph, owner, request, Number(items.at(-1)!.properties.sequence)) } : {}),
      ...(hasMore && input.messageIds ? { remainingMessageIds: candidates.slice(items.length).map(row => String(row.properties.messageId)) } : {}) } };
}

/** Task membership is distinct from owner visibility. Shared provider, channel,
 * address and action metadata can be read exactly, but cannot be used as a
 * reverse-navigation bridge into another task. */
export function taskObjectMembership(graph: OntologyObjectStore, owner: string, request: Pick<ServiceRequest, 'id' | 'revision'>, ref: ObjectRef): 'current' | 'foreign' | 'shared' {
  if (ref.type === 'ServiceRequest') return ref.id === request.id ? 'current' : 'foreign';
  const virtual = graph.virtualMembership(owner, request, ref);
  if (virtual) return virtual;
  const object = graph.read(owner, ref);
  // Attempt.requestRevision is the durable Job/claim fence. A technical resume
  // can advance it without changing the business request. Membership follows
  // the sealed step and plan instead of conflating those two revision domains.
  const executionParent: Record<string, string> = { ExecutionStep: 'plan', ExecutionInput: 'step', ExecutionAttempt: 'step', ExecutionResult: 'step' };
  const parentName = executionParent[ref.type];
  if (parentName) {
    const parents = graph.related(owner, ref, parentName, { remaining: 1000 });
    return parents?.length === 1 ? taskObjectMembership(graph, owner, request, parents[0]!.ref) : 'foreign';
  }
  if (typeof object.properties.requestRevision === 'number' && object.properties.requestRevision !== request.revision) return 'foreign';
  if (typeof object.properties.requestId === 'string' && object.properties.requestId !== request.id) return 'foreign';
  const navigation = graph.model.sides(ref.type).find(side => side.side.name === 'request' && side.other.type === 'ServiceRequest');
  if (navigation) {
    const roots = graph.related(owner, ref, 'request', { remaining: 1000 });
    return roots?.length === 1 && roots[0]!.ref.id === request.id ? 'current' : 'foreign';
  }
  return 'shared';
}

function safeDefinition(type: object, relevantTypes: Set<string>): object {
  const value = type as { properties: Record<string, Record<string, unknown>>; links?: { target: string }[] };
  return { ...value, ...(value.links ? { links: value.links.filter(link => relevantTypes.has(link.target)) } : {}), properties: Object.fromEntries(Object.entries(value.properties).map(([name, property]) => {
    const { schema: _schema, ...metadata } = property;
    return [name, metadata];
  })) };
}

/** Return a compact, exact subset of the registered model. Action input schemas
 * remain complete; unrelated action definitions are not repeatedly transported. */
function definitionBundle(graph: OntologyObjectStore, objects: ObjectView[], actions: ActionDefinition[]): Record<string, unknown> {
  const names = new Set(objects.map(object => object.ref.type));
  names.add('ServiceRequest'); names.add('SourceReceipt');
  for (const action of actions) {
    Object.values(action.inputs).forEach(type => names.add(type));
    if (action.read) names.add(action.read.resultType);
    if (action.operation) names.add(action.operation.resultType);
    for (const type of action.resultTypes ?? []) names.add(type);
  }
  for (const type of [...names].filter(name => !isExecutionBookkeepingType(name) && name !== 'ServiceRequest')) {
    if (graph.model.isInterface(type)) continue;
    for (const side of graph.model.sides(type).filter(side => side.direction === 'forward')) names.add(side.other.type);
  }
  const allFunctions = graph.model.functionDefinitions();
  const functions = allFunctions.filter(fn => [...names].some(type => fn.inputTypes.some(input => graph.model.implements(type, input))));
  const types = [...names].sort().map(type => safeDefinition(graph.model.describeType(type), names));
  return { model: graph.model.ref, types, actions: actions.map(action => {
    const { implementation, ...contract } = action;
    return { ...contract, execution: 'definition_only', ...(implementation ? { implementationSummary: implementation.kind === 'declarative'
      ? { kind: implementation.kind, version: implementation.version, mutations: implementation.mutations.length, conditions: implementation.conditions.length }
      : { kind: implementation.kind, handlerRef: implementation.handlerRef } } : {}) };
  }), functions };
}

function priorDefinition(receipts: readonly PlanningReadReceipt[], requested: string | undefined, context: PlanningContextReceipt, modelDigest: string, payload: Record<string, unknown>): PlanningDefinitionReceipt | undefined {
  const valid = (receipt: PlanningReadReceipt): boolean => {
    const definition = receipt.definitions;
    if (receipt.status !== 'ok' || receipt.tool !== 'read_task_context' || receipt.context?.ownerDigest !== context.ownerDigest || receipt.context.requestId !== context.requestId || !definition) return false;
    if (definition.modelDigest !== modelDigest || definition.bindingDigest !== context.bindingDigest || definition.payloadDigest !== digest(payload) || digest(definition.payload) !== definition.payloadDigest) return false;
    const original = receipts.find(item => item.id === definition.originalReceiptId);
    return !!original && original.status === 'ok' && original.context?.ownerDigest === context.ownerDigest && original.context.requestId === context.requestId && original.definitions?.originalReceiptId === original.id && original.definitions.payloadDigest === definition.payloadDigest && digest(original.definitions.payload) === definition.payloadDigest;
  };
  if (requested) {
    const found = receipts.find(receipt => receipt.id === requested);
    if (!found || !valid(found)) return conflict('The definition receipt does not belong to this task and current model binding');
    return structuredClone(found.definitions!);
  }
  const found = [...receipts].reverse().find(valid);
  return found ? structuredClone(found.definitions!) : undefined;
}

/** Read only persisted, public Ontology projections. The caller supplies an
 * authority boundary, never the request, execution state or source response. */
export function readTaskContext(graph: OntologyObjectStore, owner: string, requestId: string, requestRevision: number, binding: TaskContextBinding,
  receiptId: string, previousReads: readonly PlanningReadReceipt[] = [], input: z.infer<typeof taskContextSchema> = {}): TaskContextRead {
  const request = readOntologyRequest(graph, owner, requestId);
  if (request.revision !== requestRevision) return conflict('The current Ontology request revision changed');
  const instructionProjection = instructionRows(graph, owner, request), initial = initialInstructions(request, instructionProjection.rows);
  const executionView = readExecutionContext(graph, owner, requestId, requestRevision);
  let actions: ActionDefinition[] = [];
  if (binding.program) {
    if (!executionView || !same(executionView.programRef, binding.program.ref) || executionView.programDigest !== binding.program.configurationDigest || !same([...executionView.actionIds].sort(), [...binding.program.actionIds].sort())) return conflict('Ontology execution binding differs from the active program');
    actions = executionView.actionIds.map(id => graph.model.action(id));
    const registered = executionView.objects.filter(object => object.ref.type === 'RegisteredActionType');
    for (const action of actions) if (!registered.some(object => {
      const p = object.properties;
      return Object.entries(actionProperties(action)).every(([name, value]) => same(p[name], value));
    })) return conflict('The active action definition is missing or changed in its Ontology binding');
  }
  const capabilities = readCapabilityCatalog(graph, owner, requestId);
  const resolution = readPreparedResolution(graph, owner, requestId);
  const capability = readPreparedCapability(graph, owner, requestId);
  if (!binding.program && capability) {
    const registered = capability.actions.flatMap(operation => {
      const definition = graph.model.actionForOperation(operation.ref.id);
      return definition ? [definition] : [];
    });
    actions = [...new Map(registered.map(action => [action.id, action])).values()];
  }
  const requestRef = { type: 'ServiceRequest', id: requestId };
  const objects = new Map<string, ObjectView>(), links = new Map<string, LinkWrite>();
  const unread = new Map((executionView?.unreadRefs ?? []).map(ref => [refKey(ref), ref]));
  const pendingRelationships: TaskContextPayload['graph']['pendingRelationships'] = [];
  const internalType = (type: string) => isExecutionBookkeepingType(type) || type === 'RegisteredCapability';
  // Leave room for the Agent's focused source queries and gate evaluations.
  // Omitted objects remain navigable references, never delivered evidence.
  let objectBytes = 0;
  const addObject = (object: ObjectView, required = true): boolean => {
    if (taskObjectMembership(graph, owner, request, object.ref) === 'foreign') throw new DomainError('FORBIDDEN', 'Task context cannot include another request or revision');
    if (object.ref.type === 'RequestInstruction') {
      const sequence = Number(object.properties.sequence);
      if (!initial.delivered.has(sequence) || instructionProjection.rows[sequence]?.ref.id !== object.ref.id) {
        if ([...unread.values()].filter(ref => ref.type === 'RequestInstruction').length < 32) unread.set(refKey(object.ref), object.ref);
        return false;
      }
      // Exact text is delivered once in request.messages or originalGoal. This
      // node supplies identity, ordering and source relationships without a duplicate.
      const { text: _text, ...metadata } = object.properties;
      object = { ...object, properties: metadata };
    } else if (object.ref.type === 'ServiceRequest') {
      const { originalGoal: _goal, confirmedInputs: _inputs, conditions: _conditions, ...metadata } = object.properties;
      object = { ...object, properties: metadata };
    }
    if (internalType(object.ref.type)) { unread.set(refKey(object.ref), object.ref); return false; }
    const bytes = Buffer.byteLength(JSON.stringify(object));
    if (!objects.has(refKey(object.ref)) && objectBytes + bytes > 30000 && object.ref.type !== 'ServiceRequest' && !same(object.ref, executionView?.scope)) {
      unread.set(refKey(object.ref), object.ref); return false;
    }
    if (!objects.has(refKey(object.ref)) && objects.size >= 100) {
      if (required) return conflict('Task context object bound exceeded; narrow the active business context');
      unread.set(refKey(object.ref), object.ref); return false;
    }
    if (!objects.has(refKey(object.ref))) objectBytes += bytes;
    objects.set(refKey(object.ref), object);
    unread.delete(refKey(object.ref)); return true;
  };
  const addLink = (edge: LinkWrite) => { links.set(JSON.stringify(edge), edge); };
  addObject(graph.read(owner, requestRef));
  if (executionView?.scope) addObject(graph.read(owner, executionView.scope));
  for (const object of executionView?.objects ?? []) addObject(object);
  for (const edge of executionView?.links ?? []) addLink(edge);
  for (const link of requestLinks) {
    if (!graph.model.sides('ServiceRequest').some(side => side.side.name === link)) continue;
    let cursor: string | undefined;
    do {
      const page = graph.query(owner, { from: requestRef, link, limit: 50, ...(cursor ? { cursor } : {}) });
      const navigation = graph.model.navigation('ServiceRequest', link);
      for (const object of page.items) {
        if (object.properties.requestRevision !== undefined && object.properties.requestRevision !== requestRevision) continue;
        addObject(object);
        addLink(navigation.direction === 'forward' ? { type: navigation.link.id, from: requestRef, to: object.ref } : { type: navigation.link.id, from: object.ref, to: requestRef });
      }
      cursor = page.page.cursor;
    } while (cursor);
  }
  for (const ref of binding.refs ?? []) if (!unread.has(refKey(ref))) addObject(graph.read(owner, ref));
  for (const specification of [...objects.values()].filter(object => object.ref.type === 'RequestSpecification')) {
    const instructionNavigation = graph.model.navigation(specification.ref.type, 'instructions');
    for (const instruction of instructionProjection.rows) {
      if (addObject(instruction, false)) addLink({ type: instructionNavigation.link.id, from: specification.ref, to: instruction.ref });
    }
    for (const link of ['constraints']) {
      const navigation = graph.model.navigation(specification.ref.type, link);
      let cursor: string | undefined;
      do {
        const page = graph.query(owner, { from: specification.ref, link, limit: 50, ...(cursor ? { cursor } : {}) });
        for (const object of page.items) {
          addObject(object); addLink({ type: navigation.link.id, from: specification.ref, to: object.ref });
        }
        cursor = page.page.cursor;
      } while (cursor);
    }
  }
  for (const context of [...objects.values()].filter(object => object.ref.type === 'ResolutionContext')) {
    const candidates = graph.related(owner, context.ref, 'candidates', { remaining: 1000 });
    if (!candidates) return conflict('Prepared candidate context exceeds its bound');
    for (const candidate of candidates) {
      addObject(candidate); addLink({ type: 'CandidateResolution', from: candidate.ref, to: context.ref });
    }
  }
  // Business objects may expose their own outgoing typed evidence and input
  // links. Shared nodes are terminal and never expanded in the reverse direction.
  const expanded = new Set<string>();
  for (const object of objects.values()) {
    if (expanded.has(refKey(object.ref)) || isExecutionBookkeepingType(object.ref.type) || object.ref.type === 'ServiceRequest') continue;
    expanded.add(refKey(object.ref));
    if (taskObjectMembership(graph, owner, request, object.ref) !== 'current') continue;
    for (const navigation of graph.model.sides(object.ref.type).filter(side => side.direction === 'forward' && side.side.name !== 'supersedes' && !(object.ref.type === 'RequestSpecification' && side.side.name === 'instructions'))) {
      const page = graph.query(owner, { from: object.ref, link: navigation.side.name, limit: 12 }, { remaining: 1000 });
      if (page.page.hasMore) pendingRelationships.push({ from: object.ref, link: navigation.side.name, ...(page.page.cursor ? { cursor: page.page.cursor } : {}) });
      for (const target of page.items) {
        if (taskObjectMembership(graph, owner, request, target.ref) === 'foreign') continue;
        addObject(target, false); addLink({ type: navigation.link.id, from: object.ref, to: target.ref });
      }
    }
  }
  const execution = executionView ? (({ objects: _objects, links: _links, ...view }) => view)(executionView) : undefined;
  const bindingDigest = digest({ purpose: binding.purpose, program: binding.program ? { ref: binding.program.ref, configurationDigest: binding.program.configurationDigest, actionIds: [...binding.program.actionIds].sort() } : undefined });
  const context: PlanningContextReceipt = { version: '1', ownerDigest: digest(owner), requestId, requestRevision, bindingDigest, requestDigest: digest(request), executionDigest: digest(execution ?? null),
    instructionCount: instructionProjection.rows.length, instructionRefsDigest: instructionCoverageDigest(instructionProjection.rows.map(row => row.ref)), requireCompleteInstructions: binding.purpose === 'grounding' };
  const bundle = definitionBundle(graph, [...objects.values()], actions);
  const reused = priorDefinition(previousReads, input.definitionReceiptId, context, graph.model.ref.digest, bundle);
  const definitions: PlanningDefinitionReceipt = reused ?? { modelDigest: graph.model.ref.digest, bindingDigest, payloadDigest: digest(bundle), originalReceiptId: receiptId, payload: bundle };
  const modelRequest: TaskRequestView = { ...request, messages: [...initial.selected].sort((a, b) => a - b).map(index => request.messages[index]!), messageView: initial.selected.size === request.messages.length ? 'complete' : 'partial' };
  const data: TaskContextPayload = { version: '1', requestRef, request: modelRequest,
    instructions: { total: instructionProjection.rows.length, complete: initial.delivered.size === instructionProjection.rows.length,
      included: [...initial.delivered].sort((a, b) => a - b).map(sequence => ({ ref: instructionProjection.rows[sequence]!.ref, messageId: request.messages[sequence]!.id, sequence })),
      ...(initial.missing >= 0 ? { nextCursor: instructionCursor(graph, owner, request, initial.missing - 1) } : {}),
      ...(initial.goalSource ? { originalGoalSource: { ref: initial.goalSource.ref, messageId: String(initial.goalSource.properties.messageId), content: 'request.originalGoal' as const } } : {}) },
    ...(execution ? { execution } : {}), capabilities, ...(resolution ? { resolution } : {}), ...(capability ? { capability } : {}),
    graph: { objects: [...objects.values()], links: [...links.values()].filter(edge => objects.has(refKey(edge.from)) && objects.has(refKey(edge.to))), unreadRefs: [...unread.values()], pendingRelationships },
    definitions: { digest: definitions.payloadDigest, originalReceiptId: definitions.originalReceiptId, reused: !!reused, bundle: structuredClone(definitions.payload) } };
  if (Buffer.byteLength(JSON.stringify(data)) > 180000) return conflict('Task context byte bound exceeded; narrow the active execution context');
  // The execution overview delivers current context and step properties without
  // exposing the underlying attempt, result, argument or registry rows.
  const deliveredRefs = [...objects.values()].map(object => object.ref);
  if (execution) deliveredRefs.push(execution.ref, ...execution.plans.flatMap(plan => [plan.ref, ...plan.steps.map(step => step.ref)]));
  return { data, context, definitions, deliveredRefs, instructionRefs: [...initial.delivered].map(sequence => instructionProjection.rows[sequence]!.ref) };
}

export function assertTaskContextCurrent(graph: OntologyObjectStore, owner: string, context: PlanningContextReceipt): void {
  if (context.ownerDigest !== digest(owner)) return conflict('Task context belongs to another owner');
  const request = readOntologyRequest(graph, owner, context.requestId);
  if (request.revision !== context.requestRevision || digest(request) !== context.requestDigest) return conflict('Task business context changed after its read');
  const view = readExecutionContext(graph, owner, context.requestId, context.requestRevision);
  const execution = view ? (({ objects: _objects, links: _links, ...value }) => value)(view) : undefined;
  if (digest(execution ?? null) !== context.executionDigest) return conflict('Task execution context changed before the decision was accepted');
}
