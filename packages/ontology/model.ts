import { mcpReadBindingSchema, type McpReadBinding } from './mcp-read.js';
import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import type { ActionImplementation } from './action-dsl.js';
import { assertPortCompatible, type CompositionPort } from './composition-contract.js';

export const nameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,79}$/).refine(v => !['constructor', 'prototype', '__proto__'].includes(v));
export const objectRefSchema = z.object({ type: nameSchema, id: z.string().min(1).max(200) }).strict();
export type ObjectRef = z.infer<typeof objectRefSchema>;
export type ScalarKind = 'string' | 'integer' | 'boolean' | 'timestamp' | 'decimal' | 'struct' | 'array';
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
  /** A capability may be absent from an implementing type; required still governs stored values. */
  optionalProperties?: string[];
  links?: { name: string; target: string; many: boolean; optional?: boolean }[];
  actions?: InterfaceActionConstraint[];
}
export interface ObjectTypeDefinition {
  id: string;
  version: string;
  name: string;
  aliases: string[];
  description: string;
  primaryKey: string;
  titleKey: string;
  properties: Record<string, PropertyDefinition>;
  interfaces?: { id: string; propertyMap?: Record<string, string>; actionMap?: Record<string, InterfaceActionMapping> }[];
  /** Discovery presentation only; never an object permission or data-schema change. */
  visibility?: 'business' | 'technical';
  /** Missing policy means source-authoritative, preserving pre-registry contracts. */
  writePolicy?: 'managed' | 'source';
}
export interface LinkDefinition {
  id: string;
  description: string;
  from: { type: string; name: string; many: boolean; required?: boolean };
  to: { type: string; name: string; many: boolean; required?: boolean };
  writePolicy?: 'managed' | 'source';
}
export interface ActionDefinition {
  id: string;
  version?: string;
  kind?: 'decision' | 'source_read' | 'business';
  effects?: import('./actions.js').EffectClass[];
  resultTypes?: string[];
  description: string;
  inputs: Record<string, string>;
  changes: string[];
  submissionCriteria: string[];
  providerOperation?: string;
  // A definition is not an executable grant. A configured AgentProgram must bind
  // it, validate its schema and scope, and enforce read-only dispatch separately.
  read?: { version: string; effect: 'read'; inputSchema: object; resultType: string; mcp?: McpReadBinding; module?: { id: string; version: string; digest: string; completion: { evaluate: string } } };
  operation?: { version: string; effect: Exclude<import('./actions.js').EffectClass, 'read'>; additionalEffects?: import('./actions.js').EffectClass[]; environment: 'sandbox' | 'local'; inputSchema: object; resultType: string };
  inputSchema?: Record<string, unknown>;
  implementation?: ActionImplementation;
  /** Versioned ports and evidence rules. A contract alone never grants dispatch. */
  composition?: import('./composition-contract.js').ActionCompositionContract;
}
export interface FunctionDefinition { id: string; version: string; inputTypes: string[]; description: string }
export interface ModelDefinition { id: string; version: string; objects: ObjectTypeDefinition[]; interfaces: InterfaceDefinition[]; links: LinkDefinition[]; actions: ActionDefinition[]; functions: FunctionDefinition[] }
function invalid(message: string): never { throw new DomainError('INVALID_INPUT', message); }
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
export interface OntologyModelOptions { trustedActionImplementations?: Record<string, ActionImplementation> }
export type ActionBindingStatus =
  | { state: 'unbound'; executable: false }
  | { state: 'declarative_supported'; version: '1'; authorizationRequired: true }
  | { state: 'trusted_contract_available'; handlerRef: { id: string; version: string; digest: string }; runtimeBindingRequired: true; authorizationRequired: true };

/** Compiles trusted definitions once. No executable expressions or provider URLs are accepted. */
export class OntologyModel {
  readonly ref: { id: string; version: string; digest: string };
  private objects = new Map<string, ObjectTypeDefinition>();
  private interfaces = new Map<string, InterfaceDefinition>();
  private schemas = new Map<string, z.ZodType>();
  private fingerprints = new Map<string, string>();
  private links: LinkDefinition[];
  private linkSides = new Map<string, { link: LinkDefinition; side: LinkDefinition['from']; other: LinkDefinition['to']; direction: 'forward' | 'reverse' }[]>();
  private typeDescriptions = new Map<string, object>();
  private actions: ActionDefinition[];
  private functions: FunctionDefinition[];
  constructor(definition: ModelDefinition, private options: OntologyModelOptions = {}) {
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
        if (!actual || digest(propertyContract(actual)) !== digest(propertyContract(p))) invalid(`Incompatible interface property: ${item.id}.${alias}`);
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
      const sides = this.sides(item.id);
      if (new Set(sides.map(s => s.side.name)).size !== sides.length) invalid(`Ambiguous link name on ${item.id}`);
      for (const implementation of item.interfaces ?? []) for (const constraint of this.interfaceLinks(implementation.id)) {
        const found = sides.find(s => s.side.name === constraint.name);
        if (!found && constraint.optional) continue;
        if (!found || found.other.type !== constraint.target || found.side.many !== constraint.many) invalid(`Unresolved interface link on ${item.id}`);
      }
      const { links: _links, visibility: _visibility, ...objectDefinition } = this.describeType(item.id) as Record<string, unknown>;
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
      if (a.effects && (!a.effects.length || a.effects.some(effect => !['local', 'read', 'object_write', 'reserve', 'order', 'payment', 'change', 'cancel', 'refund'].includes(effect)))) invalid('Invalid declared action effects');
      if (a.resultTypes?.some(type => !this.hasType(type))) invalid('Unknown declared action result type');
      if (a.read && (a.kind && a.kind !== 'source_read' || a.effects && (a.effects.length !== 1 || a.effects[0] !== 'read') || a.resultTypes && !a.resultTypes.includes(a.read.resultType))) invalid('Read action contract conflicts with its declared semantics');
      if (!a.changes.length || !a.submissionCriteria.length || Object.values(a.inputs).some(t => !this.hasType(t))) invalid('Invalid action definition');
      if (a.read && (a.read.effect !== 'read' || !a.read.version || !this.objects.has(a.read.resultType) || !a.read.inputSchema || typeof a.read.inputSchema !== 'object')) invalid('Invalid read action definition');
      if (a.read?.mcp) {
        mcpReadBindingSchema.parse(a.read.mcp);
        for (const dep of a.read.mcp.requires) if (this.actions.find(action => action.id === dep.action)?.read?.resultType !== dep.objectType || !this.functions.some(f => f.id === dep.evaluate && f.inputTypes.some(t => this.implements(dep.objectType, t)))) invalid('Unresolved ontology MCP evidence dependency');
        if (!a.read.module || !this.functions.some(f => f.id === a.read!.module!.completion.evaluate && f.inputTypes.some(t => this.implements(a.read!.resultType, t)))) invalid('Unresolved ontology MCP completion function');
      }
      if (a.operation && (a.read || a.operation.environment !== 'sandbox' && !(a.operation.environment === 'local' && a.operation.effect === 'local') || !['local', 'object_write', 'reserve', 'order', 'payment', 'change', 'cancel', 'refund'].includes(a.operation.effect) || a.operation.effect === 'local' && !!a.operation.additionalEffects?.length || !a.operation.version || !this.objects.has(a.operation.resultType) || !a.operation.inputSchema || typeof a.operation.inputSchema !== 'object')) invalid('Invalid local or sandbox operation definition');
      for (const path of a.changes) {
        const [type, field, extra] = path.split('.');
        if (!type || !this.objects.has(type) || extra || field && (!Object.hasOwn(this.properties(type), field) && !this.sides(type).some(s => s.side.name === field))) invalid('Unresolved action change path');
        if (field && this.properties(type)[field]?.derived) invalid('Actions cannot write derived properties');
      }
    }
    for (const id of this.interfaces.keys()) for (const constraint of this.interfaceActions(id)) {
      nameSchema.parse(constraint.id);
      if (!Object.keys(constraint.inputs).length || Object.entries(constraint.inputs).some(([name, type]) => !nameSchema.safeParse(name).success || !this.hasType(type)) || !constraint.effects.length || constraint.effects.some(effect => !['local', 'read', 'object_write', 'reserve', 'order', 'payment', 'change', 'cancel', 'refund'].includes(effect)) || constraint.resultTypes?.some(type => !this.hasType(type))) invalid('Invalid interface action constraint');
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
    this.ref = Object.freeze({ id: definition.id, version: definition.version, digest: digest({ objects: [...this.objects.keys()].map(id => this.describeType(id)), interfaces: [...this.interfaces.keys()].map(id => this.describeType(id)), links: this.links, actions: this.actions, functions: this.functions }) });
    Object.defineProperty(this, 'ref', { writable: false, configurable: false });
  }
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
    const matches = (id: string): boolean => id === target || (this.interfaces.get(id)?.parents ?? []).some(matches);
    return (this.objects.get(type)?.interfaces ?? []).some(i => matches(i.id));
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
  private interfaceAncestors(id: string): string[] { return (this.interfaces.get(id)?.parents ?? []).flatMap(p => [p, ...this.interfaceAncestors(p)]); }
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
  navigation(type: string, name: string) { return this.sides(type).find(s => s.side.name === name) ?? invalid('Unknown relationship on this object type'); }
  describeType(id: string): object {
    const cached = this.typeDescriptions.get(id);
    if (cached) return structuredClone(cached);
    const i = this.interfaces.get(id), o = this.objects.get(id);
    if (!i && !o) invalid('Unknown ontology type');
    const description = { kind: i ? 'interface' : 'object', id, ...(o ? { version: o.version, name: o.name, aliases: o.aliases, description: o.description, primaryKey: o.primaryKey, titleKey: o.titleKey, interfaces: o.interfaces ?? [], ...(o.visibility ? { visibility: o.visibility } : {}), ...(o.writePolicy ? { writePolicy: o.writePolicy } : {}) } : { description: i!.description, parents: i!.parents ?? [], linkConstraints: this.interfaceLinks(id), ...(i!.optionalProperties ? { optionalProperties: this.interfaceOptionalProperties(id) } : {}), ...(this.interfaceActions(id).length ? { actionConstraints: this.interfaceActions(id) } : {}) }),
      properties: Object.fromEntries(Object.entries(this.properties(id)).map(([k, p]) => [k, propertyMetadata(p)])),
      ...(o ? { links: this.sides(id).map(({ side, other, link }) => ({ id: link.id, name: side.name, target: other.type, many: side.many, required: !!side.required, description: link.description })) } : {}) };
    this.typeDescriptions.set(id, description);
    return structuredClone(description);
  }
  actionDefinitions() { return structuredClone(this.actions); }
  functionDefinitions() { return structuredClone(this.functions); }
  describe(input: { search?: string; limit?: number; after?: string; kind?: 'types' | 'actions' | 'functions' } = {}) {
    const args = z.object({ search: z.string().max(100).optional(), limit: z.number().int().min(1).max(5).default(3), after: nameSchema.optional(), kind: z.enum(['types', 'actions', 'functions']).default('types') }).strict().parse(input);
    const search = args.search?.trim().toLowerCase();
    const matched = (values: (string | undefined)[]) => !search || values.filter(Boolean).join(' ').toLowerCase().includes(search);
    const page = <T extends { id: string }>(values: T[]) => {
      const sorted = values.filter(value => !args.after || value.id > args.after).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const items = sorted.slice(0, args.limit), hasMore = sorted.length > items.length;
      return { items, hasMore, next: hasMore ? items.at(-1)?.id : undefined };
    };
    const catalog = { objectTypes: this.objects.size, interfaces: this.interfaces.size, actions: this.actions.length, functions: this.functions.length };
    if (args.kind === 'actions') {
      const result = page(this.actions.filter(a => matched([a.id, a.description, a.providerOperation])));
      return { model: { ...this.ref }, kind: args.kind, catalog, types: [], actions: structuredClone(result.items).map(a => ({ ...a, execution: 'definition_only' })), functions: [], hasMore: result.hasMore, next: result.next };
    }
    if (args.kind === 'functions') {
      const result = page(this.functions.filter(f => matched([f.id, f.description])));
      return { model: { ...this.ref }, kind: args.kind, catalog, types: [], actions: [], functions: structuredClone(result.items), hasMore: result.hasMore, next: result.next };
    }
    const matches = [...this.objects.keys(), ...this.interfaces.keys()].sort().filter(id => {
      const o = this.objects.get(id), i = this.interfaces.get(id);
      return (!args.after || id > args.after) && (search
        ? matched([id, o?.name, o?.description, ...(o?.aliases ?? []), i?.description])
        : o?.visibility !== 'technical');
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
    return { model: { ...this.ref }, kind: args.kind, catalog, types: ids.map(id => this.describeType(id)), functions: structuredClone(functions), actions: structuredClone(actions).map(a => ({ ...a, execution: 'definition_only' })), hasMore: matches.length > ids.length, next: matches.length > ids.length ? ids.at(-1) : undefined };
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
}
