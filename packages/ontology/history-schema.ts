import { z } from 'zod';
import { DomainError } from '../core/domain.js';
import { digest } from '../core/delegation.js';
import snapshot from './history/business-v14.json' with { type: 'json' };

export interface HistoricalProperty {
  schema: Record<string, unknown>; required?: boolean; derived?: string; [key: string]: unknown;
}
export interface HistoricalDefinition {
  kind: 'object'; id: string; version: string; primaryKey: string; properties: Record<string, HistoricalProperty>; [key: string]: unknown;
}
export interface HistoricalObject { fingerprint: string; definition: HistoricalDefinition }
export interface HistoricalLink { digest: string; definition: import('./model.js').LinkDefinition }
interface HistoricalSnapshot { model: { id: string; version: string; digest: string }; objects: Record<string, HistoricalObject>; links: Record<string, HistoricalLink> }
export const FROZEN_V14 = snapshot as HistoricalSnapshot;
if (FROZEN_V14.model.id !== 'eigos.business' || FROZEN_V14.model.version !== '14'
  || FROZEN_V14.model.digest !== '8482a64b0e6d058454af37bc8951dd703e152061d8ced023785cbf8b619c0f94') throw new Error('Unexpected frozen ontology predecessor');
for (const [type, value] of Object.entries(FROZEN_V14.objects)) {
  if (value.definition.id !== type || value.definition.kind !== 'object' || digest(value.definition) !== value.fingerprint) throw new Error(`Frozen ontology definition is corrupt: ${type}`);
}
for (const [type, value] of Object.entries(FROZEN_V14.links)) {
  if (value.definition.id !== type || digest(value.definition) !== value.digest) throw new Error(`Frozen ontology link is corrupt: ${type}`);
}

const schemas = new Map<string, z.ZodType>();
/** The actual frozen property schemas, never a current model relabelled as v14.
 * Derived properties were not stored by v14 and are not accepted as old facts. */
export function parseHistoricalProperties(object: HistoricalObject, input: unknown): Record<string, unknown> {
  if (digest(object.definition) !== object.fingerprint) throw new DomainError('CONFLICT', 'Frozen predecessor definition does not match its fingerprint');
  let schema = schemas.get(object.fingerprint);
  if (!schema) {
    const shape = Object.fromEntries(Object.entries(object.definition.properties).filter(([, property]) => !property.derived).map(([name, property]) => {
      const value = z.fromJSONSchema(property.schema as Parameters<typeof z.fromJSONSchema>[0]);
      return [name, property.required ? value : value.optional()];
    }));
    schema = z.strictObject(shape); schemas.set(object.fingerprint, schema);
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new DomainError('CONFLICT', `Recorded facts do not match the pinned predecessor schema for ${object.definition.id}`);
  return parsed.data as Record<string, unknown>;
}

/** Exact named pre-integration definitions reconstructed from immutable v14
 * metadata. Their historical pins are checked by the caller; no new pin is
 * invented when a current schema changes. */
export function integrationPredecessor(type: string, expectedFingerprint: string): HistoricalObject {
  const frozen = FROZEN_V14.objects[type];
  if (!frozen) throw new DomainError('CONFLICT', `Missing frozen predecessor schema for ${type}`);
  const definition = structuredClone(frozen.definition), properties = definition.properties;
  if (type === 'ServiceRequest') delete properties.confirmedInputs;
  else if (type === 'RegisteredCapability') delete properties.constraintEvaluation;
  else if (type === 'RegisteredActionType') properties.effect!.schema.enum = ['read', 'definition_only'];
  else if (type === 'BusinessResult') properties.evidenceLevel!.schema.enum = ['synthetic', 'internal', 'live_readonly', 'live_operation', 'live_fulfillment', 'unknown'];
  else if (type === 'SourceReceipt') properties.evidenceLevel!.schema.enum = ['synthetic', 'user_asserted', 'live_readonly', 'live_operation', 'live_fulfillment'];
  else throw new DomainError('CONFLICT', `No named integration predecessor schema for ${type}`);
  const fingerprint = digest(definition);
  if (fingerprint !== expectedFingerprint) throw new DomainError('CONFLICT', `Frozen integration predecessor for ${type} differs from the committed pin`);
  return { fingerprint, definition };
}
