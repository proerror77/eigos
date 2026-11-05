import baselineJson from './baseline.json' with { type: 'json' };
import type { OntologyModel } from '../ontology/model.js';
import { projectionFields } from './projections.js';

// Keep the reviewed classification private even though JSON modules are shared.
const baseline = structuredClone(baselineJson) as { types: Record<string,{fingerprint:string;fields:Record<string,string>}> };

/** Classification only: this does not authorize a resource, object or output. */
export function reviewedFieldPolicy(model: OntologyModel, type: string, field: string): string {
  const value=baseline.types[type];
  if (!value || value.fingerprint !== model.fingerprint(type)) return 'internal_only';
  if (Object.hasOwn(projectionFields(type),field)) return 'task_sensitive';
  if (!value.fields[field] || model.properties(type)[field]?.restricted) return 'internal_only';
  return value.fields[field]!;
}
