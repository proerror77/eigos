import { digest } from '../core/identity.js';
import { ontologyName, ontologySchema, type OntologyDocument } from './schema.js';

export const resourceGroups = {
  object: 'objectTypes',
  interface: 'interfaceTypes',
  link: 'linkTypes',
  function: 'functionTypes',
  action: 'actionTypes',
  datasource: 'dataSources',
  sharedProperty: 'sharedProperties',
  valueType: 'valueTypes',
  struct: 'structTypes',
  group: 'typeGroups',
} as const;
export type ResourceKind = keyof typeof resourceGroups;
export type ResourceNameMap = Partial<Record<ResourceKind, Record<string, string>>>;

export function remapResources(
  input: OntologyDocument,
  ontology: string,
  names: ResourceNameMap,
): OntologyDocument {
  const document = structuredClone(input);
  document.id = ontologyName.parse(ontology);
  const rename = (kind: ResourceKind, name: string) => ontologyName.parse(names[kind]?.[name] ?? name);
  const reference = (name: string) =>
    input.interfaceTypes.some((type) => type.apiName === name)
      ? rename('interface', name)
      : rename('object', name);
  const schema = (value: unknown): unknown => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const result = structuredClone(value) as Record<string, any>;
    if (result.valueType) result.valueType.name = rename('valueType', result.valueType.name);
    for (const field of ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']) {
      if (result[field])
        result[field] = Object.fromEntries(
          Object.entries(result[field]).map(([key, child]) => [key, schema(child)]),
        );
    }
    for (const field of ['allOf', 'anyOf', 'oneOf', 'prefixItems'])
      if (Array.isArray(result[field])) result[field] = result[field].map(schema);
    for (const field of [
      'items',
      'additionalProperties',
      'contains',
      'not',
      'if',
      'then',
      'else',
      'propertyNames',
    ])
      if (result[field] && typeof result[field] === 'object') result[field] = schema(result[field]);
    // Typed ObjectRef schemas carry a resource name in their type discriminator.
    if (result.properties?.id && result.properties?.type) {
      const discriminator = result.properties.type;
      const known = (name: unknown) =>
        typeof name === 'string' &&
        (input.objectTypes.some((type) => type.apiName === name) ||
          input.interfaceTypes.some((type) => type.apiName === name));
      if (known(discriminator.const)) discriminator.const = reference(discriminator.const);
      if (Array.isArray(discriminator.enum))
        discriminator.enum = discriminator.enum.map((name: unknown) =>
          known(name) ? reference(String(name)) : name,
        );
    }
    return result;
  };
  const property = (value: OntologyDocument['objectTypes'][number]['properties'][string]) => {
    if (value.sharedProperty) value.sharedProperty = rename('sharedProperty', value.sharedProperty);
    if (value.valueType) value.valueType.name = rename('valueType', value.valueType.name);
    if (value.struct) value.struct.type = rename('struct', value.struct.type);
    value.schema = schema(value.schema) as Record<string, unknown>;
    const derived = (expression: NonNullable<typeof value.derived>) => {
      if (expression.op === 'linked')
        for (const hop of expression.path) if (hop.as) hop.as = rename('interface', hop.as);
      if ('left' in expression) {
        derived(expression.left);
        derived(expression.right);
      }
    };
    if (value.derived) derived(value.derived);
  };
  for (const type of document.objectTypes) {
    type.apiName = rename('object', type.apiName);
    Object.values(type.properties).forEach(property);
    type.groups = type.groups?.map((name) => rename('group', name));
    type.interfaces = Object.fromEntries(
      Object.entries(type.interfaces).map(([name, mapping]) => {
        for (const action of Object.values(mapping.actions)) action.action = rename('action', action.action);
        return [rename('interface', name), mapping];
      }),
    );
  }
  for (const type of document.interfaceTypes) {
    type.apiName = rename('interface', type.apiName);
    type.extends = type.extends?.map((name) => rename('interface', name));
    Object.values(type.properties).forEach(property);
    for (const link of Object.values(type.links)) link.target = reference(link.target);
    for (const action of Object.values(type.actions)) {
      action.parameters = schema(action.parameters) as Record<string, unknown>;
      action.objectParameters = Object.fromEntries(
        Object.entries(action.objectParameters).map(([name, target]) => [name, reference(target)]),
      );
    }
  }
  for (const link of document.linkTypes) {
    link.apiName = rename('link', link.apiName);
    link.from.type = rename('object', link.from.type);
    link.to.type = rename('object', link.to.type);
  }
  for (const fn of document.functionTypes) {
    fn.apiName = rename('function', fn.apiName);
    fn.parameters = schema(fn.parameters) as Record<string, unknown>;
    fn.returns = schema(fn.returns) as Record<string, unknown>;
    if (fn.dependencies) {
      const kinds = {
        objectTypes: 'object',
        interfaceTypes: 'interface',
        linkTypes: 'link',
        functions: 'function',
        dataSources: 'datasource',
        actions: 'action',
      } as const;
      for (const field of Object.keys(kinds) as (keyof typeof kinds)[])
        if (fn.dependencies[field])
          fn.dependencies[field] = fn.dependencies[field]!.map((name) => rename(kinds[field], name));
    }
  }
  for (const action of document.actionTypes) {
    action.apiName = rename('action', action.apiName);
    action.parameters = schema(action.parameters) as Record<string, unknown>;
    action.objectParameters = Object.fromEntries(
      Object.entries(action.objectParameters).map(([name, target]) => [name, reference(target)]),
    );
    if (action.function) action.function = rename('function', action.function);
    for (const condition of action.submissionCriteria)
      condition.function = rename('function', condition.function);
    if (action.result) action.result.type = rename('object', action.result.type);
    for (const rule of action.rules ?? []) {
      if (rule.op === 'createObject') rule.object.type = rename('object', rule.object.type);
      if (rule.op === 'addLink' || rule.op === 'removeLink') {
        rule.link = rename('link', rule.link);
        rule.from.type = rename('object', rule.from.type);
        rule.to.type = rename('object', rule.to.type);
      }
      if (rule.op === 'applyScenario') {
        rule.objectTypes = rule.objectTypes.map((name) => rename('object', name));
        rule.linkTypes = rule.linkTypes.map((name) => rename('link', name));
      }
    }
  }
  for (const source of document.dataSources) {
    source.apiName = rename('datasource', source.apiName);
    source.objectType = rename('object', source.objectType);
    source.function = rename('function', source.function);
  }
  for (const shared of document.sharedProperties ?? []) {
    shared.apiName = rename('sharedProperty', shared.apiName);
    property(shared);
  }
  for (const value of document.valueTypes ?? []) {
    value.apiName = rename('valueType', value.apiName);
    value.schema = schema(value.schema) as Record<string, unknown>;
  }
  for (const struct of document.structTypes ?? []) {
    struct.apiName = rename('struct', struct.apiName);
    struct.fields = Object.fromEntries(
      Object.entries(struct.fields).map(([name, field]) => [name, schema(field)]),
    ) as typeof struct.fields;
  }
  for (const group of document.typeGroups ?? []) {
    group.apiName = rename('group', group.apiName);
    group.objectTypes = group.objectTypes.map((name) => rename('object', name));
  }
  delete document.imports;
  return ontologySchema.parse(document);
}

/** Imports are immutable definition snapshots. Expansion performs no network or credential access. */
export function expandImports(input: OntologyDocument, depth = 0): OntologyDocument {
  if (depth > 8) throw new Error('Ontology import depth exceeds eight');
  const document = structuredClone(input);
  delete document.imports;
  const namespaces = new Set<string>();
  for (const imported of input.imports ?? []) {
    if (namespaces.has(imported.namespace)) throw new Error('Duplicate import namespace');
    namespaces.add(imported.namespace);
    const snapshot = ontologySchema.parse(imported.document);
    if (
      snapshot.id !== imported.ontology ||
      snapshot.version !== imported.version ||
      digest(snapshot) !== imported.digest
    )
      throw new Error('Ontology import version or digest differs');
    const expanded = expandImports(snapshot, depth + 1),
      mapping: ResourceNameMap = {};
    for (const [kind, field] of Object.entries(resourceGroups) as [
      ResourceKind,
      (typeof resourceGroups)[ResourceKind],
    ][]) {
      mapping[kind] = Object.fromEntries(
        (expanded[field] ?? []).map((entry) => [
          entry.apiName,
          ontologyName.parse(imported.namespace + entry.apiName),
        ]),
      );
    }
    const remapped = remapResources(expanded, input.id, mapping);
    for (const field of Object.values(resourceGroups)) {
      const values = remapped[field];
      if (!values?.length) continue;
      const existing = document[field] ?? [];
      for (const item of values)
        if (
          existing.some(
            (old) =>
              old.apiName === item.apiName &&
              (field !== 'valueTypes' ||
                ('version' in old && 'version' in item && old.version === item.version)),
          )
        )
          throw new Error('Imported Ontology resource collides with a local definition');
      (document[field] as unknown[]) = [...existing, ...values];
    }
  }
  return document;
}
