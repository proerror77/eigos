import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import { nameSchema, type ObjectRef } from '../ontology/model.js';
import { objectQuerySchema, type OntologyQueryResult, type ObjectQuery, type ObjectView } from '../ontology/object-store.js';
import type { Computation } from '../ontology/object-functions.js';

/** Exact known references only. Discovery and external source actions remain
 * separate, explicitly chosen operations. No scene-specific context objects. */
export const requestedFactsSchema = z.array(z.strictObject({
  key: nameSchema,
  query: z.union([objectQuerySchema.options[1].extend({ limit: z.number().int().min(1).max(10).default(10) }), objectQuerySchema.options[2].extend({ limit: z.number().int().min(1).max(10).default(10) })]),
  requiredFields: z.array(nameSchema).max(20).optional(),
  evaluate: z.boolean().optional().describe('Check current applicability for ObservedFact objects. Other types remain readable and require their own registered evaluator; unsupported evaluation does not request a source refresh.'),
})).min(1).max(8).refine(values => new Set(values.map(value => value.key)).size === values.length, 'Fact request keys must be unique');
export type RequestedFacts = z.infer<typeof requestedFactsSchema>;
export interface RequestedFactResult {
  key: string; status: 'present' | 'missing' | 'incomplete' | 'refresh_required' | 'evaluation_unavailable'; items: ObjectView[];
  missingFields: string[]; evaluations?: (Computation & { object: ObjectRef })[]; evaluationUnavailable?: ObjectRef[]; evaluationReason?: string; hasMore: boolean; continuation?: ObjectQuery;
}

/** Batch only within this synchronous read. A later decision rechecks authority
 * and current data; no old permission, receipt or provider response is reused. */
export function readRequestedFacts(requests: RequestedFacts, query: (input: ObjectQuery) => OntologyQueryResult,
  evaluate: (object: ObjectView) => Computation | undefined) {
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
  const evaluated = new Map<string, Computation | undefined>();
  const facts: RequestedFactResult[] = normalized.map((request, index) => {
    const group = groups.get(keys[index]!)!;
    group.result ??= query(group.query);
    const result = group.result;
    const items = result.items.map(item => ({ ...item, properties: request.query.select
      ? Object.fromEntries(request.query.select.filter(name => Object.hasOwn(item.properties, name)).map(name => [name, item.properties[name]])) : item.properties }));
    const missingFields = [...new Set((request.requiredFields ?? []).filter(name => !items.length || items.some(item => !Object.hasOwn(item.properties, name))))];
    const evaluationUnavailable: ObjectRef[] = [];
    const evaluations = request.evaluate ? items.flatMap(item => {
      const key = digest([item.ref, item.revision]);
      if (!evaluated.has(key)) {
        const result = evaluate(item);
        if (result) { const { value: _value, ...check } = result; evaluated.set(key, check); }
        else evaluated.set(key, undefined);
      }
      const result = evaluated.get(key);
      if (!result) { evaluationUnavailable.push(item.ref); return []; }
      return [{ ...result, object: item.ref }];
    }) : undefined;
    const status = result.page.hasMore ? 'incomplete' : !items.length || missingFields.length ? 'missing' : evaluations?.some(value => value.status !== 'known') ? 'refresh_required' : evaluationUnavailable.length ? 'evaluation_unavailable' : 'present';
    return { key: request.key, status, items, missingFields, ...(evaluations ? { evaluations } : {}), ...(evaluationUnavailable.length ? { evaluationUnavailable,
      evaluationReason: 'Automatic current-observation checks support ObservedFact. These objects were read successfully, but that evaluator does not apply to their types. No source refresh is implied; choose a registered function only if a further business conclusion requires it.' } : {}), hasMore: result.page.hasMore,
      ...(result.page.cursor ? { continuation: { ...group.query, cursor: result.page.cursor } } : {}) };
  });
  const output = { facts, reads: { requested: requests.length, performed: groups.size, reused: requests.length - groups.size },
    needsRefresh: facts.filter(fact => ['missing', 'refresh_required'].includes(fact.status)).map(fact => fact.key),
    needsContinuation: facts.filter(fact => fact.status === 'incomplete').map(fact => fact.key), sourceCalls: 0 as const };
  const result = { ...output, needsEvaluation: facts.filter(fact => fact.evaluationUnavailable?.length).map(fact => fact.key),
    ...(requests.some(request => request.evaluate) ? { evaluationMeaning: 'Each evaluation names its object. known checks only the current source-observation contract; it does not establish a price amount or business completion. Inspect actual fields and each evaluation: a refresh_required group may also contain valid objects. Unsupported evaluation does not imply a provider call.' } : {}) };
  if (Buffer.byteLength(JSON.stringify(result)) > 64000) throw new DomainError('INVALID_INPUT', 'Requested facts exceed the response bound; narrow the selected fields');
  return result;
}
