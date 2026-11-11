import type { Client } from 'pg';
import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError, type Principal } from '../core/domain.js';
import { nameSchema, objectRefSchema, type ObjectRef, type PropertyDefinition } from '../ontology/model.js';
import { objectQuerySchema, type ObjectView, type ReadBudget } from '../ontology/object-store.js';
import type { StagedKernelBuilder } from '../ontology/seed-definition.js';
import { combineEnvelopes, type SecurityEnvelope } from '../security/envelope.js';
import { SecurityError } from '../security/errors.js';
import type { PostgresTaskReadAuthorization } from './task-output.js';
import { postgresTaskReadOntology, postgresTaskResourceViewValidUntil } from './task-read-access.js';
import { postgresBusinessToken, postgresConstrainReadDeadline } from './runtime-transaction.js';
import { postgresQueryAuthorizedObjects, type PostgresOntologyCursor, type PostgresPlanningReadRows } from './ontology-read-query.js';
import { relationNavigation } from './relation-query-plan.js';
import { validateQueryFields } from './query-field-validation.js';

const numericAggregate = z.strictObject({ kind: z.enum(['sum', 'min', 'max']), property: nameSchema,
  unitFields: z.array(nameSchema).max(4) });
const internalPlanSchema = z.strictObject({
  starts: z.array(objectRefSchema).min(1).max(8),
  hops: z.array(z.strictObject({ link: nameSchema, as: nameSchema.optional() })).min(1).max(3),
  select: objectQuerySchema.options[0].shape.select,
  where: objectQuerySchema.options[0].shape.where,
  terminal: z.union([
    z.strictObject({ kind: z.literal('rows'), orderBy: z.array(z.strictObject({ property: nameSchema, direction: z.enum(['asc', 'desc']) })).max(2).default([]),
      offset: z.number().int().min(0).max(49).default(0), limit: z.number().int().min(1).max(50).default(20) }),
    z.strictObject({ kind: z.literal('count') }), numericAggregate,
  ]),
});
export type AuthorizedRelationPlan = z.input<typeof internalPlanSchema>;
type RelationTerminalResult = { kind: 'rows'; items: ObjectView[]; count: number; hasMore: boolean; nextOffset?: number }
  | { kind: 'count'; value: number }
  | { kind: 'sum' | 'min' | 'max'; property: string; value: string | null; count: number; units: Record<string, unknown> };
export type AuthorizedRelationPlanResult = {
  scope: 'authorized_relationship_path'; selectionDigest: string; sourceCalls: 0;
  /** Calls/pages through the authorized query entry, not database round trips. */
  authorizedQueryPages: number;
} & RelationTerminalResult;
function fail(message: string): never { throw new DomainError('CONFLICT', message); }
const refKey = (ref: ObjectRef) => JSON.stringify([ref.type, ref.id]);

function scalar(property: PropertyDefinition | undefined, name: string) {
  if (!property || property.derived || property.restricted || ['struct', 'array'].includes(property.kind)) throw new DomainError('INVALID_INPUT', `Relation plan requires a visible stored scalar: ${name}`);
  return property;
}
function normalizedScalar(property: PropertyDefinition, value: unknown): { kind: 'text' | 'numeric'; value: string } | undefined {
  if (value === undefined || value === null) return;
  const parsed = property.schema.safeParse(value);
  if (!parsed.success || digest(parsed.data) !== digest(value)) fail('Relation plan encountered an invalid or noncanonical scalar');
  if (property.kind === 'string') { if (typeof value !== 'string') fail('Relation plan string has an invalid representation'); return { kind: 'text', value }; }
  if (property.kind === 'boolean') { if (typeof value !== 'boolean') fail('Relation plan boolean has an invalid representation'); return { kind: 'numeric', value: value ? '1' : '0' }; }
  if (property.kind === 'integer') {
    if (!Number.isSafeInteger(value)) fail('Relation plan integer exceeds exact JavaScript precision');
    return { kind: 'numeric', value: String(value) };
  }
  if (property.kind === 'timestamp') {
    const milliseconds = Date.parse(String(value));
    if (!Number.isSafeInteger(milliseconds)) fail('Relation plan timestamp is invalid');
    return { kind: 'numeric', value: String(milliseconds) };
  }
  if (property.kind === 'decimal') {
    if (typeof value !== 'string') fail('Relation plan decimal requires an exact string representation');
    const text = value;
    if (!/^-?(0|[1-9][0-9]{0,17})([.][0-9]{1,6})?$/.test(text)) fail('Relation plan decimal has no reviewed exact representation');
    return { kind: 'numeric', value: BigInt(text.replace('.', '').padEnd(text.split('.')[0]!.length + 6, '0')).toString() };
  }
  return fail('Relation plan scalar kind is unsupported');
}
function decimalValue(value: string) {
  const integer = BigInt(value), negative = integer < 0n, absolute = negative ? -integer : integer;
  const fraction = String(absolute % 1000000n).padStart(6, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${absolute / 1000000n}${fraction ? `.${fraction}` : ''}`;
}

/** Internal host contract only: not accepted by query_ontology or ObjectQuery.
 * Each hop uses ordinary authorized queries, and only their visible results can
 * become the next frontier. SQL sorts/aggregates the resulting checked values,
 * never an owner-wide table or hidden intermediate objects. A numeric caller
 * explicitly names invariant unit fields; this does not infer price comparability.
 */
export async function postgresQueryAuthorizedRelationPlan(client: Client, principal: Principal, taskId: string,
  input: AuthorizedRelationPlan, policyDigest: string, auth: PostgresTaskReadAuthorization, builder?: StagedKernelBuilder,
  options: { budget?: ReadBudget; readRows?: PostgresPlanningReadRows; onRead?: (envelope: SecurityEnvelope) => void } = {}): Promise<AuthorizedRelationPlanResult> {
  const token = postgresBusinessToken(client), plan = internalPlanSchema.parse(input), p = structuredClone(principal);
  if (new Set(plan.starts.map(refKey)).size !== plan.starts.length) throw new DomainError('INVALID_INPUT', 'Relation plan source identities must be unique');
  const model = (await postgresTaskReadOntology(client, p, taskId, policyDigest, builder)).model;
  const targets: string[] = [];
  const resources = new Map<string, { kind: string; id: string }>();
  let sourceTypes = [...new Set(plan.starts.map(ref => ref.type))];
  for (const hop of plan.hops) {
    if (hop.as) resources.set(`interface:${hop.as}`, { kind: 'interface', id: hop.as });
    const navigations = sourceTypes.map(type => {
      const navigation = relationNavigation(model, { type, id: 'internal-plan-type' }, hop.link, hop.as);
      resources.set(`linkType:${navigation.linkId}`, { kind: 'linkType', id: navigation.linkId });
      return navigation;
    });
    const views = [...new Set(navigations.map(navigation => navigation.target))];
    if (views.length !== 1) fail('Relation plan requires one explicit target view per hop');
    const kind = model.isInterface(views[0]!) ? 'interface' : 'objectType';
    resources.set(`${kind}:${views[0]}`, { kind, id: views[0]! });
    targets.push(views[0]!); sourceTypes = [...new Set(navigations.flatMap(navigation => model.concreteTypes(navigation.endpointType)))];
  }
  for (const resource of resources.values()) {
    const until = await postgresTaskResourceViewValidUntil(client, p, taskId, policyDigest, resource.kind, resource.id, builder);
    if (until <= Date.now()) throw new SecurityError('AUTHORIZATION_REQUIRED');
    postgresConstrainReadDeadline(client, until);
  }
  validateQueryFields(model.properties(targets.at(-1)!), plan.select, plan.where);
  const budget = options.budget ?? { remaining: 1000 }, cursors = new Map<string, PostgresOntologyCursor>();
  const evidence = new Map<string, SecurityEnvelope>(), capture = (value: SecurityEnvelope) => { evidence.set(digest(value), value); options.onRead?.(structuredClone(value)); };
  let frontier = plan.starts, leaves: ObjectView[] = [], authorizedQueryPages = 0;
  const required = plan.terminal.kind === 'rows' ? plan.terminal.orderBy.map(order => order.property)
    : plan.terminal.kind === 'count' ? [] : [plan.terminal.property, ...plan.terminal.unitFields];
  for (const [index, hop] of plan.hops.entries()) {
    const last = index === plan.hops.length - 1, next = new Map<string, ObjectView>();
    for (const from of frontier) {
      const navigation = relationNavigation(model, from, hop.link, hop.as);
      const target = targets[index]!;
      if (target !== navigation.target) fail('Relation plan target differs from its compiled view');
      const properties = model.properties(target);
      if (last) for (const name of required) scalar(properties[name], name);
      const identityField = model.isInterface(target) ? Object.keys(properties).find(name => !properties[name]!.restricted && !properties[name]!.derived) : model.object(target).primaryKey;
      const selected = last ? plan.select ? [...new Set([...plan.select, ...required])]
        : plan.terminal.kind === 'rows' ? undefined : required.length ? [...new Set(required)] : identityField ? [identityField] : undefined
        : identityField ? [identityField] : undefined;
      let cursor: string | undefined;
      do {
        if (++authorizedQueryPages > 64) fail('Relation plan exceeds its bounded authorized query/page count');
        const read = await postgresQueryAuthorizedObjects(client, p, { version: 2, taskId,
          query: objectQuerySchema.parse({ from, link: hop.link, ...(hop.as ? { as: hop.as } : {}), ...(selected ? { select: selected } : {}),
            ...(last ? { where: plan.where } : {}), limit: 50, ...(cursor ? { cursor } : {}) }) }, policyDigest, auth, builder,
        { budget, cursors, readRows: options.readRows, readScope: `relation-plan:${digest(plan)}`, onRead: capture });
        for (const object of read.query.items) {
          const key = refKey(object.ref), previous = next.get(key);
          if (previous && digest(previous) !== digest(object)) fail('Relation plan encountered inconsistent shared endpoints');
          next.set(key, object);
        }
        if (next.size > 50) fail('Relation plan exceeds its complete frontier bound');
        cursor = read.query.page.hasMore ? read.query.page.cursor : undefined;
        if (read.query.page.hasMore && !cursor) fail('Relation plan query cannot continue completely');
      } while (cursor);
    }
    leaves = [...next.values()]; frontier = leaves.map(object => object.ref);
    if (!frontier.length) break;
  }
  const properties = model.properties(targets.at(-1)!), terminal = plan.terminal;
  const rows = leaves.map((object, n) => ({ n, type: object.ref.type, id: object.ref.id, keys: [] as (string | null)[], aggregate: null as string | null }));
  const ordering: string[] = [];
  const units: Record<string, unknown> = {};
  if (terminal.kind === 'rows') for (const [index, order] of terminal.orderBy.entries()) {
    const property = scalar(properties[order.property], order.property);
    const kind = property.kind === 'string' ? 'text' : 'numeric';
    for (const [position, object] of leaves.entries()) {
      let value = object.properties[order.property];
      if (!Object.hasOwn(object.properties, order.property) && plan.select === undefined) {
        // A default projection omits denied fields. Explicitly authorize an
        // absent sort key before treating it as an optional null value.
        const checked = await auth.readView(object.ref, targets.at(-1)!, [order.property]);
        capture(checked.envelope);
        value = checked.object.properties[order.property];
      }
      rows[position]!.keys[index] = normalizedScalar(property, value)?.value ?? null;
    }
    ordering.push(`${kind === 'text' ? `(keys->>${index}) COLLATE "C"` : `(keys->>${index})::numeric`} ${order.direction === 'asc' ? 'ASC' : 'DESC'} NULLS LAST`);
  }
  let aggregateProperty: PropertyDefinition | undefined;
  if (terminal.kind !== 'rows' && terminal.kind !== 'count') {
    aggregateProperty = scalar(properties[terminal.property], terminal.property);
    if (!['integer', 'decimal'].includes(aggregateProperty.kind)) throw new DomainError('INVALID_INPUT', 'Numeric relation aggregates require integer or decimal properties');
    for (const field of terminal.unitFields) {
      const property = scalar(properties[field], field);
      const values = leaves.map(object => object.properties[field]);
      if (values.some(value => value === undefined || value === null) || new Set(values.map(digest)).size > 1) fail('Relation aggregate units are missing or inconsistent');
      for (const value of values) normalizedScalar(property, value);
      if (values.length) units[field] = values[0];
    }
    leaves.forEach((object, n) => {
      const value = normalizedScalar(aggregateProperty!, object.properties[terminal.property]);
      if (!value) fail('Relation aggregate values are incomplete');
      rows[n]!.aggregate = value.value;
    });
  }
  const encoded = JSON.stringify(rows);
  if (Buffer.byteLength(encoded) > 8388608) fail('Relation plan checked values exceed their byte bound');
  const source = `WITH authorized AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(n integer,type text,id text,keys jsonb,aggregate text))`;
  let result: RelationTerminalResult;
  if (terminal.kind === 'rows') {
    const sorted = await client.query<{ n: number }>(`${source} SELECT n FROM authorized ORDER BY ${[...ordering, 'type COLLATE "C"', 'id COLLATE "C"'].join(',')}
      LIMIT $2 OFFSET $3`, [encoded, terminal.limit, terminal.offset]);
    const items = sorted.rows.map(row => {
      if (!Number.isInteger(row.n) || !leaves[row.n]) return fail('Relation plan returned an invalid row position');
      const object = leaves[row.n]!;
      return plan.select ? { ...object, properties: Object.fromEntries(plan.select.filter(field => Object.hasOwn(object.properties, field)).map(field => [field, object.properties[field]])) } : object;
    });
    const nextOffset = terminal.offset + items.length, hasMore = nextOffset < leaves.length;
    result = { kind: 'rows', items, count: leaves.length, hasMore, ...(hasMore ? { nextOffset } : {}) };
  } else {
    const operation = terminal.kind === 'count' ? '' : `,${terminal.kind}(aggregate::numeric)::text AS value`;
    const aggregate = await client.query<{ count: string; value?: string | null }>(`${source} SELECT count(*)::text AS count${operation} FROM authorized`, [encoded]);
    const row = aggregate.rows[0], count = Number(row?.count);
    if (aggregate.rowCount !== 1 || !Number.isSafeInteger(count) || count !== leaves.length) fail('Relation aggregate returned an invalid count');
    if (terminal.kind === 'count') result = { kind: 'count', value: count };
    else {
      if (row!.value !== null && (typeof row!.value !== 'string' || !/^-?[0-9]+$/.test(row!.value))) fail('Relation aggregate returned an invalid exact value');
      result = { kind: terminal.kind, property: terminal.property, value: row!.value === null ? null
        : aggregateProperty!.kind === 'decimal' ? decimalValue(row!.value!) : row!.value!, count, units };
    }
  }
  if (postgresBusinessToken(client) !== token) fail('Relation plan outlived its transaction');
  await auth.authorizeEvidence(combineEnvelopes([...evidence.values()]));
  return { ...result, scope: 'authorized_relationship_path', selectionDigest: digest(leaves.map(object => [object.ref, object.revision, object.properties])), sourceCalls: 0, authorizedQueryPages };
}
