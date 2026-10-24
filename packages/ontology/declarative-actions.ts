import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import { compileJsonSchema } from './model-compiler.js';
import { objectRefSchema, type ObjectRef } from './model.js';
import type { ObjectWriteScope } from './actions.js';
import type { OntologyReleaseRef } from './definition-contracts.js';
import type { LinkWrite, ManagedObjectBatch, ObjectSource, OntologyObjectStore } from './object-store.js';
import { assertActionDataBounds, declarativeActionImplementationSchema, validateActionImplementation, type ActionObjectRef, type ActionValue } from './action-dsl.js';
import { readManagedResultFacts } from './managed-result-facts.js';
import type { CandidateFacts } from './execution.js';

function fail(message: string): never { throw new DomainError('CONFLICT', message); }
const equal = (a: unknown, b: unknown) => digest(a) === digest(b);
const key = (ref: ObjectRef) => JSON.stringify([ref.type, ref.id]);
const edgeKey = (link: LinkWrite) => JSON.stringify([link.type, key(link.from), key(link.to)]);
const previewSource: ObjectSource = { kind: 'user', id: 'declarative-preview', observedAt: '1970-01-01T00:00:00.000Z' };

export interface ManagedActionRead {
  ref: ObjectRef; revision: number; propertiesDigest: string; relationshipsDigest: string;
}
export interface ManagedObjectChange {
  operation: 'create' | 'update' | 'tombstone'; ref: ObjectRef; expectedRevision: number | null;
  fields: string[]; before?: Record<string, unknown>; after?: Record<string, unknown>;
}
export interface ManagedLinkChange { operation: 'add' | 'remove'; link: LinkWrite; existed: boolean }
export interface ManagedActionPreview {
  version: '1'; ontologyRelease: OntologyReleaseRef; modelDigest: string; actionId: string; actionDigest: string; inputDigest: string;
  reads: ManagedActionRead[]; objects: ManagedObjectChange[]; links: ManagedLinkChange[]; batch: ManagedObjectBatch;
  result?: ObjectRef; resultFacts?: CandidateFacts; digest: string; scope: ObjectWriteScope;
}

/** Resolve an interface capability using the actual owned concrete target. */
export function resolveManagedInterfaceAction(graph: OntologyObjectStore, owner: string, args: { object: ObjectRef; interfaceId: string; actionId: string; input: Record<string, unknown> }): { actionId: string; input: Record<string, unknown> } {
  const target = graph.read(owner, objectRefSchema.parse(args.object));
  const mapping = graph.model.resolveInterfaceAction(target.ref.type, args.interfaceId, args.actionId);
  const input: Record<string, unknown> = {};
  for (const [concrete, abstract] of Object.entries(mapping.inputMap)) {
    if (!Object.hasOwn(args.input, abstract)) fail('Interface invocation is missing a mapped argument');
    input[concrete] = structuredClone(args.input[abstract]);
  }
  // Ordinary scalar parameters retain their names; mapped object parameters never
  // accept a second, conflicting concrete-name value.
  for (const [name, value] of Object.entries(args.input)) {
    if (Object.values(mapping.inputMap).includes(name)) continue;
    if (Object.hasOwn(input, name)) fail('Interface invocation contains a conflicting concrete argument');
    input[name] = structuredClone(value);
  }
  const subjectArguments = Object.entries(mapping.action.inputs).filter(([, type]) => graph.model.implements(target.ref.type, type));
  if (!subjectArguments.some(([name]) => equal(input[name], target.ref))) fail('Interface action must bind the exact target object');
  return { actionId: mapping.action.id, input };
}

/** Pure, deterministic action preview. It validates the full tentative graph and rolls it back. */
export function previewDeclarativeAction(graph: OntologyObjectStore, owner: string, actionId: string, rawInput: Record<string, unknown>): ManagedActionPreview {
  if (!graph.releaseRef) fail('Dynamic actions require an exact ontology release');
  const action = graph.model.action(actionId), declared = graph.model.actionImplementation(actionId);
  if (declared?.kind !== 'declarative' || !action.inputSchema) throw new DomainError('FORBIDDEN', 'Action has no executable declarative binding');
  assertActionDataBounds(rawInput);
  validateActionImplementation(declared, graph.model, action);
  const implementation = declarativeActionImplementationSchema.parse(declared);
  const input = compileJsonSchema(action.inputSchema).parse(rawInput) as Record<string, unknown>;
  if (!equal(input, rawInput)) fail('Action inputs cannot be silently normalized');
  const reads = new Map<string, ManagedActionRead>();
  const read = (ref: ObjectRef) => {
    const object = graph.read(owner, ref);
    reads.set(key(ref), { ref: structuredClone(ref), revision: object.revision, propertiesDigest: digest(object.properties), relationshipsDigest: graph.relationshipDigest(owner, ref, { remaining: 500 }) });
    return object;
  };
  for (const [parameter, type] of Object.entries(action.inputs)) {
    const ref = objectRefSchema.parse(input[parameter]);
    if (!graph.model.implements(ref.type, type)) fail('Object input does not implement its declared type');
    read(ref);
  }
  const value = (expression: ActionValue): unknown => {
    if ('literal' in expression) return structuredClone(expression.literal);
    if ('parameter' in expression) {
      if (!Object.hasOwn(input, expression.parameter)) return undefined;
      let item: unknown = input[expression.parameter];
      for (const segment of expression.path ?? []) {
        if (!item || typeof item !== 'object' || !Object.hasOwn(item, segment) || ['constructor', 'prototype', '__proto__'].includes(segment)) return undefined;
        item = (item as Record<string, unknown>)[segment];
      }
      return item === undefined ? undefined : structuredClone(item);
    }
    const ref = reference(expression.object), property = graph.model.properties(ref.type)[expression.property];
    if (!property || property.restricted || property.derived) throw new DomainError('FORBIDDEN', 'Action cannot read a protected or derived property');
    return read(ref).properties[expression.property];
  };
  const reference = (expression: ActionObjectRef): ObjectRef => {
    if ('parameter' in expression) return objectRefSchema.parse(value({ parameter: expression.parameter }));
    const id = value(expression.id);
    return objectRefSchema.parse({ type: expression.type, id });
  };
  for (const condition of implementation.conditions) {
    const left = value(condition.left), right = condition.right ? value(condition.right) : undefined;
    let pass: boolean;
    if (condition.op === 'exists') pass = left !== undefined;
    else if (left === undefined || right === undefined) pass = false;
    else if (condition.op === 'eq' || condition.op === 'ne') pass = equal(left, right) === (condition.op === 'eq');
    else {
      if (typeof left !== 'number' || typeof right !== 'number' || !Number.isFinite(left) || !Number.isFinite(right)) fail('Ordered action comparisons require finite numeric operands');
      pass = condition.op === 'lt' ? left < right : condition.op === 'lte' ? left <= right : condition.op === 'gt' ? left > right : left >= right;
    }
    if (!pass) fail('Declarative action precondition failed');
  }
  const batch: ManagedObjectBatch = { objects: [], links: [], removeLinks: [], creates: [], tombstones: [] };
  const objects: ManagedObjectChange[] = [], links: ManagedLinkChange[] = [];
  const mutated = new Set<string>(), changedLinks = new Set<string>();
  const revision = (expression: ActionValue) => { const result = value(expression); if (!Number.isSafeInteger(result) || Number(result) <= 0) fail('Mutation requires an explicit positive expected revision'); return Number(result); };
  const properties = (expressions: Record<string, ActionValue>) => Object.fromEntries(Object.entries(expressions).map(([name, expression]) => {
    const item = value(expression); if (item === undefined) fail('A changed field cannot have an unknown value'); return [name, item];
  }));
  const target = (ref: ObjectRef) => {
    if (graph.model.objectWritePolicy(ref.type) !== 'managed') throw new DomainError('FORBIDDEN', 'Generic action target is source controlled');
    if (mutated.has(key(ref))) fail('One action cannot mutate an object more than once');
    mutated.add(key(ref));
  };
  for (const mutation of implementation.mutations) {
    if (mutation.op === 'create') {
      const ref = reference({ type: mutation.type, id: mutation.id }); target(ref);
      if (graph.managedObject(owner, ref) || graph.tombstone(owner, ref)) fail('Create requires an unused object identity');
      const after = properties(mutation.properties);
      batch.objects.push({ ref, properties: after }); batch.creates!.push(ref);
      objects.push({ operation: 'create', ref, expectedRevision: null, fields: Object.keys(after).sort(), after });
    } else if (mutation.op === 'update' || mutation.op === 'tombstone') {
      const ref = reference(mutation.object); target(ref);
      const before = read(ref), expectedRevision = revision(mutation.expectedRevision);
      if (before.revision !== expectedRevision) fail('Object revision changed before action preview');
      if (mutation.op === 'update') {
        const patch = properties(mutation.properties), after = { ...before.properties, ...patch };
        if (equal(before.properties, after)) fail('Update has no changed managed fields');
        batch.objects.push({ ref, properties: patch, expectedRevision });
        objects.push({ operation: 'update', ref, expectedRevision, fields: Object.keys(patch).sort(), before: before.properties, after });
      } else {
        batch.tombstones!.push({ ref, expectedRevision }); objects.push({ operation: 'tombstone', ref, expectedRevision, fields: [], before: before.properties });
      }
    } else {
      const link = { type: mutation.type, from: reference(mutation.from), to: reference(mutation.to) };
      if (changedLinks.has(edgeKey(link))) fail('One action cannot change a relationship more than once');
      changedLinks.add(edgeKey(link));
      for (const ref of [link.from, link.to]) if (!batch.creates!.some(created => key(created) === key(ref))) read(ref);
      const existed = graph.containsLinks(owner, [link]);
      if (mutation.op === 'add_link' && existed || mutation.op === 'remove_link' && !existed) fail('Requested relationship mutation has no change');
      (mutation.op === 'add_link' ? batch.links! : batch.removeLinks!).push(link);
      links.push({ operation: mutation.op === 'add_link' ? 'add' : 'remove', link, existed });
    }
  }
  const result = implementation.result ? reference(implementation.result) : objects.find(change => change.operation !== 'tombstone')?.ref;
  if (result) {
    if (batch.tombstones!.some(item => key(item.ref) === key(result))) fail('Action result cannot reference a tombstoned object');
    if (!batch.creates!.some(ref => key(ref) === key(result))) read(result);
  }
  graph.previewManaged(owner, batch, previewSource);
  const resultChange = result && objects.find(change => key(change.ref) === key(result) && change.operation !== 'tombstone');
  if (implementation.resultFacts && !resultChange?.after) fail('Result facts must bind an object changed by this action');
  const resultFacts = implementation.resultFacts ? readManagedResultFacts(resultChange!.after!, implementation.resultFacts) : undefined;
  const body = { version: '1' as const, ontologyRelease: structuredClone(graph.releaseRef!), modelDigest: graph.model.ref.digest, actionId, actionDigest: digest(action), inputDigest: digest(input), reads: [...reads.values()].sort((a, b) => key(a.ref).localeCompare(key(b.ref))), objects, links, batch, ...(result ? { result } : {}), ...(resultFacts ? { resultFacts } : {}) };
  const previewDigest = digest(body);
  const targets: ObjectWriteScope['targets'] = objects.map(change => ({ ref: change.ref, revision: change.expectedRevision, fields: change.fields, operation: change.operation }));
  for (const link of links) for (const ref of [link.link.from, link.link.to]) if (!targets.some(item => key(item.ref) === key(ref))) targets.push({ ref, revision: reads.get(key(ref))?.revision ?? null, fields: [], operation: 'link' });
  const scope: ObjectWriteScope = { ontologyRelease: body.ontologyRelease, actionId, actionDigest: body.actionDigest, inputDigest: body.inputDigest, previewDigest, targets: targets.sort((a, b) => key(a.ref).localeCompare(key(b.ref))), links: links.map(change => ({ type: change.link.type, from: change.link.from, to: change.link.to, operation: change.operation })) };
  return { ...body, digest: previewDigest, scope };
}

/** Authority is checked by the existing plan grant immediately before this transaction-bound apply. */
export function applyDeclarativeAction(graph: OntologyObjectStore, owner: string, actionId: string, input: Record<string, unknown>, preview: ManagedActionPreview, authority: ObjectWriteScope, source: ObjectSource): { result?: ObjectRef; previewDigest: string } {
  const current = previewDeclarativeAction(graph, owner, actionId, input);
  if (!equal(current, preview) || !equal(current.scope, authority)) throw new DomainError('FORBIDDEN', 'Managed action differs from its exact authorized preview');
  graph.applyManaged(owner, current.batch, source);
  return { ...(current.result ? { result: current.result } : {}), previewDigest: current.digest };
}
