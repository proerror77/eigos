import { DomainError } from '../../core/domain.js';
import { digest } from '../../core/delegation.js';
import { assertDefinitionJson } from '../definition-contracts.js';
import type { OntologyModel } from '../model.js';
import { pipelineMappingSchema, pipelineObservationSchema, type PipelineIntake, type PipelineMapping, type PipelineObservation } from './contracts.js';

const invalid = (message: string): never => { throw new DomainError('INVALID_INPUT', message); };
export function pipelineObjectRef(owner: string, source: string, account: string, type: string, nativeId: string) {
  return { type, id: `pipeline:${digest({ owner, source, account, type, nativeId })}` };
}
function read(value: unknown, path: readonly string[]): unknown {
  for (const field of path) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, field)) return undefined;
    value = (value as Record<string, unknown>)[field];
  }
  return value;
}
function write(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  for (const key of path.slice(0, -1)) {
    target[key] ??= {};
    target = target[key] as Record<string, unknown>;
  }
  target[path.at(-1)!] = structuredClone(value);
}
/** Bounded field conversion only. No expressions, network calls or model decisions. */
export function mapPipelineFields(mapping: PipelineMapping, input: unknown): Record<string, unknown> {
  mapping = pipelineMappingSchema.parse(mapping);
  assertDefinitionJson(input);
  if (Buffer.byteLength(JSON.stringify(input)) > 128000) invalid('Source observation exceeds the mapping limit');
  const output: Record<string, unknown> = {};
  for (const item of mapping.fields) {
    let value = read(input, item.from);
    if (value === undefined) { if (item.optional) continue; invalid(`Missing source field ${item.from.join('.')}`); }
    if (item.values) {
      if (typeof value !== 'string') invalid('A state mapping requires a source string');
      value = Object.hasOwn(item.values, value as string) ? item.values[value as string] : item.unknownValue;
      if (value === undefined) invalid(`Unmapped source value at ${item.from.join('.')}`);
    }
    write(output, item.to, value);
  }
  return output;
}

export function mapPipelineObservation(model: OntologyModel, owner: string, intake: PipelineIntake, mapping: PipelineMapping, raw: PipelineObservation, now: number) {
  assertDefinitionJson(raw);
  const sample = pipelineObservationSchema.parse(raw);
  if (sample.sourceRevision !== intake.source.revision || sample.sourceDigest !== intake.source.digest) invalid('Source contract changed; create and validate a new intake');
  if (intake.environment !== 'live' && sample.evidenceLevel !== 'synthetic' || intake.environment === 'live' && sample.evidenceLevel === 'synthetic') invalid('Observation evidence does not match the intake environment');
  if (Date.parse(sample.observedAt) > now || Date.parse(sample.receivedAt) > now || Date.parse(sample.observedAt) > Date.parse(sample.receivedAt)
    || sample.occurredAt && Date.parse(sample.occurredAt) > Date.parse(sample.observedAt)) invalid('Source observation times are inconsistent');
  const expires = Math.min(Date.parse(sample.observedAt) + mapping.maxAgeMs, sample.expiresAt ? Date.parse(sample.expiresAt) : Infinity);
  if (expires <= now) invalid('Source observation is stale');
  const nativeId = read(sample.payload, mapping.nativeId);
  if (typeof nativeId !== 'string' || !nativeId.trim() || nativeId.length > 500) invalid('A stable source-native identity is required');
  // Identity is source/account/type scoped. Prices, timestamps and source
  // contract revisions do not create a new identity for the same entity.
  const id = pipelineObjectRef(owner, intake.source.id, sample.sourceAccount, mapping.objectType, nativeId as string).id;
  if (model.objectWritePolicy(mapping.objectType) !== 'source' || model.object(mapping.objectType).visibility === 'technical'
    || /^(?:Execution|Registered|Network)/.test(mapping.objectType)
    || ['Authorization', 'SourceReceipt', 'ServiceRequest', 'RequestInstruction', 'RequestConstraint', 'OutcomeAssessment', 'EntityIdentityAssertion', 'TransactionPartyRole'].includes(mapping.objectType)) invalid('Source mapping cannot write managed, identity, authorization or execution records');
  const properties = mapPipelineFields(mapping, sample.payload), primaryKey = model.object(mapping.objectType).primaryKey;
  if (Object.hasOwn(properties, primaryKey)) invalid('Mapping cannot override the source-scoped primary key');
  properties[primaryKey] = id;
  const parsed = model.parseProperties(mapping.objectType, properties);
  return { ref: { type: mapping.objectType, id }, properties: parsed, sample, expiresAt: new Date(expires).toISOString(),
    semanticDigest: digest(parsed), sourceKey: digest({ owner, source: intake.source.id, account: sample.sourceAccount, type: mapping.objectType, nativeId }) };
}
