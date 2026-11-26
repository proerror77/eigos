import { Conflict } from '../core/identity.js';
import type { ObjectData } from '../ontology/schema.js';
import type { Access } from './access.js';
import type { PublishedOntology } from './metadata.js';

/** An object as `view` shows it, as Object Set evaluation and aggregation project each member. */
export function projectView(access: Access, model: PublishedOntology, object: ObjectData, view?: string): ObjectData {
  if (!view || view === object.ref.type) return object;
  if (!model.implements(object.ref.type, view)) throw new Conflict('The requested view is incompatible with an object in this set');
  const properties = model.interfaces.get(view)?.properties;
  if (!properties) throw new Conflict('Use an Object Type or Interface view');
  return { ...object, properties: Object.fromEntries(Object.keys(properties).map(name => {
    const local = model.propertyName(object.ref.type, view, name);
    const label = properties[name]?.classification;
    const visible = access.canSeeModelData(label);
    if (visible) access.observeClassification(label);
    return [name, local && visible ? object.properties[local] ?? null : null];
  })) };
}
