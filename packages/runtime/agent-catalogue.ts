import { PermissionDenied } from '../core/identity.js';
import { businessAgentProfiles, historicalAgentSandboxResources, sandboxAgentCapability, type AgentProfile } from '../ontology/agent-profiles.js';
import type { Ontology } from '../ontology/model.js';
import { resourceGroups } from '../ontology/resource-mapping.js';
import type { Task } from './tasks.js';
import type { Access } from './access.js';

const sandboxActions = new Set(historicalAgentSandboxResources.actions);
const sandboxFunctions = new Set([...sandboxActions].map(name => name[0]!.toLowerCase() + name.slice(1)));
sandboxFunctions.add('readDiningReservation');
const sandboxObjects = new Set(historicalAgentSandboxResources.objects);

function testCapability(model: Ontology, kind: string, name: string): boolean {
  const definition = kind === 'action' ? model.actions.get(name)
    : kind === 'function' ? model.functions.get(name) : kind === 'object' ? model.objects.get(name) : undefined;
  if (definition?.typeClasses?.some(tag => tag.kind === sandboxAgentCapability.kind && tag.name === sandboxAgentCapability.name))
    return true;
  return (kind === 'action' && (sandboxActions.has(name) ||
    testCapability(model, 'function', model.actions.get(name)?.function ?? '')))
    || (kind === 'function' && sandboxFunctions.has(name))
    || (kind === 'object' && sandboxObjects.has(name));
}

export function checkAgentCapability(model: Ontology, sandbox: boolean, kind: 'action' | 'function', name: string) {
  if (!sandbox && testCapability(model, kind, name)) throw new PermissionDenied('Capability requires a sandbox Agent');
}

type Candidate = { apiName: string; description?: string };

function namedScope(model: Ontology, names: Iterable<string>): (kind: string, name: string) => boolean {
  const selected = new Set(names);
  const includeTarget = (target: string) => selected.add(target);
  for (const name of [...selected]) {
    const iface = model.interfaces.get(name);
    if (!iface) continue;
    for (const object of model.objects.values()) {
      const mapping = object.interfaces[name];
      if (!mapping) continue;
      selected.add(object.apiName);
      for (const action of Object.values(mapping.actions)) selected.add(action.action);
    }
  }
  for (const name of [...selected]) {
    const action = model.actions.get(name), source = model.sources.get(name), link = model.links.get(name);
    if (action) {
      if (action.function) selected.add(action.function);
      Object.values(action.objectParameters).forEach(includeTarget);
      if (action.result) selected.add(action.result.type);
    }
    if (source) {
      selected.add(source.objectType);
      selected.add(source.function);
    }
    if (link) {
      selected.add(link.from.type);
      selected.add(link.to.type);
    }
  }
  for (const link of model.links.values())
    if (selected.has(link.from.type) && selected.has(link.to.type)) selected.add(link.apiName);
  return (_kind, name) => selected.has(name);
}

const profileNames = (profile: AgentProfile) => [
  ...(profile.objects ?? []), ...(profile.interfaces ?? []), ...(profile.actions ?? []),
  ...(profile.functions ?? []), ...(profile.sources ?? []), ...(profile.links ?? []),
];

export function taskCatalogueScope(model: Ontology, access: Access, input: Task['input'],
  additional: { profiles: readonly string[]; resources: readonly string[] } = { profiles: [], resources: [] }) {
  // Release 30 predates profile metadata. Keep its common routes discoverable for queued tasks.
  const profiles = model.resolvedDocument.agentProfiles ??
    (model.document.id === 'Eigos' && model.document.version === '30' ? businessAgentProfiles : []);
  const message = input.message.toLowerCase();
  const matched = profiles.filter(profile =>
    access.canDefine(model, 'agentProfile', profile.apiName) &&
    (profile.terms.some(term => message.includes(term.toLowerCase())) ||
      profile.apiName === 'RideQuote' && Boolean(input.route) ||
      additional.profiles.includes(profile.apiName)));
  if (matched.length) {
    return { profiles: matched, include: namedScope(model, [...matched.flatMap(profileNames), ...additional.resources]) };
  }
  const eligible = [...model.objects.values(), ...model.functions.values(), ...model.actions.values()]
    .filter(item => !('edits' in item && item.edits))
    .map(item => ({ item, rank: rank(item, message) }))
    .sort((left, right) => right.rank - left.rank);
  const candidates = eligible.slice(0, 16).map(({ item }) => item.apiName);
  return { profiles: matched, include: namedScope(model, [...candidates, ...additional.resources]) };
}

function rank(item: Candidate, message: string) {
  const name = item.apiName.toLowerCase();
  if (message.includes(name)) return 100;
  const context = `${name} ${item.description?.toLowerCase() ?? ''}`;
  const terms = new Set(message.match(/\p{L}[\p{L}\p{N}]{2,}/gu) ?? []);
  return [...terms].filter(term => context.includes(term)).length;
}

export function catalogue(model: Ontology, access: Access, sandbox: boolean,
  include = (_kind: string, _name: string) => true, compact = false) {
  const document = access.describe(model, true, (kind, name) =>
    include(kind, name) && (sandbox || !testCapability(model, kind, name)));
  const summary = ({ apiName, description }: Candidate) => ({ apiName, description: description?.slice(0, 220) });
  return {
    definition: model.digest,
    interfaces: compact ? document.interfaceTypes.map(summary) :
      document.interfaceTypes.map(({ apiName, description, actions, links }) => ({ apiName, description, actions, links })),
    links: compact ? document.linkTypes.map(summary) : document.linkTypes,
    objects: document.objectTypes.map(({ apiName, description, interfaces }) => ({ apiName, description, ...(compact ? {} : { interfaces }) })),
    functions: compact ? document.functionTypes.filter(fn => !fn.edits).map(summary) :
      document.functionTypes.filter(fn => !fn.edits).map(({ apiName, description, parameters }) => ({ apiName, description, parameters })),
    actions: compact ? document.actionTypes.map(summary) :
      document.actionTypes.map(({ apiName, description, parameters, objectParameters, submissionCriteria, result }) =>
        ({ apiName, description, parameters, objectParameters, submissionCriteria, result })),
    dataSources: compact ? document.dataSources.map(summary) :
      document.dataSources.map(({ apiName, objectType, function: fn }) => ({ apiName, objectType, function: fn })),
  };
}

export function describeAgentResources(model: Ontology, access: Access, sandbox: boolean, names: string[]) {
  const selected = new Set(names), supporting = namedScope(model, names);
  const document = access.describe(model, true, (kind, name) =>
    supporting(kind, name) && (sandbox || !testCapability(model, kind, name)));
  return Object.values(resourceGroups).flatMap(field =>
    (document[field] as Candidate[] | undefined)?.filter(item => selected.has(item.apiName)) ?? []);
}
