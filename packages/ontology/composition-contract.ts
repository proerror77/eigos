import { z } from 'zod';
import { DomainError } from '../core/domain.js';
import { digest } from '../core/delegation.js';
import type { ActionDefinition, ObjectRef, OntologyModel } from './model.js';
import type { HandlerRef, JsonSchema, OntologyReleaseRef } from './definition-contracts.js';
import type { EffectClass } from './actions.js';

const name = z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,79}$/).refine(value => !['constructor', 'prototype', '__proto__'].includes(value));
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const handler = z.strictObject({ id: z.string().min(1).max(240), version: z.string().min(1).max(100), digest: sha });
const jsonSchema = z.record(z.string(), z.unknown());
const effects = z.array(z.enum(['local', 'read', 'object_write', 'reserve', 'order', 'payment', 'change', 'cancel', 'refund', 'external_draft'])).min(1).max(10);
export const evidenceOriginSchema = z.enum(['provider', 'synthetic', 'managed', 'model', 'user']);
export type EvidenceOrigin = z.infer<typeof evidenceOriginSchema>;
const semanticsSchema = z.strictObject({
  role: z.string().min(1).max(100),
  phase: z.enum(['request', 'fact', 'quote', 'commitment', 'payment', 'delivery', 'artifact']),
  unit: z.string().min(1).max(80).optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  locationRole: z.string().min(1).max(80).optional(), timeZone: z.string().min(1).max(100).optional(),
});
const evidenceSchema = z.strictObject({
  origins: z.array(evidenceOriginSchema).min(1).max(5),
  maxAgeMs: z.number().int().positive().max(365 * 86400000).optional(),
});
const commonPort = {
  cardinality: z.enum(['one', 'many']), semantics: semanticsSchema, evidence: evidenceSchema, optional: z.boolean().optional(),
};
export const compositionPortSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...commonPort, kind: z.literal('object'), type: name }),
  z.strictObject({ ...commonPort, kind: z.literal('value'), schema: jsonSchema }),
]);
export type CompositionPort = z.infer<typeof compositionPortSchema>;
const ports = z.record(name, compositionPortSchema).refine(value => Object.keys(value).length <= 64, 'Too many composition ports');
const actionRef = z.strictObject({ id: name, version: z.string().min(1).max(100) });
export const compositionContractSchema = z.strictObject({
  version: z.literal('1'), inputs: ports, outputs: ports,
  checks: z.array(z.strictObject({
    id: name, phase: z.enum(['before', 'after']), validatorRef: handler, schema: jsonSchema,
    arguments: z.record(name, z.strictObject({ from: z.enum(['input', 'output']), port: name })),
  })).max(32),
  effectScope: z.strictObject({
    effects, targetInputs: z.array(name).max(64),
    recovery: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('none') }), z.strictObject({ kind: z.literal('read_original'), action: actionRef }),
      z.strictObject({ kind: z.literal('original_intent'), version: z.literal('1'), effect: z.literal('read') })]),
    compensation: z.array(actionRef).max(8),
  }),
});
export type ActionCompositionContract = z.infer<typeof compositionContractSchema>;
export function compositionSummary(contract: ActionCompositionContract) {
  return { version: contract.version, digest: digest(contract), inputs: Object.keys(contract.inputs), outputs: Object.keys(contract.outputs),
    checkCount: contract.checks.length, detail: 'discover_actions_or_exact_action_description' as const };
}

function fail(message: string): never { throw new DomainError('INVALID_INPUT', message); }
export function actionEffects(action: ActionDefinition): EffectClass[] {
  return action.effects ?? (action.read ? ['read'] : action.operation ? [action.operation.effect, ...(action.operation.additionalEffects ?? [])] : []);
}
export function actionVersion(action: ActionDefinition): string | undefined { return action.operation?.version ?? action.read?.version ?? action.version; }
const sorted = (values: string[]) => [...new Set(values)].sort();
export interface CompositionCompiler {
  schema(schema: JsonSchema): z.ZodType;
  validator(ref: HandlerRef, schema: JsonSchema): z.ZodType;
}
const compiledContracts = new WeakMap<OntologyModel, CompositionCompiler>();
/** Installed by the trusted compiler, not read from a published document. */
export function bindCompositionCompiler(model: OntologyModel, compiler: CompositionCompiler): void { compiledContracts.set(model, compiler); }
export function compositionCompiler(model: OntologyModel): CompositionCompiler {
  return compiledContracts.get(model) ?? fail('Composition validators were not compiled for this ontology release');
}

/** A published contract is checked independently of the existence of a provider binding. */
export function validateCompositionContract(model: OntologyModel, action: ActionDefinition, compiler: CompositionCompiler): void {
  if (!action.composition) return;
  const parsed = compositionContractSchema.safeParse(action.composition);
  if (!parsed.success) fail(`Invalid composition contract for ${action.id}`);
  const contract = parsed.data;
  if (action.operation?.environment === 'local' && actionEffects(action).some(effect => effect !== 'local')) fail('Local operation contracts cannot contain external or managed write effects');
  if (!actionVersion(action)) fail('Composable actions require an explicit version');
  const input = action.inputSchema ?? action.read?.inputSchema ?? action.operation?.inputSchema;
  const properties = (input as { type?: string; properties?: Record<string, JsonSchema> } | undefined)?.properties;
  if (!properties) fail('Composable actions require an explicit object input schema');
  for (const [id, port] of Object.entries(contract.inputs)) {
    if (!Object.hasOwn(properties, id)) fail(`Composition input is not a declared argument: ${id}`);
    const parameter = properties[id]!;
    const item = port.cardinality === 'many' ? parameter.items as JsonSchema | undefined : parameter;
    if (!item || port.cardinality === 'many' && (parameter.type !== 'array' || typeof parameter.maxItems !== 'number' || parameter.maxItems > 200)) fail('Composition collection inputs require a bounded array schema');
    if (port.kind === 'value' && digest(item) !== digest(port.schema)) fail('Composition value port disagrees with its argument schema');
    if (port.kind === 'object') {
      const ref = item as { type?: string; properties?: Record<string, JsonSchema>; required?: string[] };
      if (ref.type !== 'object' || !ref.properties || !['id', 'type'].every(key => ref.properties![key]?.type === 'string' && ref.required?.includes(key))) fail('Composition object ports require an object-reference argument schema');
      const type = ref.properties.type!;
      if (typeof type.const === 'string' && !model.assignableType(type.const, port.type)
        || Array.isArray(type.enum) && type.enum.some(value => typeof value !== 'string' || !model.assignableType(value, port.type))) fail('Composition object-reference schema disagrees with its ontology type');
    }
    if (port.kind === 'object' && (!action.inputs[id] || !model.assignableType(port.type, action.inputs[id]!))) fail('Composition object input disagrees with its declared ontology type');
  }
  for (const [id, type] of Object.entries(action.inputs)) {
    const port = contract.inputs[id];
    if (!port || port.kind !== 'object' || !model.assignableType(type, port.type)) fail('All ontology object inputs need an exact composition port');
  }
  for (const port of [...Object.values(contract.inputs), ...Object.values(contract.outputs)]) {
    if (port.kind === 'object') { if (!model.hasType(port.type)) fail('Unknown composition port type'); }
    else compiler.schema(port.schema);
    if (new Set(port.evidence.origins).size !== port.evidence.origins.length) fail('Duplicate evidence origins');
    if (port.semantics.timeZone) {
      try { new Intl.DateTimeFormat('en', { timeZone: port.semantics.timeZone }); } catch { fail('Invalid port time zone'); }
    }
  }
  if (!Object.keys(contract.outputs).length) fail('Composable actions require an observable output');
  const declaredResults = action.resultTypes ?? (action.read ? [action.read.resultType] : action.operation ? [action.operation.resultType] : []);
  for (const port of Object.values(contract.outputs)) if (port.kind === 'object' && !declaredResults.some(type => model.assignableType(port.type, type))) fail('Composition output is outside the declared action result types');
  if (digest(sorted(contract.effectScope.effects)) !== digest(sorted(actionEffects(action))) || new Set(contract.effectScope.effects).size !== contract.effectScope.effects.length) fail('Composition effect scope disagrees with the action effects');
  if (new Set(contract.effectScope.targetInputs).size !== contract.effectScope.targetInputs.length || contract.effectScope.targetInputs.some(id => contract.inputs[id]?.kind !== 'object')) fail('Effect targets require distinct declared object inputs');
  const referencedAction = (ref: { id: string; version: string }) => {
    const target = model.action(ref.id);
    if (actionVersion(target) !== ref.version) fail('Composition recovery or compensation action version is unavailable');
    return target;
  };
  if (contract.effectScope.recovery.kind === 'read_original' && digest(actionEffects(referencedAction(contract.effectScope.recovery.action))) !== digest(['read'])) fail('Unknown outcomes must be reconciled with a read-only action');
  const writes = contract.effectScope.effects.some(effect => !['local', 'read', 'object_write'].includes(effect));
  if (writes && contract.effectScope.recovery.kind === 'none') fail('External business writes require an original-operation recovery contract');
  if (contract.effectScope.recovery.kind === 'original_intent' && model.actionImplementation(action.id)?.kind !== 'trusted') fail('Original-intent recovery requires an exact trusted action implementation');
  for (const ref of contract.effectScope.compensation) if (!actionEffects(referencedAction(ref)).every(effect => ['cancel', 'refund', 'object_write'].includes(effect))) fail('Compensation requires an explicitly scoped corrective action');
  if (new Set(contract.checks.map(check => check.id)).size !== contract.checks.length) fail('Duplicate composition check');
  for (const check of contract.checks) {
    compiler.validator(check.validatorRef, check.schema);
    const parameters = (check.schema as { type?: string; properties?: Record<string, unknown>; required?: string[] });
    if (parameters.type !== 'object' || !parameters.properties || digest(sorted(Object.keys(parameters.properties))) !== digest(sorted(Object.keys(check.arguments))) || digest(sorted(parameters.required ?? [])) !== digest(sorted(Object.keys(check.arguments)))) fail('Composition checks require an exact named argument schema');
    for (const ref of Object.values(check.arguments)) {
      if (check.phase === 'before' && ref.from === 'output') fail('Preconditions cannot depend on unobserved output');
      if (!Object.hasOwn(ref.from === 'input' ? contract.inputs : contract.outputs, ref.port)) fail('Composition check references an unknown port');
    }
  }
}

/** Static compatibility is conservative. Conversion needs a separate registered action. */
export function assertPortCompatible(model: OntologyModel, producer: CompositionPort, consumer: CompositionPort): void {
  if (producer.cardinality !== consumer.cardinality || producer.kind !== consumer.kind) fail('Composition cardinality or value kind differs');
  if (digest(producer.semantics) !== digest(consumer.semantics)) fail('Composition role, unit, currency, location, time or result phase differs');
  if (producer.kind === 'object' && consumer.kind === 'object' && !model.assignableType(producer.type, consumer.type)) fail('Composition object type is incompatible');
  if (producer.kind === 'value' && consumer.kind === 'value' && digest(producer.schema) !== digest(consumer.schema)) fail('Composition value schemas differ; use a registered conversion action');
  if (!producer.evidence.origins.some(origin => consumer.evidence.origins.includes(origin))) fail('Composition has no acceptable evidence origin');
}

/** Constructed only from an accepted action observation, never from model-supplied JSON. */
export interface AcceptedPortValue {
  version: '1'; owner: string; requestId: string; requestRevision: number; ontologyRelease: OntologyReleaseRef;
  actionId: string; actionVersion: string; binding: { id: string; version: string; configurationDigest: string };
  intentId: string; observationId: string; port: string; definition: CompositionPort; value: unknown;
  evidence: { origin: EvidenceOrigin; refs: string[]; observedAt: string; expiresAt?: string };
  objects: { ref: ObjectRef; revision: number; digest: string }[];
  digest: string;
}
export function sealPortValue(value: Omit<AcceptedPortValue, 'digest'>): AcceptedPortValue {
  return structuredClone({ ...value, digest: digest(value) });
}
export interface PortReadContext {
  owner: string; requestId: string; requestRevision: number; ontologyRelease: OntologyReleaseRef; now: number;
  /** Receipt must be loaded from durable confirmed intent state, including its accepted observation. */
  isAccepted(value: AcceptedPortValue): boolean;
  readObject(ref: ObjectRef): { revision: number; digest: string };
  schema(schema: JsonSchema): z.ZodType;
}
export function readAcceptedPort(model: OntologyModel, value: AcceptedPortValue, consumer: CompositionPort, context: PortReadContext): unknown {
  const { digest: receiptDigest, ...receipt } = value;
  if (receiptDigest !== digest(receipt) || !context.isAccepted(value)) fail('Composition needs the original accepted action observation');
  if (value.owner !== context.owner || value.requestId !== context.requestId || value.requestRevision !== context.requestRevision || digest(value.ontologyRelease) !== digest(context.ontologyRelease)) fail('Composition evidence belongs to another owner, task, request revision or ontology release');
  assertPortCompatible(model, value.definition, consumer);
  if (!value.evidence.refs.length || !value.observationId) fail('Composition output has no source evidence');
  if (!value.definition.evidence.origins.includes(value.evidence.origin) || !consumer.evidence.origins.includes(value.evidence.origin)) fail('Composition evidence origin is not accepted');
  const observedAt = Date.parse(value.evidence.observedAt), expiresAt = value.evidence.expiresAt ? Date.parse(value.evidence.expiresAt) : undefined;
  if (!Number.isFinite(observedAt) || observedAt > context.now || expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= context.now)
    || [value.definition.evidence.maxAgeMs, consumer.evidence.maxAgeMs].some(age => age !== undefined && context.now - observedAt > age)) fail('Composition evidence is stale or has an invalid observation time');
  const items = consumer.cardinality === 'many' ? value.value : [value.value];
  if (!Array.isArray(items) || items.length > 200) fail('Invalid composition output cardinality');
  for (const item of items) {
    if (consumer.kind === 'value') { context.schema(consumer.schema).parse(item); continue; }
    const ref = z.strictObject({ type: name, id: z.string().min(1).max(200) }).parse(item);
    if (!model.implements(ref.type, consumer.type)) fail('Composition output object has a different type');
    const snapshot = value.objects.find(object => digest(object.ref) === digest(ref));
    if (!snapshot || digest(context.readObject(ref)) !== digest({ revision: snapshot.revision, digest: snapshot.digest })) fail('Composition object changed since its accepted observation');
  }
  return structuredClone(value.value);
}

export function evaluateCompositionChecks(contract: ActionCompositionContract, phase: 'before' | 'after', inputs: Record<string, unknown>, outputs: Record<string, unknown>, compiler: CompositionCompiler): void {
  for (const check of contract.checks.filter(check => check.phase === phase)) {
    const argumentsValue: Record<string, unknown> = {};
    for (const [key, ref] of Object.entries(check.arguments)) {
      const values = ref.from === 'input' ? inputs : outputs;
      if (!Object.hasOwn(values, ref.port)) fail(`Composition check ${check.id} has missing evidence`);
      argumentsValue[key] = values[ref.port];
    }
    const result = compiler.validator(check.validatorRef, check.schema).safeParse(argumentsValue);
    if (!result.success) fail(`Composition ${phase} check failed: ${check.id}`);
  }
}
