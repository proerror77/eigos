import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import { nameSchema } from '../ontology/model.js';
import { objectQuerySchema, type OntologyQueryResult, type ObjectQuery, type ObjectView } from '../ontology/object-store.js';
import type { Computation } from '../ontology/object-functions.js';

/** Exact known references only. Discovery and external source actions remain
 * separate, explicitly chosen operations. No scene-specific context objects. */
export const requestedFactsSchema = z.array(z.strictObject({
  key: nameSchema,
  query: z.union([objectQuerySchema.options[1].extend({ limit: z.number().int().min(1).max(10).default(10) }), objectQuerySchema.options[2].extend({ limit: z.number().int().min(1).max(10).default(10) })]),
  requiredFields: z.array(nameSchema).max(20).optional(),
  evaluate: z.boolean().optional(),
})).min(1).max(8).refine(values => new Set(values.map(value => value.key)).size === values.length, 'Fact request keys must be unique');
export type RequestedFacts = z.infer<typeof requestedFactsSchema>;
export interface RequestedFactResult {
  key: string; status: 'present' | 'missing' | 'incomplete' | 'refresh_required'; items: ObjectView[];
  missingFields: string[]; evaluations?: Computation[]; hasMore: boolean; continuation?: ObjectQuery;
}

/** Batch only within this synchronous read. A later decision rechecks authority
 * and current data; no old permission, receipt or provider response is reused. */
export function readRequestedFacts(requests: RequestedFacts, query: (input: ObjectQuery) => OntologyQueryResult,
  evaluate: (object: ObjectView) => Computation) {
  const normalized = requests.map(request => ({ ...request, query: { ...request.query,
    ...(request.query.select || request.requiredFields?.length ? { select: [...new Set([...(request.query.select ?? []), ...(request.requiredFields ?? [])])] } : {}),
  } }));
  const groups = new Map<string, { query: ObjectQuery; result?: OntologyQueryResult }>();
  const keys = normalized.map(request => {
    const { select, ...base } = request.query, key = digest(base), old = groups.get(key);
    if (!old) groups.set(key, { query: request.query });
    else old.query = { ...old.query, select: old.query.select && select ? [...new Set([...old.query.select, ...select])] : undefined };
    return key;
  });
  const evaluated = new Map<string, Computation>();
  const facts: RequestedFactResult[] = normalized.map((request, index) => {
    const group = groups.get(keys[index]!)!;
    group.result ??= query(group.query);
    const result = group.result;
    const items = result.items.map(item => ({ ...item, properties: request.query.select
      ? Object.fromEntries(request.query.select.filter(name => Object.hasOwn(item.properties, name)).map(name => [name, item.properties[name]])) : item.properties }));
    const missingFields = [...new Set((request.requiredFields ?? []).filter(name => !items.length || items.some(item => !Object.hasOwn(item.properties, name))))];
    const evaluations = request.evaluate ? items.map(item => {
      const key = digest([item.ref, item.revision]);
      if (!evaluated.has(key)) { const { value: _value, ...check } = evaluate(item); evaluated.set(key, check); }
      return evaluated.get(key)!;
    }) : undefined;
    const status = result.page.hasMore ? 'incomplete' : !items.length || missingFields.length ? 'missing' : evaluations?.some(value => value.status !== 'known') ? 'refresh_required' : 'present';
    return { key: request.key, status, items, missingFields, ...(evaluations ? { evaluations } : {}), hasMore: result.page.hasMore,
      ...(result.page.cursor ? { continuation: { ...group.query, cursor: result.page.cursor } } : {}) };
  });
  const output = { facts, reads: { requested: requests.length, performed: groups.size, reused: requests.length - groups.size },
    needsRefresh: facts.filter(fact => ['missing', 'refresh_required'].includes(fact.status)).map(fact => fact.key),
    needsContinuation: facts.filter(fact => fact.status === 'incomplete').map(fact => fact.key), sourceCalls: 0 as const };
  if (Buffer.byteLength(JSON.stringify(output)) > 64000) throw new DomainError('INVALID_INPUT', 'Requested facts exceed the response bound; narrow the selected fields');
  return output;
}
