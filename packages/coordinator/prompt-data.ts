/** Presentation only: neither changes ontology reads nor validates model output. */
export function compactSchema(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(compactSchema);
  if (!input || typeof input !== 'object') return input;
  const node = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, compactSchema(value)]));
  if (!Array.isArray(node.anyOf)) return node;
  const groups = new Map<string, { schema: Record<string, unknown>; names: string[] }>();
  const alternatives: unknown[] = [];
  for (const alternative of node.anyOf) {
    const schema = alternative as Record<string, any>, field = schema?.properties?.function;
    if (schema?.type !== 'object' || typeof field?.const !== 'string') { alternatives.push(alternative); continue; }
    const { const: name, ...constraints } = field;
    const body = { ...schema, properties: { ...schema.properties, function: constraints } };
    const key = JSON.stringify(body), group = groups.get(key);
    if (group) group.names.push(name);
    else groups.set(key, { schema: body, names: [name] });
  }
  for (const { schema, names } of groups.values()) {
    const properties = schema.properties as Record<string, object>;
    alternatives.push({ ...schema, properties: { ...properties, function: { ...properties.function, ...(names.length === 1 ? { const: names[0] } : { enum: names }) } } });
  }
  return { ...node, anyOf: alternatives };
}

const reference = '$contextValue';
export interface PromptDataMetrics { encoding: 'inline-json' | 'shared-json-v1'; sourceBytes: number; encodedBytes: number; sharedValues: number }
/** Store exact repeated JSON values once. No truncation, selection or summarizing. */
export function packPromptData(input: unknown): { value: unknown; metrics: PromptDataMetrics } {
  const source = JSON.stringify(input), sourceBytes = Buffer.byteLength(source);
  const counts = new Map<string, number>();
  let collision = false;
  const count = (value: unknown) => {
    if (value && typeof value === 'object' && Object.hasOwn(value, reference)) collision = true;
    if (typeof value === 'string' || value && typeof value === 'object') {
      const text = JSON.stringify(value);
      if (Buffer.byteLength(text) >= 240) counts.set(text, (counts.get(text) ?? 0) + 1);
    }
    if (Array.isArray(value)) value.forEach(count);
    else if (value && typeof value === 'object') Object.values(value).forEach(count);
  };
  count(input);
  const inline = { value: input, metrics: { encoding: 'inline-json' as const, sourceBytes, encodedBytes: sourceBytes, sharedValues: 0 } };
  // Source-owned objects cannot masquerade as an encoding reference.
  if (collision) return inline;
  const values: unknown[] = [], indices = new Map<string, number>();
  const children = (value: unknown): unknown => Array.isArray(value) ? value.map(encode) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, encode(child)])) : value;
  const encode = (value: unknown): unknown => {
    const text = JSON.stringify(value);
    if ((counts.get(text) ?? 0) < 2) return children(value);
    let index = indices.get(text);
    if (index === undefined) { index = values.length; indices.set(text, index); values.push(null); values[index] = children(value); }
    return { [reference]: index };
  };
  const data = encode(input), value = { encoding: 'shared-json-v1', sharedValues: values, data };
  const encodedBytes = Buffer.byteLength(JSON.stringify(value));
  if (!values.length || encodedBytes >= sourceBytes * 0.9) return inline;
  return { value, metrics: { encoding: 'shared-json-v1', sourceBytes, encodedBytes, sharedValues: values.length } };
}

/** Also used by evidence readers to inspect the exact logical prompt data. */
export function expandPromptData(value: any): any {
  if (value?.encoding !== 'shared-json-v1') return value;
  const expand = (item: any): any => {
    if (item && typeof item === 'object' && Object.hasOwn(item, reference)) return expand(value.sharedValues[item[reference]]);
    if (Array.isArray(item)) return item.map(expand);
    return item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([key, child]) => [key, expand(child)])) : item;
  };
  return expand(value.data);
}
