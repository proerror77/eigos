import { z } from 'zod';
import { digest } from '../core/identity.js';
import { ontologySchema, type OntologyDocument, type ObjectRef } from './schema.js';

const validators = new WeakMap<object, z.ZodType>();
export function validator(schema: Record<string, unknown>): z.ZodType {
  let cached = validators.get(schema);
  if (!cached) { cached = z.fromJSONSchema(schema); validators.set(schema, cached); }
  return cached;
}
const unique = <T extends { apiName: string }>(items: T[]): Map<string, T> => {
  const map = new Map(items.map(item => [item.apiName, item]));
  if (map.size !== items.length) throw new Error('Duplicate API name');
  return map;
};
const required = <T>(map: ReadonlyMap<string, T>, name: string): T => {
  const item = map.get(name);
  if (!item) throw new Error(`Unknown ontology resource ${name}`);
  return item;
};

export class Ontology {
  readonly document: OntologyDocument;
  readonly digest: string;
  readonly objects: ReadonlyMap<string, OntologyDocument['objectTypes'][number]>;
  readonly interfaces: ReadonlyMap<string, OntologyDocument['interfaceTypes'][number]>;
  readonly links: ReadonlyMap<string, OntologyDocument['linkTypes'][number]>;
  readonly functions: ReadonlyMap<string, OntologyDocument['functionTypes'][number]>;
  readonly actions: ReadonlyMap<string, OntologyDocument['actionTypes'][number]>;
  readonly sources: ReadonlyMap<string, OntologyDocument['dataSources'][number]>;
  private readonly objectValidators = new Map<string, z.ZodType>();

  constructor(input: unknown) {
    this.document = ontologySchema.parse(input);
    this.digest = digest(this.document);
    this.objects = unique(this.document.objectTypes);
    this.interfaces = unique(this.document.interfaceTypes);
    this.links = unique(this.document.linkTypes);
    this.functions = unique(this.document.functionTypes);
    this.actions = unique(this.document.actionTypes);
    this.sources = unique(this.document.dataSources);
    for (const type of this.objects.values()) {
      if (this.interfaces.has(type.apiName)) throw new Error('Object and interface names must be distinct');
      for (const key of [type.primaryKey, type.titleProperty]) {
        if (type.properties[key]?.schema.type !== 'string' || !type.properties[key]?.required) throw new Error(`Missing required string key on ${type.apiName}`);
      }
      this.objectValidators.set(type.apiName, z.strictObject(Object.fromEntries(Object.entries(type.properties)
        .map(([name, property]) => [name, property.required ? validator(property.schema) : validator(property.schema).optional()]))));
    }
    for (const link of this.links.values()) {
      this.object(link.from.type); this.object(link.to.type);
      for (const side of [link.from, link.to]) {
        const same = [...this.links.values()].flatMap(item => [item.from, item.to]).filter(item => item.type === side.type && item.name === side.name);
        if (same.length !== 1) throw new Error(`Ambiguous relationship ${side.type}.${side.name}`);
      }
    }
    for (const type of this.objects.values()) for (const [name, mapping] of Object.entries(type.interfaces)) {
      const contract = required(this.interfaces, name);
      for (const [alias, property] of Object.entries(contract.properties)) {
        const local = mapping.properties[alias];
        if (!local && contract.optionalProperties.includes(alias)) continue;
        if (!local || type.properties[local]?.schema.type !== property.schema.type) throw new Error(`Invalid property mapping ${type.apiName}.${alias}`);
      }
      if (Object.keys(mapping.properties).some(name => !contract.properties[name])) throw new Error('Unknown interface property');
      for (const [alias, constraint] of Object.entries(contract.links)) {
        const local = mapping.links[alias];
        if (!local && !constraint.required) continue;
        const navigation = this.navigation(type.apiName, local ?? '');
        if (!this.implements(navigation.target, constraint.target) || navigation.cardinality !== constraint.cardinality) throw new Error(`Invalid link mapping ${type.apiName}.${alias}`);
      }
      for (const [alias, constraint] of Object.entries(contract.actions)) {
        const local = mapping.actions[alias];
        if (!local && !constraint.required) continue;
        if (!local) throw new Error(`Missing action mapping ${type.apiName}.${alias}`);
        const action = this.action(local.action);
        const expected = constraint.parameters.properties as Record<string, { type?: string }>;
        const actual = action.parameters.properties as Record<string, { type?: string }>;
        const targets = Object.values(local.parameters);
        if (new Set(targets).size !== targets.length) throw new Error('An action parameter can satisfy one interface parameter');
        for (const parameter of constraint.parameters.required as string[] ?? []) {
          const target = local.parameters[parameter];
          if (!target || !expected[parameter] || actual[target]?.type !== expected[parameter].type || !(action.parameters.required as string[] ?? []).includes(target)) throw new Error('Incompatible action parameters');
        }
      }
    }
    for (const action of this.actions.values()) {
      validator(action.parameters);
      for (const type of Object.values(action.objectParameters)) this.concreteTypes(type);
      for (const criterion of action.submissionCriteria) required(this.functions, criterion.function);
      for (const rule of action.rules) {
        if (rule.op === 'createObject') {
          const object = this.object(rule.object.type);
          if (Object.keys(rule.properties).some(name => !object.properties[name])) throw new Error('Action writes an undeclared property');
        }
        if (rule.op === 'addLink') {
          const link = required(this.links, rule.link);
          if (rule.from.type !== link.from.type || rule.to.type !== link.to.type) throw new Error('Action link endpoints differ from the Link Type');
        }
      }
    }
    for (const source of this.sources.values()) {
      const type = this.object(source.objectType);
      required(this.functions, source.function);
      if (Object.keys(source.properties).some(name => !type.properties[name])) throw new Error('Datasource maps an unknown property');
      if (Object.entries(type.properties).some(([name, property]) => property.required && !source.properties[name])) throw new Error('Datasource lacks a required property mapping');
    }
    for (const fn of this.functions.values()) { validator(fn.parameters); validator(fn.returns); }
  }
  object(name: string) { return required(this.objects, name); }
  action(name: string) { return required(this.actions, name); }
  implements(type: string, target: string) { return type === target || Object.hasOwn(this.object(type).interfaces, target); }
  concreteTypes(target: string): string[] {
    if (!this.objects.has(target) && !this.interfaces.has(target)) throw new Error(`Unknown type ${target}`);
    return [...this.objects.keys()].filter(type => this.implements(type, target));
  }
  propertyName(type: string, view: string, property: string): string | undefined {
    if (type === view) { if (!this.object(type).properties[property]) throw new Error('Unknown property'); return property; }
    const mapping = this.object(type).interfaces[view];
    if (!mapping || !required(this.interfaces, view).properties[property]) throw new Error('Unknown interface property');
    return mapping.properties[property];
  }
  parseObject(ref: ObjectRef, properties: Record<string, unknown>): Record<string, unknown> {
    if (properties[this.object(ref.type).primaryKey] !== ref.id) throw new Error('Primary key differs from object reference');
    const value = this.objectValidators.get(ref.type)!.parse(properties) as Record<string, unknown>;
    for (const [name, mapping] of Object.entries(this.object(ref.type).interfaces)) {
      for (const [alias, local] of Object.entries(mapping.properties)) {
        const property = required(this.interfaces, name).properties[alias]!;
        if (value[local] !== undefined || property.required) validator(property.schema).parse(value[local]);
      }
    }
    return value;
  }
  navigation(type: string, name: string, view = type) {
    const actual = view === type ? name : this.object(type).interfaces[view]?.links[name];
    for (const link of this.links.values()) {
      if (link.from.type === type && link.from.name === actual) return { link: link.apiName, forward: true, target: link.to.type, cardinality: link.from.cardinality };
      if (link.to.type === type && link.to.name === actual) return { link: link.apiName, forward: false, target: link.from.type, cardinality: link.to.cardinality };
    }
    throw new Error(`Unknown relationship ${view}.${name}`);
  }
  resolveAction(ref: ObjectRef, interfaceName: string, name: string, input: Record<string, unknown>) {
    const contract = required(this.interfaces, interfaceName).actions[name];
    const mapping = this.object(ref.type).interfaces[interfaceName]?.actions[name];
    if (!contract || !mapping) throw new Error('Interface action is unavailable');
    const supplied = validator(contract.parameters).parse(input) as Record<string, unknown>;
    const subjects = Object.keys(contract.objectParameters).filter(parameter => this.implements(ref.type, contract.objectParameters[parameter]!));
    if (!subjects.some(parameter => digest(supplied[parameter]) === digest(ref))) throw new Error('Interface action must bind the selected object');
    return { action: mapping.action, input: Object.fromEntries(Object.entries(mapping.parameters).map(([alias, local]) => [local, supplied[alias]])) };
  }
}
