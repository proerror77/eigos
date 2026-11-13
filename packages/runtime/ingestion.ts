import type { Ontology } from '../ontology/model.js';
import type { ObjectRef } from '../ontology/schema.js';
import { Objects } from './objects.js';

/** Source adapters provide rows. Only this mapping writes source object properties. */
export async function ingest(objects: Objects, model: Ontology, sourceName: string, rows: readonly Record<string, unknown>[]): Promise<ObjectRef[]> {
  const mapping = model.sources.get(sourceName);
  if (!mapping) throw new Error('Datasource mapping is unavailable');
  const type = model.object(mapping.objectType);
  const batch = rows.map(row => {
    const fields = Object.fromEntries(Object.entries(mapping.properties).map(([field, path]) => [field,
      path.split('.').reduce<unknown>((value, key) => value && typeof value === 'object' ? Reflect.get(value, key) : undefined, row)]));
    const ref = { type: type.apiName, id: String(fields[type.primaryKey]) };
    return { ref, properties: fields };
  });
  await objects.ingestBatch(batch,sourceName);
  return batch.map(item => item.ref);
}
