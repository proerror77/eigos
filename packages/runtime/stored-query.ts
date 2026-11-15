import { valueKinds } from '../ontology/property-path.js';
import type { Predicate } from './query-filter.js';

export type Metric = { op: 'count'; property?: string } | { op: 'sum' | 'min' | 'max' | 'avg'; property: string };

function isPostgresScalar(value: unknown): boolean {
  return typeof value !== 'string' || !/[\u0000\uD800-\uDFFF]/u.test(value);
}

export function supportsStoredPredicate(predicate?: Predicate): boolean {
  if (!predicate) return true;
  switch (predicate.op) {
    case 'all': case 'any': return predicate.predicates.every(supportsStoredPredicate);
    case 'not': return supportsStoredPredicate(predicate.predicate);
    case 'text': case 'regex': return false;
    // JavaScript compares strings as UTF-16 code units. Preserve that behavior on the fallback path.
    case 'gt': case 'gte': case 'lt': case 'lte': return typeof predicate.value === 'number';
    case 'in': return predicate.values.every(isPostgresScalar);
    default: return isPostgresScalar(predicate.value);
  }
}

export function isNumeric(schema: Record<string, unknown>) {
  const kinds = valueKinds(schema).filter(kind => kind !== 'null');
  return kinds.length > 0 && kinds.every(kind => kind === 'number' || kind === 'integer');
}

export function supportsStoredOrder(schema: Record<string, unknown>) {
  return isNumeric(schema) || valueKinds(schema).every(kind => kind === 'boolean' || kind === 'null');
}

export function storedPredicate(predicate: Predicate, property: (path: string) => string, bind: (value: unknown) => string): string {
  switch (predicate.op) {
    case 'all': case 'any': return '(' + predicate.predicates.map(child => storedPredicate(child, property, bind)).join(predicate.op === 'all' ? ' AND ' : ' OR ') + ')';
    case 'not': return 'NOT (' + storedPredicate(predicate.predicate, property, bind) + ')';
    case 'in': return `EXISTS(SELECT 1 FROM jsonb_array_elements(${bind(JSON.stringify(predicate.values))}::jsonb) AS candidate(value) WHERE candidate.value=${property(predicate.property)})`;
    default: {
      const field = property(predicate.property), value = bind(JSON.stringify(predicate.value));
      if (predicate.op === 'eq' || predicate.op === 'ne') return `${field}${predicate.op === 'eq' ? '=' : '<>'}${value}::jsonb`;
      if (predicate.op === 'contains') return `CASE jsonb_typeof(${field})
        WHEN 'string' THEN jsonb_typeof(${value}::jsonb)='string' AND strpos((${field}#>>'{}') COLLATE "C",${value}::jsonb#>>'{}')>0
        WHEN 'array' THEN EXISTS(SELECT 1 FROM jsonb_array_elements(${field}) AS element(value) WHERE element.value=${value}::jsonb)
        ELSE FALSE END`;
      const operation = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[predicate.op as 'gt' | 'gte' | 'lt' | 'lte'];
      if (!operation || typeof predicate.value !== 'number') throw new Error('Unsupported stored predicate');
      return `(jsonb_typeof(${field})='number' AND ${field}${operation}${value}::jsonb)`;
    }
  }
}
