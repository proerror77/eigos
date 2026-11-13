import { z } from 'zod';
import { OntologyDataMigrations } from './ontology-migrations.js';
export { migrateOntologyDataSchema, readDataMigrationSchema } from './ontology-migrations.js';
import { Conflict, digest } from '../core/identity.js';
import { Ontology } from '../ontology/model.js';
import { ontologyName, ontologySchema, type OntologyDocument } from '../ontology/schema.js';
import {
  remapResources,
  resourceGroups,
  type ResourceKind,
  type ResourceNameMap,
} from '../ontology/resource-mapping.js';
import { Access } from './access.js';
import type { Database } from './database.js';
import { Governance } from './governance.js';
import { Metadata, type Bindings } from './metadata.js';

const kinds = Object.keys(resourceGroups) as [ResourceKind, ...ResourceKind[]];
export const ontologyResourceSchema = z.strictObject({
  kind: z.enum(kinds),
  name: ontologyName,
  version: z.string().min(1).optional(),
});
type Resource = z.infer<typeof ontologyResourceSchema>;
export const exportPackageSchema = z.strictObject({
  ontology: ontologyName,
  resources: z.array(ontologyResourceSchema).min(1).max(200),
});
export const ontologyPackageSchema = z.strictObject({
  format: z.literal('eigos-ontology-package-v1'),
  ontology: ontologyName,
  version: z.string().min(1),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  document: ontologySchema,
});
export const importPackageSchema = z.strictObject({
  targetOntology: ontologyName,
  namespace: ontologyName,
  package: ontologyPackageSchema,
  branchName: z.string().min(1).max(200),
  project: ontologyName.optional(),
  mode: z.enum(['shared', 'copy']).default('shared'),
});
const mappingSchema = z.partialRecord(z.enum(kinds), z.record(ontologyName, ontologyName));
export const migrateDefinitionsSchema = exportPackageSchema.extend({
  targetOntology: ontologyName,
  mapping: mappingSchema,
  branchName: z.string().min(1).max(200),
  project: ontologyName.optional(),
});

const identity = (ref: Resource) =>
  ref.kind + '/' + ref.name + (ref.kind === 'valueType' ? '@' + ref.version : '');
function resourceIndex(document: OntologyDocument) {
  const index = new Map<string, { ref: Resource; value: Record<string, any> }>();
  for (const [kind, field] of Object.entries(resourceGroups) as [
    ResourceKind,
    (typeof resourceGroups)[ResourceKind],
  ][]) {
    for (const value of document[field] ?? []) {
      const ref: Resource = {
        kind,
        name: value.apiName,
        ...(kind === 'valueType' && 'version' in value ? { version: String(value.version) } : {}),
      };
      const key = identity(ref);
      if (index.has(key)) throw new Conflict('Duplicate package resource ' + key);
      index.set(key, { ref, value });
    }
  }
  return index;
}
function dependencies(model: Ontology, ref: Resource, value: Record<string, any>): Resource[] {
  const result: Resource[] = [];
  const add = (kind: ResourceKind, name: string, version?: string) =>
    result.push({ kind, name, ...(version ? { version } : {}) });
  const target = (name: string) => add(model.interfaces.has(name) ? 'interface' : 'object', name);
  const schema = (node: unknown) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const definition = node as Record<string, any>;
    if (definition.valueType) add('valueType', definition.valueType.name, definition.valueType.version);
    for (const key of ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'])
      for (const value of Object.values(definition[key] ?? {})) schema(value);
    for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems'])
      for (const value of definition[key] ?? []) schema(value);
    for (const key of [
      'items',
      'additionalProperties',
      'contains',
      'not',
      'if',
      'then',
      'else',
      'propertyNames',
    ])
      schema(definition[key]);
  };
  const expression = (node: Record<string, any>, objectType?: string) => {
    if (node.op === 'linked' && objectType) {
      let type = objectType;
      for (const hop of node.path) {
        if (hop.as) add('interface', hop.as);
        const nav = model.navigation(type, hop.link, hop.as);
        add('link', nav.link);
        add('object', nav.target);
        type = nav.target;
      }
    }
    if (node.left) {
      expression(node.left, objectType);
      expression(node.right, objectType);
    }
  };
  const property = (definition: Record<string, any>) => {
    if (definition.sharedProperty) add('sharedProperty', definition.sharedProperty);
    if (definition.valueType) add('valueType', definition.valueType.name, definition.valueType.version);
    if (definition.struct) add('struct', definition.struct.type);
    schema(definition.schema);
  };
  if (ref.kind === 'object') {
    Object.values(value.properties).forEach((item) => property(item as Record<string, any>));
    // Shared properties may supply the expression, whose Link names resolve on this concrete type.
    for (const definition of Object.values(model.object(ref.name).properties)) {
      if (definition.derived) expression(definition.derived, ref.name);
    }
    for (const group of value.groups ?? []) add('group', group);
    for (const [name, mapping] of Object.entries(value.interfaces) as [string, any][]) {
      add('interface', name);
      for (const link of Object.values(mapping.links) as string[])
        add('link', model.navigation(ref.name, link).link);
      for (const action of Object.values(mapping.actions) as { action: string }[])
        add('action', action.action);
    }
  }
  if (ref.kind === 'interface') {
    for (const parent of value.extends ?? []) add('interface', parent);
    Object.values(value.properties).forEach((item) => property(item as Record<string, any>));
    for (const link of Object.values(value.links) as { target: string }[]) target(link.target);
    for (const action of Object.values(value.actions) as {
      parameters: unknown;
      objectParameters: Record<string, string>;
    }[]) {
      schema(action.parameters);
      Object.values(action.objectParameters).forEach(target);
    }
  }
  if (ref.kind === 'link') {
    add('object', value.from.type);
    add('object', value.to.type);
  }
  if (ref.kind === 'function') {
    if (!Object.hasOwn(value, 'dependencies'))
      throw new Conflict('Function packaging requires declared resource dependencies: ' + ref.name);
    const kinds = {
      objectTypes: 'object',
      interfaceTypes: 'interface',
      linkTypes: 'link',
      functions: 'function',
      dataSources: 'datasource',
      actions: 'action',
    } as const;
    for (const [field, kind] of Object.entries(kinds))
      for (const name of value.dependencies[field] ?? []) add(kind, name);
    schema(value.parameters);
    schema(value.returns);
  }
  if (ref.kind === 'action') {
    schema(value.parameters);
    Object.values(value.objectParameters as Record<string, string>).forEach(target);
    if (value.function) add('function', value.function);
    for (const condition of value.submissionCriteria) add('function', condition.function);
    if (value.result) add('object', value.result.type);
    for (const rule of value.rules ?? []) {
      if (rule.op === 'createObject') add('object', rule.object.type);
      if (rule.op === 'addLink' || rule.op === 'removeLink') {
        add('link', rule.link);
        add('object', rule.from.type);
        add('object', rule.to.type);
      }
      if (rule.op === 'applyScenario') {
        for (const name of rule.objectTypes) add('object', name);
        for (const name of rule.linkTypes) add('link', name);
      }
    }
  }
  if (ref.kind === 'datasource') {
    add('object', value.objectType);
    add('function', value.function);
  }
  if (ref.kind === 'sharedProperty') property(value);
  if (ref.kind === 'valueType') schema(value.schema);
  if (ref.kind === 'struct') Object.values(value.fields).forEach(schema);
  if (ref.kind === 'group') for (const name of value.objectTypes) add('object', name);
  return result;
}

export class OntologyPackages {
  private readonly governance: Governance;
  constructor(
    private readonly db: Database,
    private readonly metadata: Metadata,
    bindings: Bindings,
  ) {
    this.governance = new Governance(db, metadata, bindings);
  }
  async export(access: Access, raw: unknown) {
    const input = exportPackageSchema.parse(raw),
      model = await this.metadata.active(input.ontology);
    const index = resourceIndex(model.resourceDocument),
      selected = new Set<string>(),
      pending = [...input.resources];
    while (pending.length) {
      const reference = pending.pop()!,
        key = identity(reference);
      if (selected.has(key)) continue;
      const entry = index.get(key);
      if (!entry) throw new Conflict('Unknown package resource ' + key);
      access.definition(
        model,
        reference.kind,
        reference.kind === 'valueType' ? reference.name + '@' + reference.version : reference.name,
      );
      selected.add(key);
      pending.push(...dependencies(model, reference, entry.value));
    }
    const document: OntologyDocument = {
      id: model.document.id,
      version: model.document.version,
      objectTypes: [],
      interfaceTypes: [],
      linkTypes: [],
      functionTypes: [],
      actionTypes: [],
      dataSources: [],
    };
    for (const key of selected) {
      const entry = index.get(key)!,
        field = resourceGroups[entry.ref.kind];
      if (!document[field]) Object.assign(document, { [field]: [] });
      (document[field] as unknown[]).push(structuredClone(entry.value));
    }
    const validated = new Ontology(document);
    await access.refresh();
    return {
      format: 'eigos-ontology-package-v1' as const,
      ontology: input.ontology,
      version: document.version,
      digest: validated.digest,
      document: validated.document,
    };
  }
  private verify(raw: unknown) {
    const packet = ontologyPackageSchema.parse(raw),
      model = new Ontology(packet.document);
    if (
      model.document.id !== packet.ontology ||
      model.document.version !== packet.version ||
      model.digest !== packet.digest
    )
      throw new Conflict('Ontology package identity or digest differs');
    return { packet, model };
  }
  async import(access: Access, raw: unknown) {
    const input = importPackageSchema.parse(raw),
      { packet, model } = this.verify(input.package);
    const target = await this.metadata.active(input.targetOntology),
      body = structuredClone(target.document);
    if (input.mode === 'shared')
      body.imports = [
        ...(body.imports ?? []),
        {
          ontology: packet.ontology,
          version: packet.version,
          digest: packet.digest,
          namespace: input.namespace,
          document: packet.document,
        },
      ];
    else {
      const names: ResourceNameMap = {};
      for (const entry of resourceIndex(model.resourceDocument).values())
        (names[entry.ref.kind] ??= {})[entry.ref.name] = ontologyName.parse(input.namespace + entry.ref.name);
      this.append(body, remapResources(model.resourceDocument, body.id, names));
    }
    new Ontology(body);
    return this.governance.create(access, {
      ontology: body.id,
      project: input.project,
      name: input.branchName,
      body,
    });
  }
  private append(target: OntologyDocument, incoming: OntologyDocument) {
    const existing = resourceIndex(new Ontology(target).resourceDocument);
    for (const [key, entry] of resourceIndex(incoming)) {
      if (existing.has(key)) throw new Conflict('Imported resource collides with target ' + key);
      const field = resourceGroups[entry.ref.kind];
      if (!target[field]) Object.assign(target, { [field]: [] });
      (target[field] as unknown[]).push(entry.value);
    }
  }
  async migrateData(access: Access, raw: unknown) {
    return new OntologyDataMigrations(this.db, this.metadata).copy(access, raw);
  }
  async migrationReceipt(access: Access, raw: unknown) {
    return new OntologyDataMigrations(this.db, this.metadata).read(access, raw);
  }
  async migrate(access: Access, raw: unknown) {
    const input = migrateDefinitionsSchema.parse(raw);
    if (input.ontology === input.targetOntology)
      throw new Conflict('Definition migration requires distinct Ontologies');
    const packet = await this.export(access, { ontology: input.ontology, resources: input.resources });
    const selected = resourceIndex(packet.document);
    for (const entry of selected.values())
      if (!input.mapping[entry.ref.kind]?.[entry.ref.name])
        throw new Conflict('Migration needs an explicit target name for every dependency');
    for (const [kind, names] of Object.entries(input.mapping))
      for (const name of Object.keys(names))
        if (![...selected.values()].some((entry) => entry.ref.kind === kind && entry.ref.name === name))
          throw new Conflict('Migration map names an unknown source resource');
    const target = await this.metadata.active(input.targetOntology),
      body = structuredClone(target.document);
    this.append(body, remapResources(packet.document, body.id, input.mapping));
    new Ontology(body);
    return this.governance.create(access, {
      ontology: body.id,
      project: input.project,
      name: input.branchName,
      body,
    });
  }
}
