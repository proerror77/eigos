import { mcpReadBindingSchema, type McpReadBinding } from './mcp-read.js';
import { z } from 'zod';
import { paClassificationSchema, paDiscoveryFields, paDiscoverySelection, paDefinitionLinks, type PaClassification, type PaDiscoveryInput } from './pa-classification-contract.js';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import type { ActionImplementation } from './action-dsl.js';
import { assertPortCompatible, type CompositionPort } from './composition-contract.js';
import type { FunctionExecutionContract } from './function-contracts.js';
import type { ActionCriterionBinding } from './action-criteria.js';

export const nameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,79}$/).refine(v => !['constructor', 'prototype', '__proto__'].includes(v));
export const objectRefSchema = z.object({ type: nameSchema, id: z.string().min(1).max(200) }).strict();
export type ObjectRef = z.infer<typeof objectRefSchema>;
export type ScalarKind = 'string' | 'integer' | 'boolean' | 'timestamp' | 'decimal' | 'struct' | 'array';
export const linkSearchSchema = z.string().trim().min(1).max(100).optional().describe('Filter relationships by a substring of their visible names, target API IDs or descriptions. A filtered list does not prove that other relationships or data are absent.');
/** Filter only metadata already selected by the caller's authorization layer. */
export function filterRelationshipMetadata<T extends object>(definition: T, search?: string): T {
  if (!search) return definition;
  const result = { ...definition } as Record<string, unknown>, needle = search.toLowerCase();
  for (const key of ['links', 'linkConstraints']) if (Array.isArray(result[key])) {
    result[key] = (result[key] as Record<string, unknown>[]).filter(link => [link.id, link.name, link.target, link.description].filter(value => typeof value === 'string').join(' ').toLowerCase().includes(needle));
    result.linksFiltered = true;
  }
  return result as T;
}
export interface PropertyDefinition {
  description: string;
  kind: ScalarKind;
  schema: z.ZodType;
  /** Trusted compiler-only metadata pin; validation still uses schema. Never accepted from definition JSON. */
  schemaMetadata?: Record<string, unknown>;
  source: string;
  required?: boolean;
  restricted?: boolean;
  derived?: string;
  /** Field write authority is independent from its human-readable source label. */
  authority?: 'managed' | 'source';
  /** Compiler evidence: an added source field has no registered source mapping. */
  sourceBinding?: 'unbound';
}
export interface InterfaceActionConstraint {
  id: string; inputs: Record<string, string>; effects: import('./actions.js').EffectClass[]; resultTypes?: string[]; optional?: boolean;
  ports?: { inputs: Record<string, CompositionPort>; outputs: Record<string, CompositionPort> };
}
export interface InterfaceActionMapping { actionId: string; inputMap: Record<string, string>; outputMap?: Record<string, string> }
export interface InterfaceDefinition {
  id: string;
  description: string;
  parents?: string[];
  properties: Record<string, PropertyDefinition>;
  /** Opt-in validation contract; historical interfaces retain exact metadata matching. */
  propertyCompatibility?: 'structural_v1';
  /** Read-only view contracts do not change the stored object's validation shape. */
  projectionOnly?: boolean;
  /** A capability may be absent from an implementing type; required still governs stored values. */
  optionalProperties?: string[];
  links?: { name: string; target: string; many: boolean; optional?: boolean; description?: string }[];
  actions?: InterfaceActionConstraint[];
  /** Foundry interface metadata: lifecycle signal and collection-query opt-in. */
  status?: 'active' | 'experimental' | 'example' | 'deprecated';
  searchable?: boolean;
}
export interface ObjectTypeDefinition {
  id: string;
  version: string;
  name: string;
  aliases: string[];
  description: string;
  primaryKey: string;
  /** Versioned discovery explanation; does not change the stored data contract. */
  businessDescription?: string;
  /** Versioned PA discovery metadata; never field authority or a writer contract. */
  classification?: PaClassification;
  titleKey: string;
  properties: Record<string, PropertyDefinition>;
  interfaces?: { id: string; propertyMap?: Record<string, string>; linkMap?: Record<string, string>; actionMap?: Record<string, InterfaceActionMapping> }[];
  /** Discovery presentation only; never an object permission or data-schema change. */
  visibility?: 'business' | 'technical';
  /** Missing policy means source-authoritative, preserving pre-registry contracts. */
  writePolicy?: 'managed' | 'source';
}
export interface LinkDefinition {
  id: string;
  description: string;
  /** Attributes carried by the relationship itself, not by either endpoint. */
  properties?: Record<string, PropertyDefinition>;
  from: { type: string; name: string; many: boolean; required?: boolean };
  to: { type: string; name: string; many: boolean; required?: boolean };
  writePolicy?: 'managed' | 'source';
}
export interface ActionDefinition {
  id: string;
  version?: string;
  /** True when the effect changes something outside this process and an owner must decide first. */
  requiresApproval?: boolean;
  kind?: 'decision' | 'source_read' | 'business';
  effects?: import('./actions.js').EffectClass[];
  resultTypes?: string[];
  description: string;
  inputs: Record<string, string>;
  changes: string[];
  submissionCriteria: string[];
  criteriaBindings?: Record<string, ActionCriterionBinding>;
  providerOperation?: string;
  // A definition is not an executable grant. A configured AgentProgram must bind
  // it, validate its schema and scope, and enforce read-only dispatch separately.
  read?: { version: string; effect: 'read'; inputSchema: object; resultType: string; mcp?: McpReadBinding; module?: { id: string; version: string; digest: string; completion: { evaluate: string; planned?: boolean; afterAuthorizedOperation?: boolean } } };
  operation?: { version: string; effect: Exclude<import('./actions.js').EffectClass, 'read'>; additionalEffects?: import('./actions.js').EffectClass[]; environment: 'sandbox' | 'local' | 'live_free' | 'live'; inputSchema: object; resultType: string };
  inputSchema?: Record<string, unknown>;
  implementation?: ActionImplementation;
  composition?: import('./composition-contract.js').ActionCompositionContract;
}
export interface FunctionDefinition { id: string; version: string; inputTypes: string[]; description: string; returns?: string[]; executionContract?: FunctionExecutionContract }
export interface ModelDefinition { id: string; version: string; objects: ObjectTypeDefinition[]; interfaces: InterfaceDefinition[]; links: LinkDefinition[]; actions: ActionDefinition[]; functions: FunctionDefinition[]; criteriaVersion?: string; effectCoverage?: { derived: number; kept: number; undeclared: string[] } }
function invalid(message: string): never { throw new DomainError('INVALID_INPUT', message); }
/** Effects that change state a person is accountable for. */
const APPROVAL_EFFECTS = new Set(['change', 'object_write', 'reserve', 'order', 'payment', 'cancel', 'refund', 'external_draft']);
/** Freeze public metadata only. Zod owns mutable parser caches and is deliberately excluded. */
function freezeMetadata<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeMetadata(child);
    Object.freeze(value);
  }
  return value;
}
function immutableProperties(properties: Record<string, PropertyDefinition>): Record<string, PropertyDefinition> {
  return Object.freeze(Object.fromEntries(Object.entries(properties).map(([name, property]) => {
    const { schema, ...metadata } = property;
    return [name, Object.freeze({ ...freezeMetadata(structuredClone(metadata)), schema })];
  })));
}
const propertyMetadata = (p: PropertyDefinition) => ({ description: p.description, kind: p.kind, source: p.source, required: !!p.required, restricted: !!p.restricted, derived: p.derived, schema: p.schemaMetadata ?? z.toJSONSchema(p.schema), ...(p.authority ? { authority: p.authority } : {}), ...(p.sourceBinding ? { sourceBinding: p.sourceBinding } : {}) });
const propertyContract = (p: PropertyDefinition) => { const { sourceBinding: _sourceBinding, ...metadata } = propertyMetadata(p); return metadata; };
function validationSchema(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([name]) => !['description', 'title', '$schema', 'examples'].includes(name)).map(([name, child]) => {
    if (['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'].includes(name) && child && typeof child === 'object' && !Array.isArray(child)) {
      return [name, Object.fromEntries(Object.entries(child).map(([field, schema]) => [field, validationSchema(schema)]))];
    }
    if (['anyOf', 'oneOf', 'allOf', 'prefixItems'].includes(name) && Array.isArray(child)) return [name, child.map(validationSchema)];
    if (['items', 'additionalProperties', 'unevaluatedProperties', 'contains', 'not', 'if', 'then', 'else', 'propertyNames'].includes(name)) return [name, validationSchema(child)];
    return [name, child];
  }));
}
/** Metadata is not a validation constraint. Finite schemas can safely narrow an
 * interface; other schemas must retain the same reviewed validation shape. */
function structurallyCompatible(actual: PropertyDefinition, expected: PropertyDefinition): boolean {
  const a = propertyMetadata(actual).schema, b = propertyMetadata(expected).schema;
  const timestampView = actual.kind === 'string' && expected.kind === 'timestamp' && a.format === 'date-time';
  if (actual.kind !== expected.kind && !timestampView || !!actual.restricted !== !!expected.restricted || actual.authority !== expected.authority
    || actual.derived !== expected.derived || expected.required && !actual.required) return false;
  if (digest(validationSchema(a)) === digest(validationSchema(b))) return true;
  const finite = Object.hasOwn(a, 'const') ? [a.const] : Array.isArray(a.enum) ? a.enum : undefined;
  if (finite?.length) return finite.every(value => expected.schema.safeParse(value).success);
  const x = validationSchema(a) as Record<string, unknown>, y = validationSchema(b) as Record<string, unknown>;
  const scalar = new Set(['type', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'pattern', 'format', 'multipleOf']);
  if (x.type !== y.type || !['string', 'integer', 'number', 'boolean'].includes(String(x.type)) || [...Object.keys(x), ...Object.keys(y)].some(key => !scalar.has(key))) return false;
  for (const key of ['minLength', 'minimum', 'exclusiveMinimum']) if (y[key] !== undefined && (typeof x[key] !== 'number' || Number(x[key]) < Number(y[key]))) return false;
  for (const key of ['maxLength', 'maximum', 'exclusiveMaximum']) if (y[key] !== undefined && (typeof x[key] !== 'number' || Number(x[key]) > Number(y[key]))) return false;
  const integerAmount = actual.kind === 'decimal' && x.pattern === '^(0|[1-9]\\d{0,17})$' && y.pattern === '^(0|[1-9]\\d{0,17})(\\.\\d{1,6})?$';
  return ['pattern', 'format', 'multipleOf'].every(key => y[key] === undefined || x[key] === y[key] || key === 'pattern' && integerAmount);
}
export interface OntologyModelOptions {
  trustedActionImplementations?: Record<string, ActionImplementation>;
  trustedFunctionImplementations?: Record<string, { id: string; version: string; digest: string }>;
}
export type ActionBindingStatus =
  | { state: 'unbound'; executable: false }
  | { state: 'declarative_supported'; version: '1'; authorizationRequired: true }
  | { state: 'trusted_contract_available'; handlerRef: { id: string; version: string; digest: string }; runtimeBindingRequired: true; authorizationRequired: true };

/** Compiles trusted definitions once. No executable expressions or provider URLs are accepted. */
export class OntologyModel {
  readonly ref: { id: string; version: string; digest: string };
  readonly criteriaVersion?: string;
  private objects = new Map<string, ObjectTypeDefinition>();
  private interfaces = new Map<string, InterfaceDefinition>();
  private schemas = new Map<string, z.ZodType>();
  private fingerprints = new Map<string, string>();
  private links: LinkDefinition[];
  private linkSides = new Map<string, { link: LinkDefinition; side: LinkDefinition['from']; other: LinkDefinition['to']; direction: 'forward' | 'reverse' }[]>();
  // Interface conformance is a pure function of the compiled definition, and it is
  // asked O(links x types) times while building link sides and property maps.
  private implementCache = new Map<string, boolean>();
  private ancestorCache = new Map<string, string[]>();
  private typeDescriptions = new Map<string, object>();
  private actions: ActionDefinition[];
  private functions: FunctionDefinition[];
  constructor(definition: ModelDefinition, private options: OntologyModelOptions = {}) {
    this.criteriaVersion = definition.criteriaVersion;
    Object.defineProperty(this, 'criteriaVersion', { writable: false, configurable: false });
    this.options = freezeMetadata(structuredClone(options));
    for (const item of definition.interfaces) {
      nameSchema.parse(item.id);
      if (this.interfaces.has(item.id)) invalid('Duplicate interface');
      const { properties, ...metadata } = item;
      this.interfaces.set(item.id, Object.freeze({ ...freezeMetadata(structuredClone(metadata)), parents: freezeMetadata([...(item.parents ?? [])]), links: freezeMetadata(structuredClone(item.links ?? [])), properties: immutableProperties(properties) }));
    }
    for (const item of definition.objects) {
      nameSchema.parse(item.id);
      if (this.objects.has(item.id) || this.interfaces.has(item.id)) invalid('Duplicate ontology type');
      if (new Set(item.interfaces?.map(value => value.id)).size !== (item.interfaces?.length ?? 0)) invalid('Duplicate interface implementation');
      for (const [name, p] of Object.entries(item.properties)) {
        nameSchema.parse(name);
        if (!p.description || !p.source || p.required && p.derived) invalid('Incomplete property semantics');
      }
      for (const key of [item.primaryKey, item.titleKey]) {
        const property = item.properties[key];
        if (property?.kind !== 'string' || !property.required || property.restricted || property.derived || [null, 1, ''].some(value => property.schema.safeParse(value).success)) invalid('Keys must be required visible strings');
      }
      const { properties, ...metadata } = item;
      this.objects.set(item.id, Object.freeze({ ...freezeMetadata(structuredClone(metadata)), interfaces: freezeMetadata(structuredClone(item.interfaces ?? [])), properties: immutableProperties(properties) }));
      const shape = Object.fromEntries(Object.entries(item.properties).filter(([, p]) => !p.derived).map(([k, p]) => [k, p.required ? p.schema : p.schema.optional()]));
      this.schemas.set(item.id, z.object(shape).strict());
    }
    for (const id of this.interfaces.keys()) {
      const properties = this.interfaceProperties(id);
      const optional = this.interfaceOptionalProperties(id);
      if (optional.some(name => !Object.hasOwn(properties, name))) invalid('Unknown optional interface property');
      for (const constraint of this.interfaceLinks(id)) if (!nameSchema.safeParse(constraint.name).success || !this.hasType(constraint.target)) invalid('Invalid or unresolved interface link constraint');
      if (this.interfaces.get(id)!.projectionOnly && this.interfaceActions(id).length) invalid('Projection-only interfaces cannot introduce action constraints');
    }
    this.functions = freezeMetadata(structuredClone(definition.functions));
    if (new Set(this.functions.map(f => f.id)).size !== this.functions.length) invalid('Duplicate function');
    for (const f of this.functions) {
      nameSchema.parse(f.id);
      if (!f.version || !f.description || !f.inputTypes.length || f.inputTypes.some(t => !this.hasType(t))) invalid('Invalid function definition');
    }
    for (const o of this.objects.values()) for (const p of Object.values(o.properties)) {
      if (p.derived && !this.functions.some(f => f.id === p.derived && f.inputTypes.some(t => this.implements(o.id, t)))) invalid('Unresolved derived function');
    }
    for (const item of definition.objects) for (const implementation of item.interfaces ?? []) {
      const expected = this.interfaceProperties(implementation.id);
      for (const [alias, p] of Object.entries(expected)) {
        const actual = item.properties[this.propertyName(item.id, implementation.id, alias)];
        if (!actual && this.interfaceOptionalProperties(implementation.id).includes(alias) && !Object.hasOwn(implementation.propertyMap ?? {}, alias)) continue;
        if (!actual || (this.structuralInterface(implementation.id) ? !structurallyCompatible(actual, p) : digest(propertyContract(actual)) !== digest(propertyContract(p)))) invalid(`Incompatible interface property: ${item.id}.${alias}`);
      }
      if (Object.keys(implementation.propertyMap ?? {}).some(k => !Object.hasOwn(expected, k))) invalid('Unknown interface property mapping');
    }
    this.links = freezeMetadata(structuredClone(definition.links));
    if (new Set(this.links.map(l => l.id)).size !== this.links.length) invalid('Duplicate link');
    for (const link of this.links) for (const side of [link.from, link.to]) {
      nameSchema.parse(link.id); nameSchema.parse(side.name);
      if (!this.hasType(side.type)) invalid('Unresolved link endpoint');
    }
    for (const item of definition.objects) {
      if (item.classification) paClassificationSchema.parse(item.classification);
      const sides = this.sides(item.id);
      const storedInterfaces = (item.interfaces ?? []).filter(value => !this.interfaces.get(value.id)?.projectionOnly);
      const storedType = (type: string) => type === item.id || storedInterfaces.some(value => value.id === type || this.interfaceAncestors(value.id).includes(type));
      if (sides.some(side => side.side.required && !storedType(side.side.type))) invalid('Projection-only interfaces cannot introduce required stored relationships');
      if (new Set(sides.map(s => s.side.name)).size !== sides.length) invalid(`Ambiguous link name on ${item.id}`);
      for (const implementation of item.interfaces ?? []) for (const constraint of this.interfaceLinks(implementation.id)) {
        const actualName = this.linkName(item.id, implementation.id, constraint.name), found = sides.find(s => s.side.name === actualName);
        if (!found && constraint.optional && !Object.hasOwn(implementation.linkMap ?? {}, constraint.name)) continue;
        if (!found || !this.assignableType(found.other.type, constraint.target) || found.side.many !== constraint.many) invalid(`Unresolved interface link on ${item.id}`);
      }
      for (const implementation of item.interfaces ?? []) if (Object.entries(implementation.linkMap ?? {}).some(([alias, actual]) => !this.interfaceLinks(implementation.id).some(link => link.name === alias) || !nameSchema.safeParse(actual).success)) invalid('Unknown interface relationship mapping');
      const { links: _links, visibility: _visibility, classification: _classification, ...objectDefinition } = this.describeType(item.id) as Record<string, unknown>;
      // Editorial explanations enter the release/model digest through describeType,
      // while existing facts retain their original, reviewed writer fingerprint.
      objectDefinition.description = item.description;
      // Read views expose existing fields and relationships without relabelling
      // their historical writer. Their mappings still enter the model digest.
      objectDefinition.interfaces = storedInterfaces;
      // Links pin their own definitions. Adding a relationship need not rewrite object data.
      this.fingerprints.set(item.id, digest(objectDefinition));
    }
    this.actions = freezeMetadata(structuredClone(definition.actions));
    if (new Set(this.actions.map(a => a.id)).size !== this.actions.length) invalid('Duplicate action');
    const operations = this.actions.flatMap(a => a.providerOperation ? [a.providerOperation] : []);
    if (new Set(operations).size !== operations.length || this.actions.some(a => a.providerOperation && this.actions.some(other => other !== a && other.id === a.providerOperation))) invalid('Ambiguous action operation binding');
    for (const a of this.actions) {
      nameSchema.parse(a.id);
      if (a.version !== undefined && !a.version.trim()) invalid('Invalid action version');
      if (a.effects && (!a.effects.length || a.effects.some(effect => !['local', 'read', 'object_write', 'reserve', 'order', 'payment', 'change', 'cancel', 'refund', 'external_draft'].includes(effect)))) invalid('Invalid declared action effects');
      if (a.resultTypes?.some(type => !this.hasType(type))) invalid('Unknown declared action result type');
      if (a.read && (a.kind && a.kind !== 'source_read' || a.effects && (a.effects.length !== 1 || a.effects[0] !== 'read') || a.resultTypes && !a.resultTypes.includes(a.read.resultType))) invalid('Read action contract conflicts with its declared semantics');
      if (!a.changes.length || !a.submissionCriteria.length || Object.values(a.inputs).some(t => !this.hasType(t))) invalid('Invalid action definition');
      if (a.read && (a.read.effect !== 'read' || !a.read.version || !this.objects.has(a.read.resultType) || !a.read.inputSchema || typeof a.read.inputSchema !== 'object')) invalid('Invalid read action definition');
      if (a.read?.mcp) {
        mcpReadBindingSchema.parse(a.read.mcp);
        for (const dep of a.read.mcp.requires) {
          const source = this.actions.find(action => action.id === dep.action);
          if ((dep.action ? (source?.read?.resultType ?? source?.operation?.resultType) !== dep.objectType : !this.hasType(dep.objectType)) || !this.functions.some(f => f.id === dep.evaluate && f.inputTypes.some(t => this.implements(dep.objectType, t)))) invalid('Unresolved ontology MCP evidence dependency');
        }
        for (const dep of a.read.mcp.requires) if (dep.derive && (!dep.selectionInput || !this.functions.some(f => f.id === dep.derive!.function && f.inputTypes.some(type => this.implements(dep.objectType, type))))) invalid('Unresolved ontology source derivation');
        if (!a.read.module || !this.functions.some(f => f.id === a.read!.module!.completion.evaluate && f.inputTypes.some(t => this.implements(a.read!.resultType, t)))) invalid('Unresolved ontology MCP completion function');
      }
      if (a.operation) {
        const op = a.operation;
        const environmentAllowed = op.environment === 'sandbox' && op.effect !== 'external_draft'
          || op.environment === 'live_free' && ['reserve', 'local'].includes(op.effect) && !op.additionalEffects?.length
          || op.environment === 'local' && op.effect === 'local'
          || op.environment === 'live' && op.effect === 'external_draft' && !op.additionalEffects?.length && a.effects?.length === 1 && a.effects[0] === 'external_draft';
        if (a.read || !environmentAllowed || !['local', 'object_write', 'reserve', 'order', 'payment', 'change', 'cancel', 'refund', 'external_draft'].includes(op.effect)
          || op.effect === 'local' && !!op.additionalEffects?.length || !op.version || !this.objects.has(op.resultType) || !op.inputSchema || typeof op.inputSchema !== 'object') invalid('Invalid local, sandbox or nonfinancial draft operation definition');
      }
      for (const path of a.changes) {
        const [type, field, extra] = path.split('.');
        if (!type || !this.objects.has(type) || extra || field && (!Object.hasOwn(this.properties(type), field) && !this.sides(type).some(s => s.side.name === field))) invalid('Unresolved action change path');
        if (field && this.properties(type)[field]?.derived) invalid('Actions cannot write derived properties');
      }
    }
    for (const id of this.interfaces.keys()) for (const constraint of this.interfaceActions(id)) {
      nameSchema.parse(constraint.id);
      if (!Object.keys(constraint.inputs).length || Object.entries(constraint.inputs).some(([name, type]) => !nameSchema.safeParse(name).success || !this.hasType(type)) || !constraint.effects.length || constraint.effects.some(effect => !['local', 'read', 'object_write', 'reserve', 'order', 'payment', 'change', 'cancel', 'refund', 'external_draft'].includes(effect)) || constraint.resultTypes?.some(type => !this.hasType(type))) invalid('Invalid interface action constraint');
    }
    for (const item of definition.objects) for (const implementation of item.interfaces ?? []) {
      const constraints = this.interfaceActions(implementation.id);
      if (Object.keys(implementation.actionMap ?? {}).some(id => !constraints.some(constraint => constraint.id === id))) invalid('Unknown interface action mapping');
      for (const constraint of constraints) {
        const mapping = implementation.actionMap?.[constraint.id];
        if (!mapping && constraint.optional) continue;
        if (!mapping) invalid(`Missing interface action implementation: ${item.id}.${constraint.id}`);
        const action = this.actions.find(action => action.id === mapping.actionId);
        if (!action) invalid('Unresolved interface action implementation');
        const actualInputs = Object.keys(action.inputs), mappedInputs = Object.keys(mapping.inputMap);
        if (actualInputs.length !== mappedInputs.length || actualInputs.some(input => !Object.hasOwn(mapping.inputMap, input))
          || new Set(Object.values(mapping.inputMap)).size !== Object.keys(constraint.inputs).length
          || Object.entries(mapping.inputMap).some(([actual, expected]) => {
            const target = constraint.inputs[expected], actualType = action.inputs[actual];
            if (!target || !actualType || !this.assignableType(actualType, target)) return true;
            return (target === implementation.id || this.interfaceAncestors(implementation.id).includes(target)) && !this.implements(item.id, actualType);
          })
          || !action.effects || digest([...new Set(action.effects)].sort()) !== digest([...new Set(constraint.effects)].sort())
          || constraint.resultTypes?.some(expected => !action.resultTypes?.some(actual => this.assignableType(actual, expected)))) invalid('Incompatible interface action mapping');
        if (constraint.ports) {
          if (!action.composition) invalid('Interface ports require an explicit action composition contract');
          const actual = action.composition;
          for (const [input, expected] of Object.entries(constraint.ports.inputs)) {
            const concrete = Object.entries(mapping.inputMap).find(([, alias]) => alias === input)?.[0];
            if (!concrete || !actual.inputs[concrete]) invalid('Missing interface input port mapping');
            const port = expected.kind === 'object' && expected.type === implementation.id ? { ...expected, type: item.id } : expected;
            assertPortCompatible(this, port, actual.inputs[concrete]);
            if (expected.evidence.origins.some(origin => !actual.inputs[concrete]!.evidence.origins.includes(origin))) invalid('Interface input provenance cannot be narrowed by an implementation');
          }
          const outputMap = mapping.outputMap ?? Object.fromEntries(Object.keys(constraint.ports.outputs).map(name => [name, name]));
          if (new Set(Object.values(outputMap)).size !== Object.keys(outputMap).length || Object.keys(outputMap).some(name => !actual.outputs[name]) || Object.values(outputMap).some(name => !constraint.ports!.outputs[name])) invalid('Invalid interface output port mapping');
          for (const [output, expected] of Object.entries(constraint.ports.outputs)) {
            const concrete = Object.entries(outputMap).find(([, alias]) => alias === output)?.[0];
            if (!concrete || !actual.outputs[concrete]) invalid('Missing interface output port mapping');
            assertPortCompatible(this, actual.outputs[concrete], expected);
            if (actual.outputs[concrete]!.evidence.origins.some(origin => !expected.evidence.origins.includes(origin))) invalid('Interface output provenance cannot be weakened by an implementation');
          }
        } else if (mapping.outputMap) invalid('Output port mappings require an interface port contract');
      }
    }
    const documented = [...this.objects.values()].filter(type => type.businessDescription !== undefined);
    // Releases up to v31 fingerprint their *projection*: describeType() feeds the
    // digest, so adding a field to a read-only view counts as republishing the
    // ontology. From v32 the digest covers the released data only, which lets the
    // projection evolve without invalidating a reviewed release. Published
    // fingerprints never move: the split is version-gated, not a rewrite.
    const releasedVersion = Number(definition.version);
    const projectionCoupled = !Number.isSafeInteger(releasedVersion) || releasedVersion <= 31;
    // Action bindings are part of the kinetic contract, but no published release
    // described them. From v32 the projection can say which actions operate on a
    // type without republishing anything, because the digest covers released data.
    this.#bindActions = !projectionCoupled;
    // Anything described while the release was still being validated was cached
    // against the old projection; the bindings must be recomputed for this one.
    this.typeDescriptions.clear();
    const releasedContract = (property: PropertyDefinition) => ({ ...property, schema: property.schemaMetadata });
    const releasedType = (type: { id: string; properties: Record<string, PropertyDefinition> }) => ({ ...type, properties: Object.fromEntries(Object.entries(type.properties).map(([name, property]) => [name, releasedContract(property)])) });
    const releasedData = { objects: [...this.objects.values()].map(releasedType), interfaces: [...this.interfaces.values()].map(releasedType), links: this.links, actions: this.actions, functions: this.functions,
      ...(definition.criteriaVersion === '2' ? { criteriaVersion: definition.criteriaVersion } : {}),
      ...(documented.length ? { documentedContracts: documented.map(type => ({ id: type.id, fingerprint: this.fingerprint(type.id) })) } : {}) };
    this.ref = Object.freeze({ id: definition.id, version: definition.version, digest: digest(projectionCoupled ? { objects: [...this.objects.keys()].map(id => this.describeType(id)), interfaces: [...this.interfaces.keys()].map(id => this.describeType(id)), links: this.links, actions: this.actions, functions: this.functions,
      // A display override must not conceal a different underlying data contract.
      ...(documented.length ? { documentedContracts: documented.map(type => ({ id: type.id, fingerprint: this.fingerprint(type.id) })) } : {}) } : releasedData) });
    Object.defineProperty(this, 'ref', { writable: false, configurable: false });
    for (const key of ['options', 'actions', 'functions']) Object.defineProperty(this, key, { writable: false, configurable: false });
  }
  #bindActions = false;
  private interfaceProperties(id: string, active = new Set<string>()): Record<string, PropertyDefinition> {
    const value = this.interfaces.get(id);
    if (!value || active.has(id)) invalid('Unresolved or cyclic interface');
    const next = new Set(active).add(id), result: Record<string, PropertyDefinition> = {};
    for (const parent of value.parents ?? []) for (const [name, p] of Object.entries(this.interfaceProperties(parent, next))) {
      if (result[name] && digest(propertyContract(result[name])) !== digest(propertyContract(p))) invalid('Conflicting inherited property');
      result[name] = p;
    }
    for (const [name, p] of Object.entries(value.properties)) {
      nameSchema.parse(name);
      if (result[name] && digest(propertyContract(result[name])) !== digest(propertyContract(p))) invalid('Conflicting inherited property');
      result[name] = p;
    }
    return result;
  }
  private interfaceLinks(id: string): NonNullable<InterfaceDefinition['links']> {
    const i = this.interfaces.get(id)!;
    const result = new Map<string, NonNullable<InterfaceDefinition['links']>[number]>();
    for (const constraint of [...(i.parents ?? []).flatMap(p => this.interfaceLinks(p)), ...(i.links ?? [])]) {
      const prior = result.get(constraint.name);
      if (prior && digest(prior) !== digest(constraint)) invalid('Conflicting inherited interface link');
      result.set(constraint.name, constraint);
    }
    return [...result.values()];
  }
  private structuralInterface(id: string): boolean {
    const value = this.interfaces.get(id)!;
    return value.propertyCompatibility === 'structural_v1' || (value.parents ?? []).some(parent => this.structuralInterface(parent));
  }
  private interfaceOptionalProperties(id: string): string[] {
    const i = this.interfaces.get(id)!;
    const own = i.optionalProperties ?? [];
    const inherited = (i.parents ?? []).flatMap(parent => this.interfaceOptionalProperties(parent));
    for (const parent of i.parents ?? []) for (const name of own) if (Object.hasOwn(this.interfaceProperties(parent), name) && !this.interfaceOptionalProperties(parent).includes(name)) invalid('An inherited required interface capability cannot become optional');
    return [...new Set([...inherited, ...own])];
  }
  private interfaceActions(id: string): InterfaceActionConstraint[] {
    const i = this.interfaces.get(id)!;
    const actions = new Map<string, InterfaceActionConstraint>();
    for (const action of [...(i.parents ?? []).flatMap(parent => this.interfaceActions(parent)), ...(i.actions ?? [])]) {
      const prior = actions.get(action.id);
      if (prior && digest(prior) !== digest(action)) invalid('Conflicting inherited interface action');
      actions.set(action.id, action);
    }
    return [...actions.values()];
  }
  assignableType(actual: string, expected: string): boolean { if (!this.hasType(actual) || !this.hasType(expected)) return false; if (actual === expected) return true; return this.isInterface(actual) ? this.interfaceAncestors(actual).includes(expected) : this.implements(actual, expected); }
  hasType(id: string) { return this.objects.has(id) || this.interfaces.has(id); }
  isInterface(id: string) { return this.interfaces.has(id); }
  object(id: string) { return this.objects.get(id) ?? invalid('Unknown concrete object type'); }
  objectWritePolicy(id: string): 'managed' | 'source' { return this.object(id).writePolicy ?? 'source'; }
  propertyAuthority(type: string, property: string): 'managed' | 'source' { return this.properties(type)[property]?.authority ?? this.objectWritePolicy(type); }
  linkWritePolicy(id: string): 'managed' | 'source' { return this.link(id).writePolicy ?? 'source'; }
  implements(type: string, target: string): boolean {
    if (type === target) return this.objects.has(type);
    const key = `${type}\u0000${target}`;
    const cached = this.implementCache.get(key);
    if (cached !== undefined) return cached;
    const matches = (id: string): boolean => id === target || (this.interfaces.get(id)?.parents ?? []).some(matches);
    const result = (this.objects.get(type)?.interfaces ?? []).some(i => matches(i.id));
    this.implementCache.set(key, result);
    return result;
  }
  concreteTypes(target: string): string[] {
    if (!this.hasType(target)) invalid('Unknown ontology type');
    return [...this.objects.keys()].filter(type => this.implements(type, target)).sort();
  }
  propertyName(type: string, target: string, name: string): string {
    if (!this.implements(type, target) && type !== target) invalid('Object does not implement requested type');
    if (!this.isInterface(target)) return name;
    const mappings = (this.object(type).interfaces ?? []).filter(i => i.id === target || this.interfaceAncestors(i.id).includes(target)).map(i => i.propertyMap?.[name] ?? name);
    if (!mappings.length) return invalid('Unresolved property mapping');
    if (new Set(mappings).size > 1) invalid('Ambiguous interface property mapping');
    return mappings[0]!;
  }
  linkName(type: string, target: string, name: string): string {
    if (!this.implements(type, target) || !this.isInterface(target) || !this.interfaceLinks(target).some(link => link.name === name)) invalid('Unknown implemented interface relationship');
    const names = (this.object(type).interfaces ?? []).filter(i => i.id === target || this.interfaceAncestors(i.id).includes(target)).map(i => i.linkMap?.[name] ?? name);
    if (new Set(names).size !== 1) invalid('Ambiguous interface relationship mapping');
    return names[0]!;
  }
  definitionSnapshot(): ModelDefinition { return { id: this.ref.id, version: this.ref.version, objects: [...this.objects.values()], interfaces: [...this.interfaces.values()], links: [...this.links], actions: [...this.actions], functions: [...this.functions], ...(this.criteriaVersion ? { criteriaVersion: this.criteriaVersion } : {}) }; }
  typeIds(): string[] { return [...this.objects.keys(), ...this.interfaces.keys()]; }
  actionIds(): string[] { return this.actions.map(action => action.id); }
  /** Actions bound to one object type: the ones that write it, and the ones that read it. */
  typeActions(id: string): { writes: { id: string; requiresApproval: boolean }[]; reads: { id: string; requiresApproval: boolean }[] } {
    if (!this.objects.has(id)) invalid('Unknown object type');
    const writes: { id: string; requiresApproval: boolean }[] = [], reads: { id: string; requiresApproval: boolean }[] = [];
    for (const action of this.actions) {
      const changes = action.changes.some(path => path.split('.')[0] === id);
      const touches = changes || Object.values(action.inputs).some(type => this.implements(id, type)) || (action.resultTypes ?? []).some(type => this.implements(id, type));
      if (!touches) continue;
      (changes ? writes : reads).push({ id: action.id, requiresApproval: this.approvalRequired(action.id) });
    }
    return { writes, reads };
  }
  /** Static effect-authority requirement only. An existing exact grant may
   * satisfy it; false never means executable or currently authorized. */
  approvalRequired(actionId: string): boolean {
    const action = this.actions.find(candidate => candidate.id === actionId) ?? invalid('Unknown action');
    const effects = [...(action.effects ?? []), ...(action.operation ? [action.operation.effect, ...(action.operation.additionalEffects ?? [])] : []), ...(action.read ? ['read'] : [])];
    return action.requiresApproval === true || action.implementation?.kind === 'declarative' || effects.some(effect => APPROVAL_EFFECTS.has(effect));
  }
  functionBindingStatus(id: string) {
    const definition = this.function(id), handlerRef = this.options.trustedFunctionImplementations?.[id];
    return handlerRef ? { state: 'executable_registered' as const, handlerRef: { ...handlerRef }, contract: definition.executionContract?.mode ?? 'legacy', authorizationRequired: true as const }
      : { state: 'unbound' as const, executable: false as const };
  }
  functionIds(): string[] { return this.functions.map(fn => fn.id); }
  private interfaceAncestors(id: string): string[] {
    const cached = this.ancestorCache.get(id);
    if (cached) return cached;
    const ancestors = (this.interfaces.get(id)?.parents ?? []).flatMap(p => [p, ...this.interfaceAncestors(p)]);
    this.ancestorCache.set(id, ancestors);
    return ancestors;
  }
  properties(target: string) { return this.isInterface(target) ? this.interfaceProperties(target) : this.object(target).properties; }
  parseProperties(type: string, value: unknown): Record<string, unknown> {
    const parsed = this.schemas.get(type)?.safeParse(value);
    if (!parsed?.success) invalid('Object properties violate the registered schema');
    return parsed.data as Record<string, unknown>;
  }
  fingerprint(type: string) { return this.fingerprints.get(type) ?? invalid('Unknown concrete object type'); }
  link(id: string) { return this.links.find(l => l.id === id) ?? invalid('Unknown link type'); }
  sides(type: string) {
    let sides = this.linkSides.get(type);
    if (!sides) {
      sides = this.links.flatMap(link => [
        ...(this.implements(type, link.from.type) ? [{ link, side: link.from, other: link.to, direction: 'forward' as const }] : []),
        ...(this.implements(type, link.to.type) ? [{ link, side: link.to, other: link.from, direction: 'reverse' as const }] : []),
      ]);
      this.linkSides.set(type, sides);
    }
    // The compiled model is static. Cache only definitions, never owned objects,
    // source observations, current grants or request-membership results.
    return sides.map(side => ({ ...side }));
  }
  navigation(type: string, name: string, as?: string) {
    const actual = as ? this.linkName(type, as, name) : name;
    const side = this.sides(type).find(s => s.side.name === actual) ?? invalid('Unknown relationship on this object type');
    return { ...side, ...(as ? { viewType: this.interfaceLinks(as).find(link => link.name === name)!.target } : {}) };
  }
  describeType(id: string): object {
    const cached = this.typeDescriptions.get(id);
    if (cached) return structuredClone(cached);
    const i = this.interfaces.get(id), o = this.objects.get(id);
    if (!i && !o) invalid('Unknown ontology type');
    const description = { kind: i ? 'interface' : 'object', id, ...(o ? { version: o.version, name: o.name, aliases: o.aliases, description: o.businessDescription ?? o.description, primaryKey: o.primaryKey, titleKey: o.titleKey, interfaces: o.interfaces ?? [], ...(o.visibility ? { visibility: o.visibility } : {}), ...(o.classification ? { classification: o.classification } : {}), ...(o.writePolicy ? { writePolicy: o.writePolicy } : {}) } : { description: i!.description, parents: i!.parents ?? [], linkConstraints: this.interfaceLinks(id), ...(i!.status ? { status: i!.status } : {}), ...(i!.searchable !== undefined ? { searchable: i!.searchable } : {}), ...(i!.optionalProperties ? { optionalProperties: this.interfaceOptionalProperties(id) } : {}), ...(this.interfaceActions(id).length ? { actionConstraints: this.interfaceActions(id) } : {}) }),
      ...(i?.propertyCompatibility ? { propertyCompatibility: i.propertyCompatibility } : {}),
      ...(i?.projectionOnly ? { projectionOnly: true } : {}),
      ...(o && this.#bindActions ? { actions: this.typeActions(id) } : {}),
      properties: Object.fromEntries(Object.entries(this.properties(id)).map(([k, p]) => [k, propertyMetadata(p)])),
      ...(o ? { links: this.sides(id).map(({ side, other, link }) => ({ id: link.id, name: side.name, target: other.type, many: side.many, required: !!side.required, description: link.description })) } : {}) };
    this.typeDescriptions.set(id, description);
    return structuredClone(description);
  }
  actionDefinitions() { return structuredClone(this.actions); }
  functionDefinitions() { return structuredClone(this.functions); }
  describe(input: PaDiscoveryInput & { search?: string; linkSearch?: string; limit?: number; after?: string; kind?: 'types' | 'actions' | 'functions' } = {}) {
    const args = z.object({ ...paDiscoveryFields, search: z.string().max(100).optional(), linkSearch: linkSearchSchema, limit: z.number().int().min(1).max(5).default(3), after: nameSchema.optional(), kind: z.enum(['types', 'actions', 'functions']).default('types') }).strict().parse(input);
    const search = args.search?.trim().toLowerCase();
    const matched = (values: (string | undefined)[]) => !search || values.filter(Boolean).join(' ').toLowerCase().includes(search);
    const page = <T extends { id: string }>(values: T[]) => {
      const sorted = values.filter(value => !args.after || value.id > args.after).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const items = sorted.slice(0, args.limit), hasMore = sorted.length > items.length;
      return { items, hasMore, next: hasMore ? items.at(-1)?.id : undefined };
    };
    const catalog = { objectTypes: this.objects.size, interfaces: this.interfaces.size, actions: this.actions.length, functions: this.functions.length };
    const selection = paDiscoverySelection(this.typeIds().map(id => ({ id, kind: this.isInterface(id) ? 'interface' : 'object', classification: this.objects.get(id)?.classification })), args, (type, target) => this.implements(type, target));
    if (args.kind === 'actions') {
      const result = page(this.actions.filter(a => matched([a.id, a.description, a.providerOperation])));
      return { model: { ...this.ref }, kind: args.kind, catalog, types: [], actions: structuredClone(result.items).map(a => ({ ...a, execution: 'definition_only' })), functions: [], hasMore: result.hasMore, next: result.next };
    }
    if (args.kind === 'functions') {
      const result = page(this.functions.filter(f => matched([f.id, f.description])));
      return { model: { ...this.ref }, kind: args.kind, catalog, types: [], actions: [], functions: structuredClone(result.items), hasMore: result.hasMore, next: result.next };
    }
    const matches = selection.types.map(type => type.id).sort().filter(id => {
      const o = this.objects.get(id), i = this.interfaces.get(id);
      return (!args.after || id > args.after) && (search
        ? matched([id, o?.name, o?.businessDescription, o?.description, ...(o?.aliases ?? []), i?.description])
        : !!selection.discovery || o?.visibility !== 'technical');
    });
    const ids = matches.slice(0, args.limit);
    // Common roots appear on almost every action. They are not useful relevance
    // signals; explicit action/function pages remain available for full discovery.
    const generic = new Set(['ServiceRequest', 'Provider', 'Channel', 'SourceReceipt', 'EvidenceBacked']);
    const relevant = (type: string) => ids.some(id => !generic.has(id) && (id === type || this.implements(id, type)));
    const actions = this.actions.filter(a => Object.values(a.inputs).some(relevant)
      || a.changes.some(change => relevant(change.split('.')[0]!))
      || !!a.read && relevant(a.read.resultType) || !!a.operation && relevant(a.operation.resultType)
      || !!search && matched([a.id]));
    const functions = this.functions.filter(f => f.inputTypes.some(relevant) || !!search && matched([f.id]));
    return { model: { ...this.ref }, ...(selection.discovery ? { discovery: selection.discovery } : {}), kind: args.kind, catalog, types: ids.map(id => filterRelationshipMetadata(paDefinitionLinks(this.describeType(id) as { links?: { target: string }[] }, selection.types, selection.discovery?.view === 'pa'), args.linkSearch)), functions: structuredClone(functions), actions: structuredClone(actions).map(a => ({ ...a, execution: 'definition_only' })), hasMore: matches.length > ids.length, next: matches.length > ids.length ? ids.at(-1) : undefined };
  }
  action(id: string) { const a = this.actions.find(a => a.id === id); return a ? structuredClone(a) : invalid('Unknown ontology action'); }
  actionImplementation(id: string): ActionImplementation | undefined { const implementation = this.action(id).implementation ?? this.options.trustedActionImplementations?.[id]; return implementation ? structuredClone(implementation) : undefined; }
  actionBindingStatus(id: string): ActionBindingStatus {
    const implementation = this.actionImplementation(id);
    if (!implementation) return { state: 'unbound', executable: false };
    if (implementation.kind === 'declarative') return { state: 'declarative_supported', version: implementation.version, authorizationRequired: true };
    return { state: 'trusted_contract_available', handlerRef: { ...implementation.handlerRef }, runtimeBindingRequired: true, authorizationRequired: true };
  }
  resolveInterfaceAction(type: string, interfaceId: string, actionId: string): { action: ActionDefinition; inputMap: Record<string, string> } {
    if (!this.isInterface(interfaceId) || !this.implements(type, interfaceId)) invalid('Object does not implement the action interface');
    if (!this.interfaceActions(interfaceId).some(action => action.id === actionId)) invalid('Unknown interface action constraint');
    const mappings = (this.object(type).interfaces ?? []).filter(i => i.id === interfaceId || this.interfaceAncestors(i.id).includes(interfaceId)).flatMap(i => i.actionMap?.[actionId] ? [i.actionMap[actionId]!] : []);
    if (!mappings.length) invalid('Optional interface action is not implemented by this type');
    if (mappings.some(mapping => digest(mapping) !== digest(mappings[0]))) invalid('Ambiguous interface action mapping');
    return { action: this.action(mappings[0]!.actionId), inputMap: structuredClone(mappings[0]!.inputMap) };
  }
  /** Resolves only explicit registered operation aliases, never inferred names. */
  actionForOperation(operation: string) {
    const action = this.actions.find(a => a.id === operation || a.providerOperation === operation);
    return action ? structuredClone(action) : undefined;
  }
  function(id: string) { const f = this.functions.find(f => f.id === id); return f ? structuredClone(f) : invalid('Unknown ontology function'); }
  functionsFor(types: string[]) { return structuredClone(this.functions.filter(f => f.inputTypes.some(input => types.some(type => this.implements(type, input))))); }
}
