const earlierEvidence = [
  ['live_readonly', 'provider_mock', 'fixture'],
  ['live', 'provider_mock', 'synthetic'],
];

function legacyEnum(schema: Record<string, unknown>): Record<string, unknown> {
  const values = schema.enum;
  if (!Array.isArray(values) || values.at(-1) !== 'pa_reported') return schema;
  const legacy = earlierEvidence.find(labels =>
    values.length === labels.length + 1 && labels.every((label, index) => values[index] === label));
  return legacy ? { ...schema, enum: legacy } : schema;
}

/** Retain the historical DiDi read bindings after adding PA evidence. */
export function legacySourceEvidence(schema: Record<string, unknown>): Record<string, unknown> {
  const direct = legacyEnum(schema);
  if (direct !== schema) return direct;
  const alternatives = schema.anyOf;
  if (Array.isArray(alternatives)) {
    const earlier = alternatives.map(legacySourceEvidence);
    if (earlier.some((item, index) => item !== alternatives[index])) return { ...schema, anyOf: earlier };
  }
  const properties = schema.properties as Record<string, unknown> | undefined;
  if (!properties) return schema;
  const updated = { ...properties };
  const order = properties.order;
  if (order && typeof order === 'object') updated.order = legacySourceEvidence(order as Record<string, unknown>);
  const evidence = properties.evidence as Record<string, unknown> | undefined;
  if (evidence) {
    updated.evidence = legacyEnum(evidence);
    if (evidence.type === 'array' && evidence.items && typeof evidence.items === 'object') {
      const items = evidence.items as Record<string, unknown>;
      const oldItems = legacyEnum(items);
      if (items !== oldItems) updated.evidence = { ...evidence, items: oldItems };
    }
  }
  return updated.evidence === properties.evidence && updated.order === order ? schema : { ...schema, properties: updated };
}
