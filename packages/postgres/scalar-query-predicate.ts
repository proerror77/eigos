import type { OntologyModel, PropertyDefinition } from '../ontology/model.js';
import type { ObjectQuery } from '../ontology/object-store.js';

type Filter = NonNullable<ObjectQuery['where']>[number];
const decimal = /^-?(0|[1-9]\d{0,17})(\.\d{1,6})?$/;

/** A predicate on an already authorized, materialized candidate set. Only an
 * entirely supported filter group is pushed down. Unknown representations and
 * historical definitions pass through for the original JS validation, including
 * its ordered short circuit and invalid-decimal errors. */
export function postgresScalarQueryPredicate(model: OntologyModel, target: string, filters: readonly Filter[],
  properties: Record<string, PropertyDefinition>, parameters: unknown[]): string | undefined {
  if (!filters.length) return;
  const supported = filters.every(filter => {
    const property = properties[filter.property], values = filter.op === 'in' ? filter.value : [filter.value];
    if (!property || !Array.isArray(values)) return false;
    if (property.kind === 'string') return ['eq', 'in'].includes(filter.op) && values.every(value => typeof value === 'string');
    if (property.kind === 'boolean') return ['eq', 'in'].includes(filter.op) && values.every(value => typeof value === 'boolean');
    if (property.kind === 'integer') return values.every(value => typeof value === 'number' && Number.isSafeInteger(value));
    if (property.kind === 'decimal') return values.every(value => typeof value === 'string' && decimal.test(value));
    // PostgreSQL timestamps have different accepted syntax and submillisecond
    // precision from Date.parse. Keep that contract in the bounded JS path.
    return false;
  });
  if (!supported) return;
  const types = model.concreteTypes(target);
  if (!types.length) return;
  const parameter = (value: unknown) => { parameters.push(value); return `$${parameters.length}`; };
  const branches = types.map(type => {
    const typeParameter = parameter(type), fingerprint = parameter(model.fingerprint(type));
    const primary = parameter(model.object(type).primaryKey);
    const validBody = `o.body IS NOT NULL AND o.revision BETWEEN 1 AND 9007199254740991
      AND jsonb_typeof(o.query_body)='object' AND jsonb_typeof(o.query_body->'properties')='object'
      AND jsonb_typeof(o.query_body->'properties'->${primary})='string'
      AND (o.query_body->'properties'->>${primary}) COLLATE "C"=o.id COLLATE "C"`;
    const normalized = filters.map(filter => {
      const name = parameter(model.propertyName(type, target, filter.property));
      const value = `o.query_body->'properties'->${name}`, text = `(o.query_body->'properties'->>${name})`;
      const kind = properties[filter.property]!.kind;
      if (kind === 'string' || kind === 'boolean') return {
        expression: `(CASE WHEN jsonb_typeof(${value})='${kind}' THEN ${text} END)`, sqlType: 'text',
      };
      if (kind === 'integer') return {
        expression: `(CASE WHEN jsonb_typeof(${value})='number' AND ${text} ~ '^-?(0|[1-9][0-9]{0,15})$'
          THEN CASE WHEN ${text}::numeric BETWEEN -9007199254740991 AND 9007199254740991 THEN ${text}::numeric END END)`, sqlType: 'numeric',
      };
      return {
        expression: `(CASE WHEN jsonb_typeof(${value})='string' AND ${text} ~ '^-?(0|[1-9][0-9]{0,17})([.][0-9]{1,6})?$' THEN ${text}::numeric END)`, sqlType: 'numeric',
      };
    });
    const comparisons = filters.map((filter, index) => {
      const { expression, sqlType } = normalized[index]!;
      const left = sqlType === 'text' ? `${expression} COLLATE "C"` : expression;
      const value = parameter(filter.op === 'in' ? (filter.value as unknown[]).map(String) : String(filter.value));
      if (filter.op === 'in') return `${left}=ANY(${value}::${sqlType}[])`;
      const operator = { eq: '=', lt: '<', lte: '<=', gt: '>', gte: '>=' }[filter.op];
      return `${left}${operator}${value}::${sqlType}`;
    });
    return `WHEN o.type=${typeParameter} THEN CASE WHEN o.definition_digest=${fingerprint} AND (${validBody})
      THEN CASE WHEN ${normalized.map(value => `${value.expression} IS NOT NULL`).join(' AND ')}
        THEN (${comparisons.join(' AND ')}) ELSE TRUE END ELSE TRUE END`;
  });
  return `(CASE ${branches.join('\n')} ELSE TRUE END)`;
}
