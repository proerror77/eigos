import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { digest } from '../core/delegation.js';
import { filterRelationshipMetadata } from '../ontology/model.js';
import type { FunctionDefinition, OntologyModel, PropertyDefinition } from '../ontology/model.js';
import type { JsonSchema } from '../ontology/definition-contracts.js';
import { functionCallSchema } from '../ontology/object-functions.js';
import type { AgentAccessGrant } from './store.js';
import { assertReviewedModel } from './model-review.js';
import { SecurityError } from './errors.js';
import { functionValueProjectionSchema } from './projections.js';
import { paDiscoverySelection, paDefinitionLinks, withPaTaskDomains, type PaDiscoveryInput } from '../ontology/pa-classification-contract.js';

export interface DefinitionAccess {
  readonly model: OntologyModel;
  readonly parent: Pick<AgentAccessGrant, 'resources'>;
  resourceAllowed(kind: string, id: string): boolean;
  fields(type: string): Record<string, PropertyDefinition>;
  fieldPolicy(type: string, field: string): string;
}
export interface DefinitionDescriptionInput extends PaDiscoveryInput { kind?: 'types' | 'actions' | 'functions'; search?: string; linkSearch?: string; limit?: number; after?: string; actions?: string[]; functions?: string[] }

// Only immutable schema presentation is reused. Access decisions and the
// authorized catalogue are rebuilt inside each caller's current scope.
type DefinitionSchema = z.core.JSONSchema.JSONSchema;
const schemaMetadata = new WeakMap<OntologyModel, { schemas: WeakMap<z.ZodType, DefinitionSchema>; conversions: number }>();
function equivalentMetadata(pinned: Record<string, unknown>, converted: DefinitionSchema): pinned is DefinitionSchema {
  return isDeepStrictEqual(pinned, converted);
}
function metadataFor(model: OntologyModel) {
  let metadata = schemaMetadata.get(model);
  if (!metadata) { metadata = { schemas: new WeakMap(), conversions: 0 }; schemaMetadata.set(model, metadata); }
  return metadata;
}
function definitionSchema(model: OntologyModel, schema: z.ZodType, pinned?: Record<string, unknown>) {
  const metadata = metadataFor(model);
  let json = metadata.schemas.get(schema);
  if (!json) {
    const converted = z.toJSONSchema(schema);
    // Some historical compiler pins omit $schema. Preserve the previous public
    // JSON exactly unless the compiled metadata is strictly equivalent.
    json = pinned && equivalentMetadata(pinned, converted) ? structuredClone(pinned) : converted;
    metadata.schemas.set(schema, json); metadata.conversions++;
  }
  return structuredClone(json);
}

// The trusted status evaluators have these pinned result branches. Commerce
// uses an explicit type discriminator in each branch.
const statusResultTypes = new Map([
  ['registrationStatus', ['RegistrationOffer', 'RegistrationRecord']],
  ['bookingObservationStatus', ['BookingOffers', 'BookingObservation', 'BookingPaymentObservation']],
]);

function publicResultSchema(model: OntologyModel, fn: FunctionDefinition, schema: JsonSchema, typeAllowed: (id: string) => boolean) {
  const orderedTypes = statusResultTypes.get(fn.id);
  if (!orderedTypes && fn.id !== 'commerceObservationStatus') return undefined;
  if (!Array.isArray(schema.anyOf) || orderedTypes && schema.anyOf.length !== orderedTypes.length) {
    throw new SecurityError('POLICY_CHANGED');
  }
  const anyOf = (schema.anyOf as JsonSchema[]).flatMap((branch, index) => {
    const properties = branch.properties as Record<string, JsonSchema> | undefined;
    const type = orderedTypes?.[index] ?? properties?.type?.const;
    if (typeof type !== 'string' || !fn.inputTypes.includes(type) || !properties?.data) throw new SecurityError('POLICY_CHANGED');
    if (!typeAllowed(type)) return [];
    const projected = functionValueProjectionSchema(fn.id, type);
    if (!projected) throw new SecurityError('POLICY_CHANGED');
    const { $schema: _dialect, ...data } = definitionSchema(model, projected);
    return [{ ...branch, properties: { ...properties, data } }];
  });
  if (!anyOf.length) throw new SecurityError('POLICY_CHANGED');
  return { ...schema, anyOf };
}

interface AuthorizedFunctionContractFields {
  executionContract?: FunctionDefinition['executionContract'];
  readsFiltered?: true;
  resultProjection?: 'authorized_data';
}
function authorizedFunctionContract(access: DefinitionAccess, model: OntologyModel, fn: FunctionDefinition,
  typeAllowed: (id: string) => boolean): AuthorizedFunctionContractFields {
  const contract = fn.executionContract;
  if (contract?.mode !== 'validated' || contract.version !== '2') return {};
  const reads = contract.reads;
  let incompleteRelationship = false;
  const relationships = reads.relationships.filter(link => {
    if (!typeAllowed(link.type)) return false;
    const as = model.isInterface(link.type) ? link.type : undefined;
    const sources = model.concreteTypes(link.type);
    const allowed = sources.filter(type => {
      if (!typeAllowed(type)) return false;
      try {
        const navigation = model.navigation(type, link.name, as);
        return typeAllowed(navigation.other.type) && access.resourceAllowed('linkType', navigation.link.id);
      } catch { return false; }
    });
    if (allowed.length !== sources.length) incompleteRelationship = true;
    return allowed.length > 0;
  });
  const view = {
    ...reads,
    types: reads.types.filter(typeAllowed),
    relationships,
    ...(reads.objectViews ? { objectViews: reads.objectViews.filter(typeAllowed) } : {}),
    ...(reads.relationshipViews ? { relationshipViews: reads.relationshipViews.filter(typeAllowed) } : {}),
    ...(reads.linkProofs ? { linkProofs: reads.linkProofs.filter(id => {
      const link = model.link(id);
      return typeAllowed(link.from.type) && typeAllowed(link.to.type) && access.resourceAllowed('linkType', id);
    }) } : {}),
  };
  const valueSchema = publicResultSchema(model, fn, contract.valueSchema, typeAllowed);
  const filtered = incompleteRelationship || !isDeepStrictEqual(view, reads) || reads.types.some(type =>
    model.isInterface(type) && model.concreteTypes(type).some(concrete => !typeAllowed(concrete)));
  return {
    executionContract: { ...contract, reads: view, ...(valueSchema ? { valueSchema } : {}) },
    ...(filtered ? { readsFiltered: true } : {}),
    ...(valueSchema ? { resultProjection: 'authorized_data' as const } : {}),
  };
}

/** Pure startup preparation, before acquiring a publisher lease. This does not
 * select or authorize resources. Supply policy fields to include projections. */
export function prepareDefinitionMetadata(model: OntologyModel, fields: (type: string) => Record<string, PropertyDefinition> = type => model.properties(type)) {
  const metadata = metadataFor(model), before = metadata.conversions;
  let properties = 0;
  for (const type of model.typeIds()) for (const property of Object.values(fields(type))) {
    definitionSchema(model, property.schema, property.schemaMetadata); properties++;
  }
  for (const schema of functionCallSchema.options) definitionSchema(model, schema);
  return { properties, conversions: metadata.conversions - before };
}

export function authorizedDefinitionCatalogue(access: DefinitionAccess, model: OntologyModel = access.model) {
  assertReviewedModel(access.model, model);
  const policy = access, parent = access.parent;
  const reviewedType = (id: string) => { try {
    if (!model.hasType(id) || !access.model.hasType(id)) return false;
    if (model === access.model) return true;
    if (model.isInterface(id) !== access.model.isInterface(id)) return false;
    return model.isInterface(id) ? digest(model.describeType(id)) === digest(access.model.describeType(id)) : model.fingerprint(id) === access.model.fingerprint(id);
  } catch { return false; } };
  const typeAllowed = (id: string): boolean => reviewedType(id) && policy.resourceAllowed(model.isInterface(id) ? 'interface' : 'objectType', id)
    && (model.isInterface(id) ? model.concreteTypes(id).some(typeAllowed) : parent.resources.some(r => r.type === id));
  const types = model.typeIds().filter(typeAllowed).sort();
  const fields = (type: string) => Object.fromEntries(Object.entries(policy.fields(type)).filter(([name]) => {
    const concrete = model.concreteTypes(type).filter(t => typeAllowed(t));
    return concrete.some(t => { const field = model.propertyName(t, type, name); return parent.resources.some(r => r.type === t && r.fields.includes(field)) && policy.fieldPolicy(t, field) !== 'internal_only'; });
  }).map(([name, property]) => [name, { description: property.description, kind: property.kind, required: !!property.required,
    ...(property.derived && policy.resourceAllowed('function', property.derived) ? { derived: property.derived } : {}), schema: definitionSchema(access.model, property.schema, property.schemaMetadata) }]));
  const definitions = types.map(id => {
    const concrete = !model.isInterface(id), def = concrete ? model.object(id) : undefined;
    return { kind: concrete ? 'object' : 'interface', id, ...(def ? { version: def.version, name: def.name, description: def.businessDescription ?? def.description,primaryKey:def.primaryKey,titleKey:def.titleKey,
      interfaces: (def.interfaces ?? []).filter(view => typeAllowed(view.id)).map(view => ({ id: view.id })), ...(def.classification ? { classification: structuredClone(def.classification) } : {}) } : { description: (model.describeType(id) as { description: string }).description }), properties: fields(id),
      links: concrete ? model.sides(id).filter(s => typeAllowed(s.other.type) && policy.resourceAllowed('linkType', s.link.id)).map(s => ({ id: s.link.id, name: s.side.name, target: s.other.type, many: s.side.many }))
        : ((model.describeType(id) as { linkConstraints: { name: string; target: string; many: boolean }[] }).linkConstraints).filter(link => typeAllowed(link.target) && model.concreteTypes(id).filter(typeAllowed).some(type => {
          try { return policy.resourceAllowed('linkType', model.navigation(type, link.name, id).link.id); } catch { return false; }
        })).map(({ name, target, many }) => ({ name, target, many })) };
  });
  const actions = model.actionIds().map(id => model.action(id)).filter(a => policy.resourceAllowed('actionType', a.id) && Object.values(a.inputs).every(typeAllowed)
    && a.changes.every(change => typeAllowed(change.split('.')[0]!)) && (a.resultTypes ?? []).every(typeAllowed) && (a.read?.mcp?.requires??[]).every(r=>typeAllowed(r.objectType) && (!r.action || policy.resourceAllowed('actionType',r.action)) && policy.resourceAllowed('function',r.evaluate) && (!r.derive || policy.resourceAllowed('function',r.derive.function)))
    && (!a.read?.module || policy.resourceAllowed('function',a.read.module.completion.evaluate))).map(a => ({ id: a.id, description: a.description, inputs: a.inputs, changes: a.changes, execution: 'definition_only',
      ...(model.criteriaVersion === '2' ? { version: a.version ?? a.operation?.version ?? a.read?.version, kind: a.kind, effects: a.effects,
        requiresApproval: model.approvalRequired(a.id), resultTypes: a.resultTypes, submissionCriteria: a.submissionCriteria, criteriaBindings: a.criteriaBindings,
        authorization: { requiresExplicitEffectScope: model.approvalRequired(a.id), current: 'not_evaluated', existingExactScopeMaySatisfy: true }, runtimeReadiness: 'not_evaluated',
        binding: model.actionBindingStatus(a.id), ...(a.inputSchema ? { inputSchema: a.inputSchema } : {}),
        ...(a.composition ? { composition: a.composition } : {}) } : {}),
      ...(a.read ? { read: { effect: a.read.effect, resultType: a.read.resultType, inputSchema: a.read.inputSchema,
        ...(a.read.mcp?{mcp:{requires:a.read.mcp.requires,inputMatchesScope:a.read.mcp.inputMatchesScope}}:{}),...(a.read.module?{module:{completion:a.read.module.completion}}:{}) } } : {}),
      ...(a.operation ? { operation: { effect: a.operation.effect, resultType: a.operation.resultType, inputSchema: a.operation.inputSchema,
        ...(model.criteriaVersion === '2' ? { additionalEffects: a.operation.additionalEffects ?? [] } : {}) } } : {}) }));
  const permittedActions = new Set(actions.map(action => action.id));
  const visibleDefinitions = model.criteriaVersion === '2' ? definitions.map(type => ({ ...type,
    ...(type.kind === 'object' ? { actions: Object.fromEntries(Object.entries(model.typeActions(type.id)).map(([kind, bindings]) => [kind, bindings.filter(binding => permittedActions.has(binding.id))])) } : {}),
  })) : definitions;
  const strictFunctions = model.criteriaVersion === '2';
  const functions = model.functionIds().map(id => model.function(id)).filter(f => policy.resourceAllowed('function', f.id) && (strictFunctions ? f.inputTypes.some(typeAllowed) : f.inputTypes.every(typeAllowed))
    && (f.executionContract?.mode !== 'validated' || f.executionContract.version === '2' || f.executionContract.reads.types.every(typeAllowed)
      && f.executionContract.reads.relationships.every(link => {
        const as = model.isInterface(link.type) ? link.type : undefined, sources = (as ? model.concreteTypes(as) : [link.type]).filter(typeAllowed);
        return sources.length > 0 && sources.every(source => policy.resourceAllowed('linkType', model.navigation(source, link.name, as).link.id));
      }))).map(f=>{
    const schema=functionCallSchema.options.find(schema=>schema.shape.function.value===f.id);
    const inputTypes = strictFunctions ? f.inputTypes.filter(typeAllowed) : f.inputTypes;
    return {...f, ...authorizedFunctionContract(access, model, f, typeAllowed), inputTypes, ...(inputTypes.length !== f.inputTypes.length ? { inputTypesFiltered: true } : {}),
      ...(f.executionContract ? { inputSchema: structuredClone(f.executionContract.inputSchema) } : schema ? {inputSchema:definitionSchema(access.model, schema)} : {}), ...(strictFunctions ? { binding: model.functionBindingStatus(f.id) } : {})};
  });
  // Build one authorized definition set for internal context selection and public paging.
  return { model: { id: model.ref.id, version: 'authorized.v2', digest: digest({ types: visibleDefinitions, actions, functions }) }, types: visibleDefinitions, actions, functions };
}

export function describeDefinitionCatalogue(access: DefinitionAccess, input: DefinitionDescriptionInput = {}, model: OntologyModel = access.model, contextTypes: readonly string[] = []) {
  const catalogue = authorizedDefinitionCatalogue(access, model), { types: definitions, actions, functions } = catalogue;
  input = withPaTaskDomains(input, definitions, contextTypes);
  const kind = input.kind ?? 'types', search = input.search?.trim().toLowerCase();
  const selection = paDiscoverySelection(definitions, input, (type, target) => model.implements(type, target));
  const page = <T extends { id: string }>(values: T[]) => {
    const selected = values.filter(value => (!input.after || value.id > input.after) && (!search || JSON.stringify(value).toLowerCase().includes(search))).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const items = selected.slice(0, input.limit ?? 3), hasMore = selected.length > items.length;
    return { items, hasMore, next: hasMore ? items.at(-1)?.id : undefined };
  };
  const typePage = page(kind === 'types' ? selection.types : []), actionPage = page(kind === 'actions' ? actions : []), functionPage = page(kind === 'functions' ? functions : []);
  const generic = new Set(['ServiceRequest', 'Provider', 'Channel', 'SourceReceipt', 'EvidenceBacked']);
  const relevant = (type: string) => typePage.items.some(item => !generic.has(item.id) && (item.id === type || model.implements(item.id, type)));
  const relatedActions = actions.filter(action => Object.values(action.inputs).some(relevant) || action.changes.some(change => relevant(change.split('.')[0]!))
    || !!action.read && relevant(action.read.resultType) || !!action.operation && relevant(action.operation.resultType));
  const relatedFunctions = functions.filter(fn => fn.inputTypes.some(relevant));
  if (input.actions?.some(id => !actions.some(action => action.id === id)) || input.functions?.some(id => !functions.some(fn => fn.id === id))) throw new SecurityError('INSUFFICIENT_ACCESS');
  const paging = kind === 'types' ? typePage : kind === 'actions' ? actionPage : functionPage;
  // The external digest depends only on the authorized definitions. No private
  // model fingerprint or hidden count/continuation is exposed.
  return { model: catalogue.model, ...(selection.discovery ? { discovery: selection.discovery } : {}),
    kind, types: typePage.items.map(type => filterRelationshipMetadata(paDefinitionLinks(type, selection.types, selection.discovery?.view === 'pa'), input.linkSearch)),
    actions: input.actions ? actions.filter(action => input.actions!.includes(action.id)) : kind === 'actions' ? actionPage.items : kind === 'types' ? relatedActions : [],
    functions: input.functions ? functions.filter(fn => input.functions!.includes(fn.id)) : kind === 'functions' ? functionPage.items : kind === 'types' ? relatedFunctions : [],
    hasMore: paging.hasMore, next: paging.next };
}
