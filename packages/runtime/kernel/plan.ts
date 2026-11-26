import { z } from 'zod';
import { Conflict, InvalidInput, NotFound, PermissionDenied } from '../../core/identity.js';
import type { Ontology } from '../../ontology/model.js';
import { processLogTarget } from '../../ontology/process-definition.js';
import { valueKinds } from '../../ontology/property-path.js';
import type { ObjectRef } from '../../ontology/schema.js';
import type { Access } from '../access.js';
import type { aggregateSetSchema, setExpressionSchema } from '../object-sets.js';
import type { Objects } from '../objects.js';
import { queryFields, querySchema } from '../objects.js';
import type { Predicate } from '../query-filter.js';
import { scenarioMetadataType } from '../scenario-metadata.js';

/**
 * Semantic planning for the Ontology query kernel (route C, prototype C1).
 *
 * The planner compiles an Object Set expression into a kernel plan only when every part has a proven equivalent:
 * concrete object types whose referenced fields are stored scalars without derived values, property security,
 * classification labels or object policies, and predicates whose two-valued semantics the kernel reproduces. Any
 * other expression compiles to `undefined`, and the caller uses the reference implementation. Access checks that the
 * reference would make are made here first; a check that would fail also yields `undefined`, so the reference reports
 * its own error.
 */

export type KernelKind = 'string' | 'integer' | 'number' | 'boolean';
type Scalar = string | number | boolean | null;
export type KernelPredicate =
  | { op: 'all' | 'any'; predicates: KernelPredicate[] }
  | { op: 'not'; predicate: KernelPredicate }
  | { op: 'const'; value: boolean }
  | { op: 'eq' | 'ne'; column: string; value: Scalar }
  | { op: 'gt' | 'gte' | 'lt' | 'lte'; column: string; value: number }
  | { op: 'in'; column: string; values: Scalar[] }
  | { op: 'contains'; column: string; value: string };
export type KernelMove = { source: string; link: string; forward: boolean; target: string; filter?: KernelPredicate };
export type KernelSet =
  | { op: 'empty' }
  | { op: 'scan'; type: string; filter?: KernelPredicate }
  | { op: 'refs'; refs: ObjectRef[] }
  | { op: 'union' | 'intersect'; sets: KernelSet[] }
  | { op: 'except'; left: KernelSet; right: KernelSet }
  | { op: 'traverse'; set: KernelSet; steps: KernelMove[][] };
export type KernelPlan = { set: KernelSet; types: Set<string> };

type SetExpression = z.output<typeof setExpressionSchema>;
type AggregateInput = z.output<typeof aggregateSetSchema>;

/** The kernel column kind of a stored property, or undefined when its values are not one scalar kind. */
export function columnKind(model: Ontology, type: string, property: string): KernelKind | undefined {
  const definition = model.object(type).properties[property];
  if (!definition || definition.derived) return undefined;
  const kinds = new Set(valueKinds(definition.schema).filter(kind => kind !== 'null'));
  if (!kinds.size) return undefined;
  if ([...kinds].every(kind => kind === 'string')) return 'string';
  if ([...kinds].every(kind => kind === 'boolean')) return 'boolean';
  if ([...kinds].every(kind => kind === 'integer')) return 'integer';
  if ([...kinds].every(kind => kind === 'integer' || kind === 'number')) return 'number';
  return undefined;
}

/** The scalar columns the kernel loads for a type. */
export function loadedColumns(model: Ontology, type: string) {
  return Object.keys(model.object(type).properties).flatMap(name => {
    const kind = columnKind(model, type, name);
    return kind ? [{ name, kind }] : [];
  });
}

/**
 * Types whose rows this principal sees without a row filter, so the kernel's rows are the reference's rows. Row
 * classifications without a model clearance do not filter rows; the kernel reports them for egress observation.
 */
function eligibleType(model: Ontology, access: Access, type: string) {
  if (!model.objects.has(type) || type === scenarioMetadataType || processLogTarget(model, type)) return false;
  return !access.rowFiltered(model, type);
}

function eligibleField(model: Ontology, access: Access, type: string, field: string) {
  if (field.includes('.')) return false;
  const definition = model.object(type).properties[field];
  return Boolean(definition && columnKind(model, type, field) && !(definition as { classification?: unknown }).classification
    && !access.hasPropertySecurity(model, type, field));
}

/** Whether a literal can equal a stored value of the kind; null matches a missing or null value of any kind. */
const matchesKind = (kind: KernelKind, value: Scalar) => value === null || (kind === 'string' ? typeof value === 'string'
  : kind === 'boolean' ? typeof value === 'boolean' : typeof value === 'number' && Number.isFinite(value));

/** Two-valued translation of an Ontology predicate over one concrete type, or undefined when it has no equivalent. */
function compilePredicate(model: Ontology, access: Access, type: string, predicate: Predicate): KernelPredicate | undefined {
  const all = (items: Predicate[]) => {
    const compiled = items.map(item => compilePredicate(model, access, type, item));
    return compiled.every(Boolean) ? compiled as KernelPredicate[] : undefined;
  };
  switch (predicate.op) {
    case 'all': case 'any': { const predicates = all(predicate.predicates); return predicates && { op: predicate.op, predicates }; }
    case 'not': { const inner = compilePredicate(model, access, type, predicate.predicate); return inner && { op: 'not', predicate: inner }; }
    case 'text': case 'regex': return undefined;
    default: break;
  }
  if (!eligibleField(model, access, type, predicate.property)) return undefined;
  const kind = columnKind(model, type, predicate.property)!;
  const column = predicate.property;
  switch (predicate.op) {
    case 'eq': case 'ne':
      // A value of another kind never equals a stored value: eq is false and ne true on every row, nulls included.
      if (!matchesKind(kind, predicate.value)) return { op: 'const', value: predicate.op === 'ne' };
      return { op: predicate.op, column, value: predicate.value };
    case 'gt': case 'gte': case 'lt': case 'lte':
      // Ordering compares numbers only; a string bound compares strings by UTF-16 code units, which stays in the reference.
      if (typeof predicate.value !== 'number') return undefined;
      if (kind !== 'integer' && kind !== 'number') return { op: 'const', value: false };
      return { op: predicate.op, column, value: predicate.value };
    case 'in': {
      const values = predicate.values.filter(value => matchesKind(kind, value));
      return { op: 'in', column, values };
    }
    case 'contains':
      if (kind !== 'string' || typeof predicate.value !== 'string') return undefined;
      return { op: 'contains', column, value: predicate.value };
  }
}

function compileQuery(model: Ontology, access: Access, input: Extract<SetExpression, { op: 'query' }>['query']) {
  // The reference parses the set's query the same way before it evaluates it.
  const q = querySchema.parse({ ...input, limit: 100, cursor: undefined });
  if (model.interfaces.has(q.type) || !model.objects.has(q.type) || q.intervalOverlap) return undefined;
  access.definition(model, 'object', q.type);
  if (!eligibleType(model, access, q.type)) return undefined;
  for (const field of queryFields(q)) {
    model.propertyPath(q.type, field);
    if (!eligibleField(model, access, q.type, field)) return undefined;
  }
  const parts: KernelPredicate[] = [];
  for (const [field, value] of Object.entries(q.where ?? {})) {
    const kind = columnKind(model, q.type, field)!;
    parts.push(matchesKind(kind, value) ? { op: 'eq', column: field, value } : { op: 'const', value: false });
  }
  if (q.filter) {
    const compiled = compilePredicate(model, access, q.type, q.filter as Predicate);
    if (!compiled) return undefined;
    parts.push(compiled);
  }
  const filter: KernelPredicate | undefined = parts.length === 0 ? undefined : parts.length === 1 ? parts[0] : { op: 'all', predicates: parts };
  return { type: q.type, filter, from: q.from };
}

/**
 * Compiles an Object Set expression for the kernel. `graph` reads the source object of a relationship query, as the
 * reference does before it reads the relationship.
 */
export async function compileSet(model: Ontology, access: Access, graph: Objects, expression: SetExpression): Promise<KernelPlan | undefined> {
  try {
    return await compile(model, access, graph, expression, 0);
  } catch (error) {
    // The reference path reports its own permission, existence and definition errors.
    if (error instanceof PermissionDenied || error instanceof NotFound || error instanceof InvalidInput || error instanceof Conflict) return undefined;
    throw error;
  }
}

async function compile(model: Ontology, access: Access, graph: Objects, node: SetExpression, depth: number): Promise<KernelPlan | undefined> {
  if (depth > 16) return undefined;
  switch (node.op) {
    case 'query': {
      const query = compileQuery(model, access, node.query);
      if (!query) return undefined;
      if (!access.canRead(model, query.type)) return { set: { op: 'empty' }, types: new Set() };
      if (!query.from) return { set: { op: 'scan', type: query.type, filter: query.filter }, types: new Set([query.type]) };
      if (query.from.as) return undefined;
      const navigation = model.navigation(query.from.object.type, query.from.link);
      if (navigation.target !== query.type) return { set: { op: 'empty' }, types: new Set() };
      if (!eligibleType(model, access, query.from.object.type)) return undefined;
      await graph.read(query.from.object);
      access.read(model, navigation.target);
      access.definition(model, 'link', navigation.link);
      if (!access.canSeeModelData(model.links.get(navigation.link)?.classification)) return { set: { op: 'empty' }, types: new Set() };
      return {
        set: { op: 'traverse', set: { op: 'refs', refs: [query.from.object] },
          steps: [[{ source: query.from.object.type, link: navigation.link, forward: navigation.forward, target: query.type, filter: query.filter }]] },
        types: new Set([query.type]),
      };
    }
    case 'refs': {
      const refs = node.objects.filter(ref => model.objects.has(ref.type));
      if (refs.some(ref => !eligibleType(model, access, ref.type))) return undefined;
      // An unreadable type is skipped, as the reference skips each reference it may not read.
      const visible = refs.filter(ref => access.canRead(model, ref.type));
      return { set: { op: 'refs', refs: visible }, types: new Set(visible.map(ref => ref.type)) };
    }
    case 'union': case 'intersection': {
      const children: KernelPlan[] = [];
      for (const child of node.sets) {
        const compiled = await compile(model, access, graph, child, depth + 1);
        if (!compiled) return undefined;
        children.push(compiled);
      }
      const types = node.op === 'union' ? new Set(children.flatMap(child => [...child.types]))
        : new Set([...children[0]!.types].filter(type => children.every(child => child.types.has(type))));
      return { set: { op: node.op === 'union' ? 'union' : 'intersect', sets: children.map(child => child.set) }, types };
    }
    case 'difference': {
      const left = await compile(model, access, graph, node.left, depth + 1), right = await compile(model, access, graph, node.right, depth + 1);
      if (!left || !right) return undefined;
      return { set: { op: 'except', left: left.set, right: right.set }, types: left.types };
    }
    case 'traverse': {
      const start = await compile(model, access, graph, node.set, depth + 1);
      if (!start) return undefined;
      let types = start.types;
      const steps: KernelMove[][] = [];
      for (const step of node.path) {
        if (step.as) return undefined;
        const moves: KernelMove[] = [], next = new Set<string>();
        for (const source of types) {
          const navigation = model.navigation(source, step.link);
          if (!eligibleType(model, access, navigation.target)) return undefined;
          access.read(model, source);
          access.read(model, navigation.target);
          access.definition(model, 'link', navigation.link);
          if (!access.canSeeModelData(model.links.get(navigation.link)?.classification)) continue;
          moves.push({ source, link: navigation.link, forward: navigation.forward, target: navigation.target });
          next.add(navigation.target);
        }
        steps.push(moves);
        types = next;
      }
      return { set: { op: 'traverse', set: start.set, steps }, types };
    }
    case 'saved':
      return undefined;
  }
}

/** Aggregation over one concrete type's stored scalar fields, or undefined. */
export function compileAggregate(model: Ontology, access: Access, plan: KernelPlan, input: Pick<AggregateInput, 'view' | 'groupBy' | 'metrics'>) {
  if (input.view || plan.types.size !== 1) return undefined;
  const type = [...plan.types][0]!;
  for (const field of [...input.groupBy, ...Object.values(input.metrics).flatMap(metric => metric.property ? [metric.property] : [])])
    if (!eligibleField(model, access, type, field)) return undefined;
  for (const metric of Object.values(input.metrics)) {
    if (metric.op === 'count') continue;
    const kind = columnKind(model, type, metric.property!);
    if (kind !== 'integer' && kind !== 'number') return undefined;
  }
  return {
    kind: 'aggregate' as const, type, groupBy: input.groupBy,
    metrics: Object.entries(input.metrics).map(([name, metric]) => ({ name, op: metric.op, column: metric.property })),
  };
}
