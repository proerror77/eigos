import { z } from 'zod';
import { Conflict, InvalidInput, NotFound, PermissionDenied } from '../../core/identity.js';
import type { Ontology } from '../../ontology/model.js';
import { processLogTarget } from '../../ontology/process-definition.js';
import { valueKinds } from '../../ontology/property-path.js';
import type { DerivedExpression, ObjectRef } from '../../ontology/schema.js';
import type { Access, RowRule } from '../access.js';
import type { aggregateSetSchema, setExpressionSchema } from '../object-sets.js';
import type { Objects } from '../objects.js';
import { queryFields, querySchema } from '../objects.js';
import { predicateFields, type Predicate } from '../query-filter.js';
import { scenarioMetadataType } from '../scenario-metadata.js';
import type { ObjectPolicy } from '../security.js';
import { supportsStoredPredicate } from '../stored-query.js';

/**
 * Semantic planning for the Ontology query kernel (route C).
 *
 * The planner compiles an Object Set expression into a kernel plan only when every part has a proven equivalent, and
 * otherwise returns `undefined` so the caller uses the reference implementation. Row security comes from the reference
 * rules themselves (`Access.rowRule`, `Access.cellRule`): object policies, markings and a model clearance become row
 * predicates on every table the plan reads, and property security masks the cells predicates and aggregations see.
 * Access checks the reference would make are made here first; a check that would fail also yields `undefined`, so the
 * reference reports its own error.
 *
 * The kernel reports every row the reference reads, so the client records the same row classifications, markings and
 * row dependencies:
 * - the members of every node, and every readable row of a type whose filter reads derived values;
 * - each traversal step's targets;
 * - the objects the derived properties of those rows reach.
 * Type-level checks are made while planning, also for inputs that turn out to be empty, where the reference may skip
 * them; the kernel path then records at least what the reference records.
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
/** `candidates`: the filter reads derived values, so the reference reads every candidate before it filters. */
export type KernelMove = { source: string; link: string; forward: boolean; target: string; filter?: KernelPredicate; candidates?: true };
export type KernelSet =
  | { op: 'empty' }
  | { op: 'scan'; type: string; filter?: KernelPredicate; candidates?: true }
  /** `enrich: false` for the source of a relationship query, which the reference reads without derived values. */
  | { op: 'refs'; refs: ObjectRef[]; enrich?: false }
  | { op: 'union' | 'intersect'; sets: KernelSet[] }
  | { op: 'except'; left: KernelSet; right: KernelSet }
  | { op: 'traverse'; set: KernelSet; steps: KernelMove[][] };
/** One step of a derived relationship path; a link whose label the principal may not see reaches nothing. */
export type KernelStep = { link: string; forward: boolean; target: string; visible?: false };
/** A derived value as the kernel computes it; see `kernel/src/main.rs`. */
export type KernelDerived =
  | { op: 'literal'; value: number }
  | { op: 'field'; column: string; hidden?: boolean; policy?: KernelPredicate }
  | { op: 'derived'; column: string }
  | { op: 'arith'; kind: 'add' | 'subtract' | 'multiply' | 'divide'; left: KernelDerived; right: KernelDerived }
  | { op: 'linked'; steps: KernelStep[]; aggregate: string; value?: KernelDerived };
const bounds = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'] as const;
/** A derived column with the numeric bounds of its property schema, which the reference validates each value against. */
export type KernelDerivedSpec = { column: string; kind: Exclude<KernelKind, 'strings'>; expr: KernelDerived }
  & Partial<Record<typeof bounds[number], number>>;
/** How the kernel reports each type the plan reads: the rows to record for policy-bound types, and markings read. */
export type KernelMember = { type: string; track: boolean; markings?: string };
export type KernelPlan = {
  set: KernelSet; types: Set<string>;
  /** The row predicate the kernel applies to every read of each type. */
  rows: Record<string, KernelPredicate>;
  members: Map<string, KernelMember>;
  /** The derived columns each type's reads carry. */
  derived: Record<string, KernelDerivedSpec[]>;
  /**
   * The derived properties of each type whose rows the reference reads with their derived values. The reference checks
   * their visibility for each such row it reads, so the client records the checks where the kernel read such rows.
   */
  enriched: Map<string, string[]>;
};
/** The planning state of each plan, which an aggregation over the plan extends. */
const scopes = new WeakMap<KernelPlan, Scope>();

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

/**
 * The local field behind a view's field on a concrete type: the field itself on its own type, the property an Interface
 * maps it to, or undefined where the type does not map it, so the field reads as null.
 */
const localField = (model: Ontology, type: string, view: string, field: string) => view === type ? field : model.propertyName(type, view, field);
/** Whether the reference can show an object of `type` in `view`. */
export const showsType = (model: Ontology, view: string, type: string) => type === view || model.interfaces.has(view) && model.implements(type, view);
/** Errors the reference reports itself; the planner then leaves the set to it. */
const referenceError = (error: unknown) => error instanceof PermissionDenied || error instanceof NotFound || error instanceof InvalidInput || error instanceof Conflict;

/** The compiled access of each type the plan reads, made once per type in the planner's order of reads. */
class Scope {
  readonly rows: Record<string, KernelPredicate> = {};
  readonly members = new Map<string, KernelMember>();
  readonly derived: Record<string, KernelDerivedSpec[]> = {};
  private readonly compiling = new Set<string>();
  readonly enriched = new Map<string, string[]>();
  private readonly rules = new Map<string, RowRule>();
  constructor(readonly model: Ontology, readonly access: Access) {}
  /** The row rule of a type, or undefined when only the reference can evaluate it or it has no kernel equivalent. */
  rule(type: string): RowRule | undefined {
    const { model, access } = this;
    if (!model.objects.has(type) || type === scenarioMetadataType || processLogTarget(model, type)) return undefined;
    // The reference observes a property's own label on each row it reads that holds the property. The kernel does not
    // track which properties a row holds, so types with labelled properties stay on the reference path.
    if (Object.values(model.object(type).properties).some(property => property.classification)) return undefined;
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
    this.describe(type, rule);
    return rule.kind !== 'deny';
  }
  /** Tells the kernel how to report the rows it reads of a type; a type the principal may not read has none. */
  describe(type: string, rule?: RowRule) {
    // In a Scenario the reference records a row dependency for every row it reads, as it does for a policy-bound type.
    const scenario = Boolean((this.model as { scenario?: string }).scenario);
    if (!this.members.has(type)) this.members.set(type, { type, track: rule?.kind === 'rows' && rule.tracked || scenario && rule?.kind !== 'deny',
      markings: rule?.kind === 'rows' ? rule.markingsProperty : undefined });
  }
  /**
   * Registers every derived property of a type whose rows the reference reads with their derived values, or returns
   * false when one has no kernel equivalent. The reference evaluates a derived property only where it is visible, so
   * the kernel computes only plainly visible ones.
   */
  enrich(type: string): boolean {
    if (this.enriched.has(type)) return true;
    const names: string[] = [];
    this.enriched.set(type, names);
    for (const [name, property] of Object.entries(this.model.object(type).properties)) {
      if (!property.derived) continue;
      const cell = this.access.cellVisibility(this.model, type, name);
      if (!cell.visible || cell.policy || !this.derivedColumn(type, name)) return false;
      names.push(name);
    }
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
  /** A field's kernel kind: a stored column, or a derived column the planner can compute; undefined otherwise. */
  kind(type: string, field: string): KernelKind | undefined {
    if (field.includes('.')) return undefined;
    const definition = this.model.object(type).properties[field];
    if (!definition) return undefined;
    if (!definition.derived) return columnKind(this.model, type, field);
    return this.derivedColumn(type, field);
  }
  /**
   * Registers the derived column `field` of `type` and returns its kind. The reference validates each derived value
   * against the property schema, so a schema with constraints beyond its type, or an integer property whose expression
   * can produce a fraction, stays on the reference path.
   */
  private derivedColumn(type: string, field: string): KernelKind | undefined {
    const known = this.derived[type]?.find(spec => spec.column === field);
    if (known) return known.kind;
    const key = type + '.' + field;
    if (this.compiling.has(key)) return undefined;
    const definition = this.model.object(type).properties[field]!;
    const schema = definition.schema as Record<string, unknown>;
    if (Object.keys(schema).some(name => !['type', 'description', 'title', ...bounds].includes(name))) return undefined;
    const kinds = valueKinds(schema).filter(kind => kind !== 'null');
    const kind = kinds.length === 1 && ['string', 'integer', 'boolean'].includes(kinds[0]!) ? kinds[0] as 'string' | 'integer' | 'boolean'
      : kinds.every(kind => kind === 'integer' || kind === 'number') && kinds.length ? 'number' : undefined;
    if (!kind) return undefined;
    const limits = bounds.filter(name => schema[name] !== undefined);
    if (limits.length && (kind !== 'integer' && kind !== 'number' || limits.some(name => typeof schema[name] !== 'number' || !Number.isFinite(schema[name]))))
      return undefined;
    this.compiling.add(key);
    try {
      const expr = this.derivedExpression(type, definition.derived!);
      if (!expr || kind === 'integer' && !this.integral(type, expr)) return undefined;
      (this.derived[type] ??= []).push({ column: field, kind, expr, ...Object.fromEntries(limits.map(name => [name, schema[name]])) });
      return kind;
    } finally { this.compiling.delete(key); }
  }
  /** Whether a derived value is always an integer. */
  private integral(type: string, expr: KernelDerived): boolean {
    switch (expr.op) {
      case 'literal': return Number.isInteger(expr.value);
      case 'field': return expr.hidden || columnKind(this.model, type, expr.column) === 'integer';
      case 'derived': return this.derived[type]?.find(spec => spec.column === expr.column)?.kind === 'integer';
      case 'arith': return expr.kind !== 'divide' && this.integral(type, expr.left) && this.integral(type, expr.right);
      case 'linked': {
        if (expr.aggregate === 'count' || !expr.value) return true;
        if (expr.aggregate === 'avg') return false;
        return this.integral(expr.steps.at(-1)!.target, expr.value);
      }
    }
  }
  /** A derived expression over `type` as the kernel computes it, mirroring the reference evaluator. */
  private derivedExpression(type: string, expression: DerivedExpression): KernelDerived | undefined {
    if (expression.op === 'literal') return { op: 'literal', value: expression.value };
    if (expression.op === 'property') return this.derivedValue(type, expression.property, false);
    if (expression.op === 'linked') {
      let current = type, visible = true;
      const steps: KernelStep[] = [];
      for (const step of expression.path) {
        const navigation = this.model.navigation(current, step.link, step.as);
        if (visible) {
          // As the reference's relationship reads: the Interface, the target type, the link and its label, then the target rows.
          if (step.as) this.access.definition(this.model, 'interface', step.as);
          this.access.read(this.model, navigation.target);
          this.access.definition(this.model, 'link', navigation.link);
          const label = this.model.links.get(navigation.link)?.classification;
          visible = this.access.canSeeModelData(label);
          if (visible) {
            this.access.observeClassification(label);
            const readable = this.access.canRead(this.model, navigation.target) ? this.readable(navigation.target) : false;
            if (readable === undefined) return undefined;
            if (!readable) { this.describe(navigation.target); this.rows[navigation.target] = constant(false); }
          }
        }
        steps.push({ link: navigation.link, forward: navigation.forward, target: navigation.target, ...(visible ? {} : { visible: false as const }) });
        current = navigation.target;
      }
      if (expression.aggregate === 'count') return { op: 'linked', steps, aggregate: 'count' };
      if (!expression.property) return undefined;
      // A path the principal cannot follow reaches nothing, so the reference never reads the value.
      if (!visible) return { op: 'linked', steps, aggregate: expression.aggregate };
      const value = this.derivedValue(current, expression.property, expression.aggregate !== 'select');
      return value && { op: 'linked', steps, aggregate: expression.aggregate, value };
    }
    const left = this.derivedExpression(type, expression.left), right = this.derivedExpression(type, expression.right);
    if (!left || !right || !this.numeric(type, left) || !this.numeric(type, right)) return undefined;
    return { op: 'arith', kind: expression.op, left, right };
  }
  private numeric(type: string, expr: KernelDerived): boolean {
    if (expr.op === 'field') { const kind = columnKind(this.model, type, expr.column); return kind === 'integer' || kind === 'number'; }
    if (expr.op === 'derived') { const kind = this.derived[type]?.find(spec => spec.column === expr.column)?.kind; return kind === 'integer' || kind === 'number'; }
    if (expr.op === 'linked') return expr.aggregate !== 'select' || !expr.value || this.numeric(expr.steps.at(-1)!.target, expr.value);
    return true;
  }
  /**
   * A property read inside a derived expression: a stored field through its cell mask, or another derived column. The
   * reference checks these cells only on the rows it evaluates, so planning checks them without recording the checks.
   */
  private derivedValue(type: string, path: string, numeric: boolean): KernelDerived | undefined {
    if (path.includes('.')) return undefined;
    const definition = this.model.object(type).properties[path];
    if (!definition) return undefined;
    if (definition.derived) {
      // The reference applies the derived property's own visibility; masked derived inputs stay on the reference path.
      const cell = this.access.cellVisibility(this.model, type, path);
      if (!cell.visible || cell.policy) return undefined;
      const kind = this.derivedColumn(type, path);
      if (!kind || numeric && kind !== 'integer' && kind !== 'number') return undefined;
      return { op: 'derived', column: path };
    }
    const kind = columnKind(this.model, type, path);
    if (!kind || kind === 'strings' || numeric && kind !== 'integer' && kind !== 'number') return undefined;
    const cell = this.cell(type, path, false);
    if (!cell) return undefined;
    if (cell.hidden) return { op: 'field', column: path, hidden: true };
    return cell.policy ? { op: 'field', column: path, policy: cell.policy } : { op: 'field', column: path };
  }
  /**
   * A field as predicates and aggregations see it: hidden fields read as null for every row, and a cell policy shows the
   * value only on rows it permits. Undefined when the field has no kernel column. `record` records the check as the
   * reference's storage filters do.
   */
  cell(type: string, field: string, record = true): { hidden: true } | { hidden: false; policy?: KernelPredicate } | undefined {
    const kind = this.kind(type, field);
    if (!kind || kind === 'strings') return undefined;
    const cell = record ? this.access.cellRule(this.model, type, field) : this.access.cellVisibility(this.model, type, field);
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

/**
 * Two-valued translation of an Ontology predicate over one concrete type, or undefined when it has no equivalent. Its
 * fields are those of `view`, the type itself or an Interface it implements.
 */
function compilePredicate(scope: Scope, type: string, predicate: Predicate, view = type): KernelPredicate | undefined {
  const all = (items: Predicate[]) => {
    const compiled = items.map(item => compilePredicate(scope, type, item, view));
    return compiled.every(Boolean) ? compiled as KernelPredicate[] : undefined;
  };
  switch (predicate.op) {
    case 'all': case 'any': { const predicates = all(predicate.predicates); return predicates && { op: predicate.op, predicates }; }
    case 'not': { const inner = compilePredicate(scope, type, predicate.predicate, view); return inner && { op: 'not', predicate: inner }; }
    case 'text': case 'regex': return undefined;
    default: break;
  }
  const column = localField(scope.model, type, view, predicate.property);
  // A field the type does not map reads as null on every row.
  if (column === undefined) return constant(predicate.op === 'eq' ? predicate.value === null : predicate.op === 'ne' ? predicate.value !== null
    : predicate.op === 'in' && predicate.values.includes(null));
  const cell = scope.cell(type, column);
  if (!cell) return undefined;
  const kind = scope.kind(type, column)!;
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

type Query = z.output<typeof querySchema>;

/**
 * The checks the reference makes on a set's query before it reads it: the definition and label of its type or
 * Interface, and its fields. Also whether the reference reads every candidate: a filter it cannot run in storage, or
 * one that reads a derived property of any implementing type, is applied after it reads them.
 */
function prepareQuery(scope: Scope, input: Extract<SetExpression, { op: 'query' }>['query']) {
  const { model, access } = scope;
  const q = querySchema.parse({ ...input, limit: 100, cursor: undefined });
  const view = q.type, contract = model.interfaces.get(view);
  if (q.intervalOverlap || !contract && !model.objects.has(view)) return undefined;
  access.definition(model, contract ? 'interface' : 'object', view);
  if (contract) {
    // The reference observes an Interface property's label on each object it projects, so labelled ones stay there.
    if (Object.values(contract.properties).some(property => property.classification)) return undefined;
    if (!access.canSeeModelData(contract.classification)) return { q, view, types: [] as string[], candidates: false };
    access.observeClassification(contract.classification);
  }
  for (const field of queryFields(q)) model.propertyPath(view, field);
  const types = model.concreteTypes(view);
  const fields = [...Object.keys(q.where ?? {}), ...predicateFields(q.filter as Predicate | undefined)].map(field => field.split('.')[0]!);
  const candidates = !supportsStoredPredicate(q.filter as Predicate | undefined) || types.some(type => fields.some(field => {
    const local = localField(model, type, view, field);
    return local !== undefined && Boolean(model.object(type).properties[local]?.derived);
  }));
  return { q, view, types, candidates };
}

/** The query's `where` and filter over one concrete type: null for none, undefined when it has no kernel equivalent. */
function compileFilter(scope: Scope, q: Query, view: string, type: string): KernelPredicate | null | undefined {
  const parts: KernelPredicate[] = [];
  for (const [field, value] of Object.entries(q.where ?? {})) {
    const compiled = compilePredicate(scope, type, { op: 'eq', property: field, value } as Predicate, view);
    if (!compiled) return undefined;
    parts.push(compiled);
  }
  if (q.filter) {
    const compiled = compilePredicate(scope, type, q.filter as Predicate, view);
    if (!compiled) return undefined;
    parts.push(compiled);
  }
  return conjunction(parts) ?? null;
}

/**
 * Compiles an Object Set expression for the kernel. `graph` reads the source object of a relationship query, as the
 * reference does before it reads the relationship.
 */
export async function compileSet(model: Ontology, access: Access, graph: Objects, expression: SetExpression): Promise<KernelPlan | undefined> {
  const scope = new Scope(model, access);
  try {
    const compiled = await compile(scope, graph, expression, 0);
    if (!compiled) return undefined;
    const plan = { ...compiled, rows: scope.rows, members: scope.members, derived: scope.derived, enriched: scope.enriched };
    scopes.set(plan, scope);
    return plan;
  } catch (error) {
    // The reference path reports its own permission, existence and definition errors.
    if (referenceError(error)) return undefined;
    throw error;
  }
}

/**
 * The targets of one object's relationship, as `Objects.follow` reads them, or undefined. The reference checks the view's
 * Interface and the navigation, reads the source object with its derived values through `graph`, then checks the
 * target type, the Link and its label; a Link label beyond the clearance has no targets. The kernel computes only the
 * targets, under the target type's row rule.
 */
export async function compileFollow(model: Ontology, access: Access, graph: Objects, ref: ObjectRef, link: string, view: string): Promise<KernelPlan | undefined> {
  const scope = new Scope(model, access);
  try {
    if (view !== ref.type) access.definition(model, 'interface', view);
    const navigation = model.navigation(ref.type, link, view);
    if (scope.readable(ref.type) === undefined) return undefined;
    await graph.read(ref);
    access.read(model, navigation.target);
    access.definition(model, 'link', navigation.link);
    const label = model.links.get(navigation.link)?.classification;
    let compiled: Compiled = empty();
    if (access.canSeeModelData(label)) {
      access.observeClassification(label);
      const target = navigation.target;
      const readable = scope.readable(target);
      if (readable === undefined) return undefined;
      if (readable) {
        if (!scope.enrich(target)) return undefined;
        compiled = { set: { op: 'traverse', set: { op: 'refs', refs: [ref], enrich: false },
          steps: [[{ source: ref.type, link: navigation.link, forward: navigation.forward, target }]] }, types: new Set([target]) };
      }
    }
    const plan = { ...compiled, rows: scope.rows, members: scope.members, derived: scope.derived, enriched: scope.enriched };
    scopes.set(plan, scope);
    return plan;
  } catch (error) {
    if (referenceError(error)) return undefined;
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
      const prepared = prepareQuery(scope, node.query);
      if (!prepared) return undefined;
      const { q, view, types, candidates } = prepared;
      const flag = candidates ? { candidates: true as const } : {};
      if (!q.from) {
        // One scan per implementing type the principal may read, each with the view's fields read through its own.
        const scans: KernelSet[] = [], members = new Set<string>();
        for (const type of types) {
          if (!access.canRead(model, type)) continue;
          const readable = scope.readable(type);
          if (readable === undefined) return undefined;
          if (!readable) continue;
          const filter = compileFilter(scope, q, view, type);
          if (filter === undefined || !scope.enrich(type)) return undefined;
          scans.push({ op: 'scan', type, ...(filter ? { filter } : {}), ...flag });
          members.add(type);
        }
        return { set: scans.length === 1 ? scans[0]! : scans.length ? { op: 'union', sets: scans } : { op: 'empty' }, types: members };
      }
      if (!types.length) return empty();
      const navigation = model.navigation(q.from.object.type, q.from.link, q.from.as);
      if (q.from.as) access.definition(model, 'interface', q.from.as);
      const source = scope.readable(q.from.object.type);
      if (source === undefined) return undefined;
      // The reference reads the source object, without its derived values, before it reads the relationship.
      await graph.readStored(q.from.object);
      access.read(model, navigation.target);
      access.definition(model, 'link', navigation.link);
      const label = model.links.get(navigation.link)?.classification;
      if (!access.canSeeModelData(label)) return empty();
      access.observeClassification(label);
      const target = navigation.target;
      if (!types.includes(target) || !access.canRead(model, target)) return empty();
      const readable = scope.readable(target);
      if (readable === undefined) return undefined;
      if (!readable) return empty();
      const filter = compileFilter(scope, q, view, target);
      if (filter === undefined || !scope.enrich(target)) return undefined;
      return {
        set: { op: 'traverse', set: { op: 'refs', refs: [q.from.object], enrich: false },
          steps: [[{ source: q.from.object.type, link: navigation.link, forward: navigation.forward, target, ...(filter ? { filter } : {}), ...flag }]] },
        types: new Set([target]),
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
        if (!readable) continue;
        if (!scope.enrich(ref.type)) return undefined;
        refs.push(ref);
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
        const moves: KernelMove[] = [], next = new Set<string>();
        for (const source of types) {
          // A source type that does not implement the step's Interface fails in the reference, as it does here.
          const navigation = model.navigation(source, step.link, step.as);
          if (step.as) access.definition(model, 'interface', step.as);
          access.read(model, source);
          access.read(model, navigation.target);
          access.definition(model, 'link', navigation.link);
          const label = model.links.get(navigation.link)?.classification;
          if (!access.canSeeModelData(label)) continue;
          access.observeClassification(label);
          const readable = scope.readable(navigation.target);
          if (readable === undefined) return undefined;
          if (!readable) continue;
          if (!scope.enrich(navigation.target)) return undefined;
          moves.push({ source, link: navigation.link, forward: navigation.forward, target: navigation.target });
          next.add(navigation.target);
        }
        steps.push(moves);
        types = next;
      }
      return { set: { op: 'traverse', set: start.set, steps }, types };
    }
    case 'saved':
    case 'machinery':
      return undefined;
  }
}

/**
 * One member type of an aggregation: each field the aggregation reads, from the type's own column through its mask, or
 * null where the type does not map it.
 */
export type KernelAggregatePart = { type: string; fields: { name: string; column?: string; hidden?: true; policy?: KernelPredicate }[] };
type FieldKind = Exclude<KernelKind, 'strings'>;
const mergeKinds = (known: FieldKind | undefined, kind: FieldKind): FieldKind | undefined =>
  !known || known === kind ? kind : [known, kind].every(item => item === 'integer' || item === 'number') ? 'number' : undefined;

/**
 * Aggregation over a set's members, in `view` or in their own types, or undefined. Each member type contributes its
 * fields read through the view: an Interface maps them to the type's own properties, which may be stored or derived.
 */
export function compileAggregate(model: Ontology, access: Access, plan: KernelPlan, input: Pick<AggregateInput, 'view' | 'groupBy' | 'metrics'>) {
  const scope = scopes.get(plan);
  if (!scope || scope.model !== model || scope.access !== access || !plan.types.size) return undefined;
  try {
    const fields = [...new Set([...input.groupBy, ...Object.values(input.metrics).flatMap(metric => metric.property ? [metric.property] : [])])];
    const view = input.view, contract = view ? model.interfaces.get(view) : undefined;
    if (contract && Object.values(contract.properties).some(property => property.classification)) return undefined;
    // As the reference: a view's fields are its own; without one, each member type must have every field.
    for (const type of view ? [view] : plan.types) for (const field of fields) model.propertyPath(type, field);
    const kinds: Record<string, FieldKind> = {};
    const parts: KernelAggregatePart[] = [];
    for (const type of plan.types) {
      if (view && !showsType(model, view, type) || !scope.readable(type)) return undefined;
      const partFields: KernelAggregatePart['fields'] = [];
      for (const field of fields) {
        if (field.includes('.')) return undefined;
        const column = view ? localField(model, type, view, field) : field;
        if (column === undefined) { partFields.push({ name: field }); continue; }
        const cell = scope.cell(type, column), kind = scope.kind(type, column);
        if (!cell || !kind || kind === 'strings') return undefined;
        const merged = mergeKinds(kinds[field], kind);
        if (!merged) return undefined;
        kinds[field] = merged;
        partFields.push({ name: field, column, ...(cell.hidden ? { hidden: true as const } : cell.policy ? { policy: cell.policy } : {}) });
      }
      parts.push({ type, fields: partFields });
    }
    // A field no member type maps is null on every member.
    for (const field of fields) kinds[field] ??= 'number';
    for (const metric of Object.values(input.metrics))
      if (metric.op !== 'count' && kinds[metric.property!] !== 'integer' && kinds[metric.property!] !== 'number') return undefined;
    return {
      kind: 'aggregate' as const, parts, kinds, groupBy: input.groupBy,
      metrics: Object.entries(input.metrics).map(([name, metric]) => ({ name, op: metric.op, column: metric.property })),
    };
  } catch (error) {
    if (referenceError(error)) return undefined;
    throw error;
  }
}

/**
 * One page of a query's members in the order the reference gives a query it evaluates completely, or undefined. Each
 * member type contributes the order fields read through the query's type: an Interface maps them to the type's own
 * properties, stored or derived, which are null where the type maps none or property security hides them. Nested
 * fields, lists and fields whose kinds differ across member types, other than integers with numbers, stay on the
 * reference, which compares them itself. Ordering reads nothing beyond the members, so it records nothing either.
 */
export function compileQueryOrder(model: Ontology, access: Access, plan: KernelPlan, query: Pick<Query, 'type' | 'orderBy'>, offset: number, limit: number) {
  const scope = scopes.get(plan);
  if (!scope || scope.model !== model || scope.access !== access) return undefined;
  try {
    const view = query.type, order = query.orderBy ?? [];
    const fields = [...new Set(order.map(item => item.property))];
    const kinds: Record<string, FieldKind> = {};
    const parts: KernelAggregatePart[] = [];
    for (const type of plan.types) {
      if (!showsType(model, view, type) || !scope.readable(type)) return undefined;
      const partFields: KernelAggregatePart['fields'] = [];
      for (const field of fields) {
        if (field.includes('.')) return undefined;
        const column = localField(model, type, view, field);
        if (column === undefined) { partFields.push({ name: field }); continue; }
        const cell = scope.cell(type, column, false), kind = scope.kind(type, column);
        if (!cell || !kind || kind === 'strings') return undefined;
        const merged = mergeKinds(kinds[field], kind);
        if (!merged) return undefined;
        kinds[field] = merged;
        partFields.push({ name: field, column, ...(cell.hidden ? { hidden: true as const } : cell.policy ? { policy: cell.policy } : {}) });
      }
      parts.push({ type, fields: partFields });
    }
    for (const field of fields) kinds[field] ??= 'number';
    return { kind: 'query' as const, offset, limit, parts, kinds, order: order.map(item => ({ name: item.property, desc: item.direction === 'desc' })) };
  } catch (error) {
    if (referenceError(error)) return undefined;
    throw error;
  }
}
