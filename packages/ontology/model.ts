import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';

export const nameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,79}$/).refine(v => !['constructor', 'prototype', '__proto__'].includes(v));
export const objectRefSchema = z.object({ type: nameSchema, id: z.string().min(1).max(200) }).strict();
export type ObjectRef = z.infer<typeof objectRefSchema>;
export type ScalarKind = 'string' | 'integer' | 'boolean' | 'timestamp' | 'decimal' | 'struct' | 'array';
export interface PropertyDefinition {
  description: string;
  kind: ScalarKind;
  schema: z.ZodType;
  source: string;
  required?: boolean;
  restricted?: boolean;
  derived?: string;
}
export interface InterfaceDefinition {
  id: string;
  description: string;
  parents?: string[];
  properties: Record<string, PropertyDefinition>;
  links?: { name: string; target: string; many: boolean }[];
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
  interfaces?: { id: string; propertyMap?: Record<string, string> }[];
  /** Discovery presentation only; never an object permission or data-schema change. */
  visibility?: 'business' | 'technical';
}
export interface LinkDefinition {
  id: string;
  description: string;
  from: { type: string; name: string; many: boolean; required?: boolean };
  to: { type: string; name: string; many: boolean; required?: boolean };
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
  read?: { version: string; effect: 'read'; inputSchema: object; resultType: string };
  operation?: { version: string; effect: Exclude<import('./actions.js').EffectClass, 'read'>; additionalEffects?: import('./actions.js').EffectClass[]; environment: 'sandbox'; inputSchema: object; resultType: string };
}
export interface FunctionDefinition { id: string; version: string; inputTypes: string[]; description: string }
export interface ModelDefinition { id: string; version: string; objects: ObjectTypeDefinition[]; interfaces: InterfaceDefinition[]; links: LinkDefinition[]; actions: ActionDefinition[]; functions: FunctionDefinition[] }
function invalid(message: string): never { throw new DomainError('INVALID_INPUT', message); }
const propertyMetadata = (p: PropertyDefinition) => ({ description: p.description, kind: p.kind, source: p.source, required: !!p.required, restricted: !!p.restricted, derived: p.derived, schema: z.toJSONSchema(p.schema) });

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
  constructor(definition: ModelDefinition) {
    for (const item of definition.interfaces) {
      nameSchema.parse(item.id);
      if (this.interfaces.has(item.id)) invalid('Duplicate interface');
      this.interfaces.set(item.id, { ...item, parents: [...(item.parents ?? [])], links: structuredClone(item.links ?? []), properties: Object.fromEntries(Object.entries(item.properties).map(([k, p]) => [k, Object.freeze({ ...p })])) });
    }
    for (const item of definition.objects) {
      nameSchema.parse(item.id);
      if (this.objects.has(item.id) || this.interfaces.has(item.id)) invalid('Duplicate ontology type');
      for (const [name, p] of Object.entries(item.properties)) {
        nameSchema.parse(name);
        if (!p.description || !p.source || p.required && p.derived) invalid('Incomplete property semantics');
      }
      for (const key of [item.primaryKey, item.titleKey]) if (item.properties[key]?.kind !== 'string' || !item.properties[key]?.required || item.properties[key]?.restricted || item.properties[key]?.derived) invalid('Keys must be required visible strings');
      this.objects.set(item.id, { ...item, aliases: [...item.aliases], interfaces: structuredClone(item.interfaces ?? []), properties: Object.fromEntries(Object.entries(item.properties).map(([k, p]) => [k, Object.freeze({ ...p })])) });
      const shape = Object.fromEntries(Object.entries(item.properties).filter(([, p]) => !p.derived).map(([k, p]) => [k, p.required ? p.schema : p.schema.optional()]));
      this.schemas.set(item.id, z.object(shape).strict());
    }
    for (const id of this.interfaces.keys()) this.interfaceProperties(id);
    this.functions = structuredClone(definition.functions);
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
        if (!actual || digest(propertyMetadata(actual)) !== digest(propertyMetadata(p))) invalid(`Incompatible interface property: ${item.id}.${alias}`);
      }
      if (Object.keys(implementation.propertyMap ?? {}).some(k => !Object.hasOwn(expected, k))) invalid('Unknown interface property mapping');
    }
    this.links = structuredClone(definition.links);
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
        if (!found || found.other.type !== constraint.target || found.side.many !== constraint.many) invalid(`Unresolved interface link on ${item.id}`);
      }
      const { links: _links, visibility: _visibility, ...objectDefinition } = this.describeType(item.id) as Record<string, unknown>;
      // Links pin their own definitions. Adding a relationship need not rewrite object data.
      this.fingerprints.set(item.id, digest(objectDefinition));
    }
    this.actions = structuredClone(definition.actions);
    if (new Set(this.actions.map(a => a.id)).size !== this.actions.length) invalid('Duplicate action');
    const operations = this.actions.flatMap(a => a.providerOperation ? [a.providerOperation] : []);
    if (new Set(operations).size !== operations.length || this.actions.some(a => a.providerOperation && this.actions.some(other => other !== a && other.id === a.providerOperation))) invalid('Ambiguous action operation binding');
    for (const a of this.actions) {
      nameSchema.parse(a.id);
      if (a.version !== undefined && !a.version.trim()) invalid('Invalid action version');
      if (a.effects && (!a.effects.length || a.effects.some(effect => !['local', 'read', 'reserve', 'order', 'payment', 'change', 'cancel', 'refund'].includes(effect)))) invalid('Invalid declared action effects');
      if (a.resultTypes?.some(type => !this.hasType(type))) invalid('Unknown declared action result type');
      if (a.read && (a.kind && a.kind !== 'source_read' || a.effects && (a.effects.length !== 1 || a.effects[0] !== 'read') || a.resultTypes && !a.resultTypes.includes(a.read.resultType))) invalid('Read action contract conflicts with its declared semantics');
      if (!a.changes.length || !a.submissionCriteria.length || Object.values(a.inputs).some(t => !this.hasType(t))) invalid('Invalid action definition');
      if (a.read && (a.read.effect !== 'read' || !a.read.version || !this.objects.has(a.read.resultType) || !a.read.inputSchema || typeof a.read.inputSchema !== 'object')) invalid('Invalid read action definition');
      if (a.operation && (a.read || a.operation.environment !== 'sandbox' || !['local', 'reserve', 'order', 'payment', 'change', 'cancel', 'refund'].includes(a.operation.effect) || a.operation.effect === 'local' && !!a.operation.additionalEffects?.length || !a.operation.version || !this.objects.has(a.operation.resultType) || !a.operation.inputSchema || typeof a.operation.inputSchema !== 'object')) invalid('Invalid sandbox operation definition');
      for (const path of a.changes) {
        const [type, field, extra] = path.split('.');
        if (!type || !this.objects.has(type) || extra || field && (!Object.hasOwn(this.properties(type), field) && !this.sides(type).some(s => s.side.name === field))) invalid('Unresolved action change path');
        if (field && this.properties(type)[field]?.derived) invalid('Actions cannot write derived properties');
      }
    }
    this.ref = { id: definition.id, version: definition.version, digest: digest({ objects: [...this.objects.keys()].map(id => this.describeType(id)), interfaces: [...this.interfaces.keys()].map(id => this.describeType(id)), links: this.links, actions: this.actions, functions: this.functions }) };
  }
  private interfaceProperties(id: string, active = new Set<string>()): Record<string, PropertyDefinition> {
    const value = this.interfaces.get(id);
    if (!value || active.has(id)) invalid('Unresolved or cyclic interface');
    const next = new Set(active).add(id), result: Record<string, PropertyDefinition> = {};
    for (const parent of value.parents ?? []) for (const [name, p] of Object.entries(this.interfaceProperties(parent, next))) {
      if (result[name] && digest(propertyMetadata(result[name])) !== digest(propertyMetadata(p))) invalid('Conflicting inherited property');
      result[name] = p;
    }
    for (const [name, p] of Object.entries(value.properties)) {
      nameSchema.parse(name);
      if (result[name] && digest(propertyMetadata(result[name])) !== digest(propertyMetadata(p))) invalid('Conflicting inherited property');
      result[name] = p;
    }
    return result;
  }
  private interfaceLinks(id: string): NonNullable<InterfaceDefinition['links']> {
    const i = this.interfaces.get(id)!;
    return [...(i.parents ?? []).flatMap(p => this.interfaceLinks(p)), ...(i.links ?? [])];
  }
  hasType(id: string) { return this.objects.has(id) || this.interfaces.has(id); }
  isInterface(id: string) { return this.interfaces.has(id); }
  object(id: string) { return this.objects.get(id) ?? invalid('Unknown concrete object type'); }
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
    for (const i of this.object(type).interfaces ?? []) if (i.id === target || this.interfaceAncestors(i.id).includes(target)) return i.propertyMap?.[name] ?? name;
    return invalid('Unresolved property mapping');
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
    const description = { kind: i ? 'interface' : 'object', id, ...(o ? { version: o.version, name: o.name, aliases: o.aliases, description: o.description, primaryKey: o.primaryKey, titleKey: o.titleKey, interfaces: o.interfaces ?? [], ...(o.visibility ? { visibility: o.visibility } : {}) } : { description: i!.description, parents: i!.parents ?? [], linkConstraints: this.interfaceLinks(id) }),
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
  /** Resolves only explicit registered operation aliases, never inferred names. */
  actionForOperation(operation: string) {
    const action = this.actions.find(a => a.id === operation || a.providerOperation === operation);
    return action ? structuredClone(action) : undefined;
  }
  function(id: string) { const f = this.functions.find(f => f.id === id); return f ? structuredClone(f) : invalid('Unknown ontology function'); }
}
