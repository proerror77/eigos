import { Conflict, digest } from '../core/identity.js';
import type { FunctionDependencies, OntologyDocument } from '../ontology/schema.js';
import { legacySourceEvidence } from '../ontology/source-evidence.js';
import type { PublishedOntology } from './metadata.js';

const propertyContract = ({schema, required, derived}: OntologyDocument['objectTypes'][number]['properties'][string]) => ({schema, required, derived});
const actionContract = ({parameters, objectParameters, submissionCriteria, rules, result, function: fn, effects}: OntologyDocument['actionTypes'][number]) =>
  ({parameters, objectParameters, submissionCriteria, rules, result, function: fn, effects});
const functionContract = ({parameters, returns, source, edits, version}: OntologyDocument['functionTypes'][number]) =>
  ({parameters, returns, source, edits, version});

/** Check the published dependencies of a saved workflow before invoking its first tool. */
export function checkWorkflowDependencies(previous: PublishedOntology, current: PublishedOntology, roots: FunctionDependencies, unscopedInterfaces: ReadonlySet<string>) {
  const seen = new Set<string>();
  const resources = (model: PublishedOntology) => ({
    actions: model.actions, functions: model.functions, dataSources: model.sources,
    objectTypes: model.objects, interfaceTypes: model.interfaces, linkTypes: model.links,
  });
  const before = resources(previous), after = resources(current);
  const check = (kind: keyof FunctionDependencies, name: string, compatible: boolean) => {
    if (!compatible) throw new Conflict(`Ontology workflow dependency changed: ${kind}/${name}`);
  };
  function visit(kind: keyof FunctionDependencies, name: string) {
    const key = `${kind}/${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    check(kind, name, before[kind].has(name) && after[kind].has(name));
    if (kind === 'objectTypes' || kind === 'interfaceTypes') {
      const old = before[kind].get(name)!, next = after[kind].get(name)!;
      for (const [field, property] of Object.entries(old.properties)) {
        const candidate = next.properties[field];
        const actual = candidate && propertyContract(candidate);
        check(kind, `${name}.${field}`, Object.hasOwn(next.properties, field) &&
          (digest(propertyContract(property)) === digest(actual) || field === 'evidence' && !!actual &&
            digest(propertyContract(property)) === digest({ ...actual, schema: legacySourceEvidence(actual.schema) })));
      }
      if ('primaryKey' in old && 'primaryKey' in next) {
        check(kind, name, old.primaryKey === next.primaryKey &&
          Object.entries(old.interfaces).every(([alias, mapping])=>Object.hasOwn(next.interfaces, alias) &&
            digest(mapping) === digest(next.interfaces[alias])) &&
          Object.entries(next.properties).every(([field, property])=>!property.required || Object.hasOwn(old.properties, field)));
      }
      if ('actions' in old && 'actions' in next) {
        check(kind, name, digest({links:old.links, actions:old.actions, optional:old.optionalProperties}) ===
          digest({links:next.links, actions:next.actions, optional:next.optionalProperties}));
        const beforeTypes = previous.concreteTypes(name), afterTypes = new Set(current.concreteTypes(name));
        // A concrete Link or Action stays scoped to its existing implementation. An unscoped
        // Interface query can pick a different result when a new implementation is published.
        check(kind, name, beforeTypes.every(type => afterTypes.has(type)) &&
          (!unscopedInterfaces.has(name) || beforeTypes.length === afterTypes.size));
        beforeTypes.forEach(type=>visit('objectTypes', type));
      }
      return;
    }
    if (kind === 'functions') {
      const old = before.functions.get(name)!;
      const next = after.functions.get(name)!;
      const binding = previous.bindings.functions[name];
      const previousContract = digest(functionContract(old)), nextContract = functionContract(next);
      check(kind, name, !!binding && !!current.bindings.functions[name] &&
        (previousContract === digest(nextContract) ||
          previousContract === digest({ ...nextContract, returns: legacySourceEvidence(next.returns) })) &&
        (!old.version || binding === current.bindings.functions[name]));
      add(old.dependencies ?? {});
      add(next.dependencies ?? {});
      return;
    }
    if (kind === 'dataSources') {
      const source = before.dataSources.get(name)!;
      const binding = previous.bindings.sources[name];
      check(kind, name, !!binding && binding === current.bindings.sources[name]);
      visit('functions', source.function);
      visit('objectTypes', source.objectType);
      return;
    }
    if (kind === 'actions') {
      const action = previous.action(name);
      check(kind, name, digest(actionContract(action)) === digest(actionContract(current.action(name))));
      for (const type of Object.values(action.objectParameters)) visit(previous.interfaces.has(type) ? 'interfaceTypes' : 'objectTypes', type);
      for (const fn of [action.function, ...action.submissionCriteria.map(criterion=>criterion.function)])
        if (fn) visit('functions', fn);
      return;
    }
    const {from, to} = before.linkTypes.get(name)!;
    const next = after.linkTypes.get(name)!;
    check(kind, name, digest({from,to}) === digest({from:next.from,to:next.to}));
  }
  function add(dependencies: FunctionDependencies) {
    for (const [kind, names] of Object.entries(dependencies))
      for (const name of names) visit(kind as keyof FunctionDependencies, name);
  }
  add(roots);
}
