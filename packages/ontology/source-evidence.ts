const legacy = ['live_readonly', 'provider_mock', 'fixture'];
const extended = [...legacy, 'pa_reported'];

function legacyEnum(schema: Record<string, unknown>): Record<string, unknown> {
  return Array.isArray(schema.enum) && schema.enum.length === extended.length &&
    schema.enum.every((value, index) => value === extended[index]) ? { ...schema, enum: legacy } : schema;
}

/** Project the earlier contract for the one additive PA observation value. */
export function legacySourceEvidence(schema: Record<string, unknown>): Record<string, unknown> {
  const direct = legacyEnum(schema);
  if (direct !== schema) return direct;
  const properties = schema.properties as Record<string, unknown> | undefined;
  if (!properties?.evidence || typeof properties.evidence !== 'object') return schema;
  const evidence = properties.evidence as Record<string, unknown>;
  let previous = legacyEnum(evidence);
  if (evidence.type === 'array' && evidence.items && typeof evidence.items === 'object') {
    const items = evidence.items as Record<string, unknown>;
    const oldItems = legacyEnum(items);
    if (items !== oldItems) previous = { ...evidence, items: oldItems };
  }
  return previous === evidence ? schema : { ...schema, properties: { ...properties, evidence: previous } };
}
