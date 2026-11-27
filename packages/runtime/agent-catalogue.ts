import { z } from 'zod';
import { PermissionDenied } from '../core/identity.js';
type AgentProfile = NonNullable<OntologyDocument['agentProfiles']>[number];
import { isSandboxResource } from '../ontology/sandbox.js';
import type { Ontology } from '../ontology/model.js';
import { resourceGroups } from '../ontology/resource-mapping.js';
import type { OntologyDocument } from '../ontology/schema.js';
import type { Task } from './tasks.js';
import type { Access } from './access.js';

export function checkAgentCapability(model: Ontology, sandbox: boolean, kind: 'action' | 'function', name: string) {
  if (!sandbox && isSandboxResource(model, kind, name)) throw new PermissionDenied('Capability requires a sandbox Agent');
}

type Candidate = { apiName: string; description?: string; displayName?: string };
const wordSegmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const normalize = (text: string) => text.normalize('NFKC').toLowerCase();

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

export function taskCatalogueScope(model: Ontology, access: Pick<Access, 'canDefine'>, input: Task['input'],
  additional: { profiles: readonly string[]; resources: readonly string[] } = { profiles: [], resources: [] },
  legacyProfiles: readonly AgentProfile[] = []) {
  // Releases 30 and 31 predate profile metadata. Keep their common routes discoverable.
  const profiles = model.resolvedDocument.agentProfiles ??
    (model.document.id === 'Eigos' && ['30', '31'].includes(model.document.version) ? legacyProfiles : []);
  const message = normalize(input.message);
  const matched = profiles.filter(profile =>
    access.canDefine(model, 'agentProfile', profile.apiName) &&
    (profile.terms.some(term => message.includes(normalize(term))) ||
      profile.apiName === 'RideQuote' && Boolean(input.route) ||
      additional.profiles.includes(profile.apiName)));
  if (matched.length) {
    return { profiles: matched, include: namedScope(model, [...matched.flatMap(profileNames), ...additional.resources]) };
  }
  const terms = new Set([...wordSegmenter.segment(message)]
    .filter(({ segment, isWordLike }) => isWordLike && segment.length >= (/\p{Script=Han}/u.test(segment) ? 2 : 3))
    .map(({ segment }) => segment));
  const eligible = [...model.objects.values(), ...model.functions.values(), ...model.actions.values()]
    .filter(item => !('edits' in item && item.edits))
    .map(item => ({ item, rank: rank(item, message, terms) }))
    .sort((left, right) => right.rank - left.rank);
  const candidates = eligible.slice(0, 16).map(({ item }) => item.apiName);
  return { profiles: matched, include: namedScope(model, [...candidates, ...additional.resources]) };
}

function rank(item: Candidate, message: string, terms: ReadonlySet<string>) {
  const name = normalize(item.apiName);
  if (message.includes(name)) return Number.MAX_SAFE_INTEGER;
  const description = normalize(`${item.displayName ?? ''} ${item.description ?? ''}`);
  let score = 0;
  for (const term of terms) score += name.includes(term) ? 2 : Number(description.includes(term));
  return score;
}

export const discoveryOptions = z.strictObject({
  query: z.string().trim().min(1).max(200).optional(),
  names: z.array(z.string().trim().min(1).max(160)).min(1).max(16).optional(),
});

export function discoverOntology(model: Ontology, document: OntologyDocument,
  { query, names }: z.infer<typeof discoveryOptions>) {
  const resources = Object.entries(resourceGroups).flatMap(([kind, field]) =>
    (document[field] ?? []).map(definition => ({
      kind, apiName: definition.apiName, definition,
    })));
  const publication = { ontology: document.id, version: document.version, definition: model.digest };
  if (names) {
    const selected = new Set(names);
    return { ...publication, resources: resources.filter(({ apiName }) => selected.has(apiName)) };
  }
  const message = normalize(query ?? '');
  const terms = new Set([...wordSegmenter.segment(message)]
    .filter(({ isWordLike }) => isWordLike)
    .map(({ segment }) => segment));
  return {
    ...publication,
    resources: resources.map(({ kind, apiName, definition }) => ({
      kind, apiName,
      description: 'description' in definition ? definition.description?.slice(0, 220) : undefined,
      score: rank(definition, message, terms),
    })).filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 16)
      .map(({ kind, apiName, description }) => ({ kind, apiName, description })),
  };
}

/** The API names an identity can see, grouped by resource kind, for a client that then searches or names them. */
export function ontologyIndex(model: Ontology, document: OntologyDocument) {
  const catalogue = Object.fromEntries(Object.entries(resourceGroups)
    .map(([kind, field]) => [kind, (document[field] ?? []).map(definition => definition.apiName)] as const)
    .filter(([, names]) => names.length));
  return {
    ontology: document.id, version: document.version, definition: model.digest, catalogue,
    next: 'Pass query to search names and descriptions, or names (up to 16) to read exact contracts.',
  };
}

export function catalogue(model: Ontology, access: Access, sandbox: boolean,
  include = (_kind: string, _name: string) => true, compact = false) {
  const document = access.describe(model, true, (kind, name) =>
    include(kind, name) && (sandbox || !isSandboxResource(model, kind, name)));
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
    supporting(kind, name) && (sandbox || !isSandboxResource(model, kind, name)));
  return Object.values(resourceGroups).flatMap(field =>
    (document[field] as Candidate[] | undefined)?.filter(item => selected.has(item.apiName)) ?? []);
}
