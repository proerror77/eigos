import { z } from 'zod';
import { Conflict, InvalidInput, NotFound, PermissionDenied } from '../../core/identity.js';
import type { Ontology } from '../../ontology/model.js';
import { processLogTarget } from '../../ontology/process-definition.js';
import { valueKinds } from '../../ontology/property-path.js';
import type { ObjectRef } from '../../ontology/schema.js';
import type { Access, RowRule } from '../access.js';
import type { aggregateSetSchema, setExpressionSchema } from '../object-sets.js';
import type { Objects } from '../objects.js';
import { queryFields, querySchema } from '../objects.js';
import type { Predicate } from '../query-filter.js';
import { scenarioMetadataType } from '../scenario-metadata.js';
import type { ObjectPolicy } from '../security.js';

/**
 * Semantic planning for the Ontology query kernel (route C).
 *
 * The planner compiles an Object Set expression into a kernel plan only when every part has a proven equivalent, and
 * otherwise returns `undefined` so the caller uses the reference implementation. Row security comes from the reference
 * rules themselves (`Access.rowRule`, `Access.cellRule`): object policies, markings and a model clearance become row
 * predicates on every table the plan reads, and property security masks the cells predicates and aggregations see.
 * Access checks the reference would make are made here first; a check that would fail also yields `undefined`, so the
 * reference reports its own error.
 */

export type KernelKind = 'string' | 'integer' | 'number' | 'boolean' | 'strings';
type Scalar = string | number | boolean | null;
export type KernelPredicate =
  | { op: 'all' | 'any'; predicates: KernelPredicate[] }
  | { op: 'not'; predicate: KernelPredicate }
  | { op: 'const'; value: boolean }
  | { op: 'eq' | 'ne'; column: string; value: Scalar }
  | { op: 'gt' | 'gte' | 'lt' | 'lte'; column: string; value: number }
  | { op: 'in'; column: string; values: Scalar[] }
  | { op: 'contains'; column: string; value: string }
  /** Every element of a string list is one of `values`; a missing list is empty. */
  | { op: 'subset'; column: string; values: string[] }
  /** A string list holds at least one of `values`. */
  | { op: 'hasAny'; column: string; values: string[] };
export type KernelMove = { source: string; link: string; forward: boolean; target: string; filter?: KernelPredicate };
export type KernelSet =
  | { op: 'empty' }
  | { op: 'scan'; type: string; filter?: KernelPredicate }
  | { op: 'refs'; refs: ObjectRef[] }
  | { op: 'union' | 'intersect'; sets: KernelSet[] }
  | { op: 'except'; left: KernelSet; right: KernelSet }
  | { op: 'traverse'; set: KernelSet; steps: KernelMove[][] };
/** What the kernel reports about each member type: the rows to record for policy-bound types, and markings read. */
export type KernelMember = { type: string; track: boolean; markings?: string };
export type KernelPlan = {
  set: KernelSet; types: Set<string>;
  /** The row predicate the kernel applies to every read of each type. */
  rows: Record<string, KernelPredicate>;
  members: Map<string, KernelMember>;
};

type SetExpression = z.output<typeof setExpressionSchema>;
type AggregateInput = z.output<typeof aggregateSetSchema>;
type Expression = NonNullable<ObjectPolicy['read']>;

/** The kernel column kind of a stored property, or undefined when its values are not one kernel kind. */
export function columnKind(model: Ontology, type: string, property: string): KernelKind | undefined {
  const definition = model.object(type).properties[property];
  if (!definition || definition.derived) return undefined;
  const kinds = new Set(valueKinds(definition.schema).filter(kind => kind !== 'null'));
  if (!kinds.size) return undefined;
  if ([...kinds].every(kind => kind === 'string')) return 'string';
  if ([...kinds].every(kind => kind === 'boolean')) return 'boolean';
  if ([...kinds].every(kind => kind === 'integer')) return 'integer';
  if ([...kinds].every(kind => kind === 'integer' || kind === 'number')) return 'number';
  const items = (definition.schema as { items?: Record<string, unknown> }).items;
  if ([...kinds].every(kind => kind === 'array') && items && valueKinds(items).filter(kind => kind !== 'null').every(kind => kind === 'string'))
    return 'strings';
  return undefined;
}

/** The columns the kernel loads for a type. */
export function loadedColumns(model: Ontology, type: string) {
  return Object.keys(model.object(type).properties).flatMap(name => {
    const kind = columnKind(model, type, name);
    return kind ? [{ name, kind }] : [];
  });
}

/** Whether a literal can equal a stored value of the kind; null matches a missing or null value of any kind. */
const matchesKind = (kind: KernelKind, value: Scalar) => value === null || (kind === 'string' ? typeof value === 'string'
  : kind === 'boolean' ? typeof value === 'boolean' : kind === 'strings' ? false : typeof value === 'number' && Number.isFinite(value));
const constant = (value: boolean): KernelPredicate => ({ op: 'const', value });
const conjunction = (parts: KernelPredicate[]): KernelPredicate | undefined =>
  parts.length === 0 ? undefined : parts.length === 1 ? parts[0] : { op: 'all', predicates: parts };

/** The compiled access of each type the plan reads, made once per type in the planner's order of reads. */
class Scope {
  readonly rows: Record<string, KernelPredicate> = {};
  readonly members = new Map<string, KernelMember>();
  private readonly rules = new Map<string, RowRule>();
  constructor(readonly model: Ontology, readonly access: Access) {}
  /** The row rule of a type, or undefined when only the reference can evaluate it or it has no kernel equivalent. */
  rule(type: string): RowRule | undefined {
    const { model, access } = this;
    if (!model.objects.has(type) || type === scenarioMetadataType || processLogTarget(model, type)) return undefined;
    let rule = this.rules.get(type);
    if (!rule) {
      rule = access.rowRule(model, type);
      this.rules.set(type, rule);
      if (rule.kind === 'rows') {
        const predicate = this.rowPredicate(type, rule);
        if (predicate === undefined) return undefined;
        if (predicate) this.rows[type] = predicate;
      }
    }
    if (rule.kind === 'unsupported' || rule.kind === 'rows' && !this.compiled(type, rule)) return undefined;
    return rule;
  }
  private compiled(type: string, rule: Extract<RowRule, { kind: 'rows' }>) {
    return !(rule.markingsProperty && columnKind(this.model, type, rule.markingsProperty) !== 'strings')
      && !(rule.policy && this.expression(type, rule.policy, rule) === undefined);
  }
  /**
   * Whether the type's rows are readable at all; a denied type contributes no rows, as `FALSE` does in the reference.
   * Like the reference's selection, it requires `view_objects` on the type before applying the row rule.
   */
  readable(type: string) {
    const rule = this.rule(type);
    if (!rule) return undefined;
    this.access.read(this.model, type);
    if (rule.kind === 'deny') return false;
    if (!this.members.has(type)) this.members.set(type, { type, track: rule.kind === 'rows' && rule.tracked, markings: rule.kind === 'rows' ? rule.markingsProperty : undefined });
    return true;
  }
  /** `null` when every row is readable, a predicate when some are, undefined when there is no kernel equivalent. */
  private rowPredicate(type: string, rule: Extract<RowRule, { kind: 'rows' }>): KernelPredicate | null | undefined {
    const parts: KernelPredicate[] = [];
    if (rule.policy) {
      const policy = this.expression(type, rule.policy, rule);
      if (!policy) return undefined;
      parts.push(policy);
    }
    if (rule.markingsProperty) {
      if (columnKind(this.model, type, rule.markingsProperty) !== 'strings') return undefined;
      parts.push({ op: 'subset', column: rule.markingsProperty, values: rule.markings });
    }
    if (rule.clearance) {
      if (rule.clearance.classificationProperty)
        parts.push({ op: 'any', predicates: [{ op: 'eq', column: '$rank', value: null },
          { op: 'all', predicates: [{ op: 'lte', column: '$rank', value: rule.clearance.rank }, { op: 'subset', column: '$compartments', values: rule.clearance.compartments }] }] });
      if (rule.markingsProperty) parts.push({ op: 'subset', column: rule.markingsProperty, values: rule.clearance.availableMarks });
    }
    return conjunction(parts) ?? null;
  }
  /** An object policy expression (`all` conditions, then at least one `any` condition) as a predicate. */
  expression(type: string, expression: Expression, rule: Extract<RowRule, { kind: 'rows' }>): KernelPredicate | undefined {
    const condition = (item: Expression['all'][number]): KernelPredicate | undefined => {
      const kind = columnKind(this.model, type, item.property);
      if (!kind) return undefined;
      const column = item.property;
      if (item.op === 'equals') return matchesKind(kind, item.value) ? { op: 'eq', column, value: item.value } : constant(false);
      if (item.op === 'subject') return kind === 'string' ? { op: 'eq', column, value: rule.subject } : constant(false);
      if (kind === 'string') return rule.groups.length ? { op: 'in', column, values: rule.groups } : constant(false);
      if (kind === 'strings') return { op: 'hasAny', column, values: rule.groups };
      return constant(false);
    };
    const all = expression.all.map(condition), any = expression.any.map(condition);
    if (![...all, ...any].every(Boolean)) return undefined;
    const parts = all as KernelPredicate[];
    if (any.length) parts.push({ op: 'any', predicates: any as KernelPredicate[] });
    return conjunction(parts) ?? constant(true);
  }
  /**
   * A field as predicates and aggregations see it: hidden fields read as null for every row, and a cell policy shows the
   * value only on rows it permits. Undefined when the field has no kernel column.
   */
  cell(type: string, field: string): { hidden: true } | { hidden: false; policy?: KernelPredicate } | undefined {
    if (field.includes('.') || !columnKind(this.model, type, field) || columnKind(this.model, type, field) === 'strings') return undefined;
    const cell = this.access.cellRule(this.model, type, field);
    if (!cell.visible) return { hidden: true };
    if (!cell.policy) return { hidden: false };
    const rule = this.rules.get(type);
    if (!rule || rule.kind !== 'rows') return undefined;
    const policy = this.expression(type, cell.policy, rule);
    return policy && { hidden: false, policy };
  }
}

/** An atom's value on a row where its field is null. */
function onNull(atom: KernelPredicate): boolean {
  switch (atom.op) {
    case 'eq': return atom.value === null;
    case 'ne': return atom.value !== null;
    case 'in': return atom.values.includes(null);
    default: return false;
  }
}

/** Two-valued translation of an Ontology predicate over one concrete type, or undefined when it has no equivalent. */
function compilePredicate(scope: Scope, type: string, predicate: Predicate): KernelPredicate | undefined {
  const all = (items: Predicate[]) => {
    const compiled = items.map(item => compilePredicate(scope, type, item));
    return compiled.every(Boolean) ? compiled as KernelPredicate[] : undefined;
  };
  switch (predicate.op) {
    case 'all': case 'any': { const predicates = all(predicate.predicates); return predicates && { op: predicate.op, predicates }; }
    case 'not': { const inner = compilePredicate(scope, type, predicate.predicate); return inner && { op: 'not', predicate: inner }; }
    case 'text': case 'regex': return undefined;
    default: break;
  }
  const cell = scope.cell(type, predicate.property);
  if (!cell) return undefined;
  const kind = columnKind(scope.model, type, predicate.property)!;
  const column = predicate.property;
  let atom: KernelPredicate;
  switch (predicate.op) {
    case 'eq': case 'ne':
      // A value of another kind never equals a stored value: eq is false and ne true on every row, nulls included.
      atom = matchesKind(kind, predicate.value) ? { op: predicate.op, column, value: predicate.value } : constant(predicate.op === 'ne');
      break;
    case 'gt': case 'gte': case 'lt': case 'lte':
      // Ordering compares numbers only; a string bound compares strings by UTF-16 code units, which stays in the reference.
      if (typeof predicate.value !== 'number') return undefined;
      atom = kind === 'integer' || kind === 'number' ? { op: predicate.op, column, value: predicate.value } : constant(false);
      break;
    case 'in':
      atom = { op: 'in', column, values: predicate.values.filter(value => matchesKind(kind, value)) };
      break;
    case 'contains':
      if (kind !== 'string' || typeof predicate.value !== 'string') return undefined;
      atom = { op: 'contains', column, value: predicate.value };
      break;
  }
  if (atom.op === 'const') return atom;
  if (cell.hidden) return constant(onNull(atom));
  if (!cell.policy) return atom;
  return { op: 'any', predicates: [{ op: 'all', predicates: [cell.policy, atom] },
    { op: 'all', predicates: [{ op: 'not', predicate: cell.policy }, constant(onNull(atom))] }] };
}

function compileQuery(scope: Scope, input: Extract<SetExpression, { op: 'query' }>['query']) {
  const { model, access } = scope;
  // The reference parses the set's query the same way before it evaluates it.
  const q = querySchema.parse({ ...input, limit: 100, cursor: undefined });
  if (model.interfaces.has(q.type) || !model.objects.has(q.type) || q.intervalOverlap) return undefined;
  access.definition(model, 'object', q.type);
  const readable = access.canRead(model, q.type) ? scope.readable(q.type) : false;
  if (readable === undefined) return undefined;
  for (const field of queryFields(q)) model.propertyPath(q.type, field);
  if (!readable) return { type: q.type, empty: true as const, from: q.from };
  const parts: KernelPredicate[] = [];
  for (const [field, value] of Object.entries(q.where ?? {})) {
    const compiled = compilePredicate(scope, q.type, { op: 'eq', property: field, value });
    if (!compiled) return undefined;
    parts.push(compiled);
  }
  if (q.filter) {
    const compiled = compilePredicate(scope, q.type, q.filter as Predicate);
    if (!compiled) return undefined;
    parts.push(compiled);
  }
  return { type: q.type, empty: false as const, filter: conjunction(parts), from: q.from };
}

/**
 * Compiles an Object Set expression for the kernel. `graph` reads the source object of a relationship query, as the
 * reference does before it reads the relationship.
 */
export async function compileSet(model: Ontology, access: Access, graph: Objects, expression: SetExpression): Promise<KernelPlan | undefined> {
  const scope = new Scope(model, access);
  try {
    const compiled = await compile(scope, graph, expression, 0);
    return compiled && { ...compiled, rows: scope.rows, members: scope.members };
  } catch (error) {
    // The reference path reports its own permission, existence and definition errors.
    if (error instanceof PermissionDenied || error instanceof NotFound || error instanceof InvalidInput || error instanceof Conflict) return undefined;
    throw error;
  }
}

type Compiled = { set: KernelSet; types: Set<string> };
const empty = (): Compiled => ({ set: { op: 'empty' }, types: new Set() });

async function compile(scope: Scope, graph: Objects, node: SetExpression, depth: number): Promise<Compiled | undefined> {
  const { model, access } = scope;
  if (depth > 16) return undefined;
  switch (node.op) {
    case 'query': {
      const query = compileQuery(scope, node.query);
      if (!query) return undefined;
      if (query.empty) return empty();
      if (!query.from) return { set: { op: 'scan', type: query.type, filter: query.filter }, types: new Set([query.type]) };
      if (query.from.as) return undefined;
      const navigation = model.navigation(query.from.object.type, query.from.link);
      if (navigation.target !== query.type) return empty();
      const source = scope.readable(query.from.object.type);
      if (source === undefined) return undefined;
      await graph.read(query.from.object);
      access.read(model, navigation.target);
      access.definition(model, 'link', navigation.link);
      if (!access.canSeeModelData(model.links.get(navigation.link)?.classification)) return empty();
      return {
        set: { op: 'traverse', set: { op: 'refs', refs: [query.from.object] },
          steps: [[{ source: query.from.object.type, link: navigation.link, forward: navigation.forward, target: query.type, filter: query.filter }]] },
        types: new Set([query.type]),
      };
    }
    case 'refs': {
      const refs: ObjectRef[] = [];
      for (const ref of node.objects) {
        if (!model.objects.has(ref.type)) continue;
        // An unreadable type is skipped, as the reference skips each reference it may not read.
        if (!access.canRead(model, ref.type)) continue;
        const readable = scope.readable(ref.type);
        if (readable === undefined) return undefined;
        if (readable) refs.push(ref);
      }
      return { set: { op: 'refs', refs }, types: new Set(refs.map(ref => ref.type)) };
    }
    case 'union': case 'intersection': {
      const children: Compiled[] = [];
      for (const child of node.sets) {
        const compiled = await compile(scope, graph, child, depth + 1);
        if (!compiled) return undefined;
        children.push(compiled);
      }
      const types = node.op === 'union' ? new Set(children.flatMap(child => [...child.types]))
        : new Set([...children[0]!.types].filter(type => children.every(child => child.types.has(type))));
      return { set: { op: node.op === 'union' ? 'union' : 'intersect', sets: children.map(child => child.set) }, types };
    }
    case 'difference': {
      const left = await compile(scope, graph, node.left, depth + 1), right = await compile(scope, graph, node.right, depth + 1);
      if (!left || !right) return undefined;
      return { set: { op: 'except', left: left.set, right: right.set }, types: left.types };
    }
    case 'traverse': {
      const start = await compile(scope, graph, node.set, depth + 1);
      if (!start) return undefined;
      let types = start.types;
      const steps: KernelMove[][] = [];
      for (const step of node.path) {
        if (step.as) return undefined;
        const moves: KernelMove[] = [], next = new Set<string>();
        for (const source of types) {
          const navigation = model.navigation(source, step.link);
          access.read(model, source);
          access.read(model, navigation.target);
          access.definition(model, 'link', navigation.link);
          if (!access.canSeeModelData(model.links.get(navigation.link)?.classification)) continue;
          const readable = scope.readable(navigation.target);
          if (readable === undefined) return undefined;
          if (!readable) continue;
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

/** A field an aggregation reads, masked as predicates see it. */
export type KernelMask = { column: string; hidden: boolean; policy?: KernelPredicate };

/** Aggregation over one concrete type's stored scalar fields, or undefined. */
export function compileAggregate(model: Ontology, access: Access, plan: KernelPlan, input: Pick<AggregateInput, 'view' | 'groupBy' | 'metrics'>) {
  if (input.view || plan.types.size !== 1) return undefined;
  const type = [...plan.types][0]!;
  const scope = new Scope(model, access);
  if (!scope.readable(type)) return undefined;
  const masks: KernelMask[] = [];
  for (const field of new Set([...input.groupBy, ...Object.values(input.metrics).flatMap(metric => metric.property ? [metric.property] : [])])) {
    const cell = scope.cell(type, field);
    if (!cell) return undefined;
    if (cell.hidden || cell.policy) masks.push({ column: field, hidden: cell.hidden, policy: cell.hidden ? undefined : cell.policy });
  }
  for (const metric of Object.values(input.metrics)) {
    if (metric.op === 'count') continue;
    const kind = columnKind(model, type, metric.property!);
    if (kind !== 'integer' && kind !== 'number') return undefined;
  }
  return {
    kind: 'aggregate' as const, type, groupBy: input.groupBy, masks,
    metrics: Object.entries(input.metrics).map(([name, metric]) => ({ name, op: metric.op, column: metric.property })),
  };
}
