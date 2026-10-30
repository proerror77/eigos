import { z } from 'zod';
import type { Principal } from '../core/domain.js';
import { digest } from '../core/delegation.js';
import { objectQuerySchema, type OntologyObjectStore } from '../ontology/object-store.js';
import { functionCallSchema } from '../ontology/object-functions.js';
import { objectRefSchema,nameSchema } from '../ontology/model.js';
import type { SecurityStore } from './store.js';
import { SecurityError } from './store.js';
import type { AuthorizationScope } from './context.js';

export const secureDescribeSchema = z.strictObject({ taskId: z.uuid().optional(), kind: z.enum(['types', 'actions', 'functions']).optional(), search: z.string().max(100).optional(), limit: z.number().int().min(1).max(5).default(3), after: z.string().max(80).optional() });
export const secureQuerySchema = z.strictObject({ version: z.literal(2), taskId: z.uuid(), expectedRequestRevision: z.number().int().positive().optional(), query: objectQuerySchema });
// Discovery does not enumerate hidden function IDs or their argument schemas.
// The actual registered function schema is validated after resource access.
export const secureFunctionCallSchema=z.object({function:nameSchema,object:objectRefSchema}).catchall(z.unknown());
export const secureEvaluateSchema = z.strictObject({ version: z.literal(2), taskId: z.uuid(), expectedRequestRevision: z.number().int().positive().optional(), call: secureFunctionCallSchema });
export const checkAccessSchema = z.strictObject({ taskId: z.uuid(), operation: z.enum(['task.query', 'task.result.read','resource.view','function.invoke','action.execute','artifact.export']), object: objectRefSchema.optional(), fields: z.array(nameSchema).max(200).optional(),
  resource:z.strictObject({kind:z.enum(['objectType','interface','linkType','actionType','function']),id:nameSchema}).optional(),artifactId:z.uuid().optional() });

export function authorizedDefinitions(security: SecurityStore, scope: AuthorizationScope, model: OntologyObjectStore['model'] = security.model) {
  security.policies.assertModel(model);
  const policy = security.policies, parent = security.agentGrant(scope.actor.installationId);
  const reviewedType = (id: string) => { try {
    if (!model.hasType(id) || !security.model.hasType(id) || model.isInterface(id) !== security.model.isInterface(id)) return false;
    return model.isInterface(id) ? digest(model.describeType(id)) === digest(security.model.describeType(id)) : model.fingerprint(id) === security.model.fingerprint(id);
  } catch { return false; } };
  const typeAllowed = (id: string): boolean => reviewedType(id) && policy.resourceAllowed(scope, model.isInterface(id) ? 'interface' : 'objectType', id)
    && (model.isInterface(id) ? model.concreteTypes(id).some(typeAllowed) : parent.resources.some(r => r.type === id));
  const types = model.typeIds().filter(typeAllowed).sort();
  const fields = (type: string) => Object.fromEntries(Object.entries(policy.fields(type)).filter(([name]) => {
    const concrete = model.concreteTypes(type).filter(t => typeAllowed(t));
    return concrete.some(t => { const field = model.propertyName(t, type, name); return parent.resources.some(r => r.type === t && r.fields.includes(field)) && policy.fieldPolicy(t, field) !== 'internal_only'; });
  }).map(([name, property]) => [name, { description: property.description, kind: property.kind, required: !!property.required,
    ...(property.derived && policy.resourceAllowed(scope, 'function', property.derived) ? { derived: property.derived } : {}), schema: z.toJSONSchema(property.schema) }]));
  const definitions = types.map(id => {
    const concrete = !model.isInterface(id), def = concrete ? model.object(id) : undefined;
    return { kind: concrete ? 'object' : 'interface', id, ...(def ? { version: def.version, name: def.name, description: def.description,primaryKey:def.primaryKey,titleKey:def.titleKey,
      interfaces: (def.interfaces ?? []).filter(view => typeAllowed(view.id)).map(view => ({ id: view.id })) } : { description: (model.describeType(id) as { description: string }).description }), properties: fields(id),
      links: concrete ? model.sides(id).filter(s => typeAllowed(s.other.type) && policy.resourceAllowed(scope, 'linkType', s.link.id)).map(s => ({ id: s.link.id, name: s.side.name, target: s.other.type, many: s.side.many }))
        : ((model.describeType(id) as { linkConstraints: { name: string; target: string; many: boolean }[] }).linkConstraints).filter(link => typeAllowed(link.target) && model.concreteTypes(id).filter(typeAllowed).some(type => {
          try { return policy.resourceAllowed(scope, 'linkType', model.navigation(type, link.name, id).link.id); } catch { return false; }
        })).map(({ name, target, many }) => ({ name, target, many })) };
  });
  const actions = model.actionIds().map(id => model.action(id)).filter(a => policy.resourceAllowed(scope, 'actionType', a.id) && Object.values(a.inputs).every(typeAllowed)
    && a.changes.every(change => typeAllowed(change.split('.')[0]!)) && (a.read?.mcp?.requires??[]).every(r=>typeAllowed(r.objectType) && (!r.action || policy.resourceAllowed(scope,'actionType',r.action)) && policy.resourceAllowed(scope,'function',r.evaluate) && (!r.derive || policy.resourceAllowed(scope,'function',r.derive.function)))
    && (!a.read?.module || policy.resourceAllowed(scope,'function',a.read.module.completion.evaluate))).map(a => ({ id: a.id, description: a.description, inputs: a.inputs, changes: a.changes, execution: 'definition_only',
      ...(a.read ? { read: { effect: a.read.effect, resultType: a.read.resultType, inputSchema: a.read.inputSchema,
        ...(a.read.mcp?{mcp:{requires:a.read.mcp.requires,inputMatchesScope:a.read.mcp.inputMatchesScope}}:{}),...(a.read.module?{module:{completion:a.read.module.completion}}:{}) } } : {}),
      ...(a.operation ? { operation: { effect: a.operation.effect, resultType: a.operation.resultType, inputSchema: a.operation.inputSchema } } : {}) }));
  const functions = model.functionIds().map(id => model.function(id)).filter(f => policy.resourceAllowed(scope, 'function', f.id) && f.inputTypes.every(typeAllowed)).map(f=>{
    const schema=functionCallSchema.options.find(schema=>schema.shape.function.value===f.id);
    return {...f,...(schema?{inputSchema:z.toJSONSchema(schema)}:{})};
  });
  // Build one authorized definition set for internal context selection and public paging.
  return { model: { id: model.ref.id, version: 'authorized.v2', digest: digest({ types: definitions, actions, functions }) }, types: definitions, actions, functions };
}

export function describeAuthorized(security: SecurityStore, scope: AuthorizationScope, input: { kind?: 'types' | 'actions' | 'functions'; search?: string; limit?: number; after?: string; actions?: string[]; functions?: string[] } = {}, model: OntologyObjectStore['model'] = security.model) {
  const catalogue = authorizedDefinitions(security, scope, model), { types: definitions, actions, functions } = catalogue;
  const kind = input.kind ?? 'types', search = input.search?.trim().toLowerCase();
  const page = <T extends { id: string }>(values: T[]) => {
    const selected = values.filter(value => (!input.after || value.id > input.after) && (!search || JSON.stringify(value).toLowerCase().includes(search))).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const items = selected.slice(0, input.limit ?? 3), hasMore = selected.length > items.length;
    return { items, hasMore, next: hasMore ? items.at(-1)?.id : undefined };
  };
  const typePage = page(kind === 'types' ? definitions : []), actionPage = page(kind === 'actions' ? actions : []), functionPage = page(kind === 'functions' ? functions : []);
  const generic = new Set(['ServiceRequest', 'Provider', 'Channel', 'SourceReceipt', 'EvidenceBacked']);
  const relevant = (type: string) => typePage.items.some(item => !generic.has(item.id) && (item.id === type || model.implements(item.id, type)));
  const relatedActions = actions.filter(action => Object.values(action.inputs).some(relevant) || action.changes.some(change => relevant(change.split('.')[0]!))
    || !!action.read && relevant(action.read.resultType) || !!action.operation && relevant(action.operation.resultType));
  const relatedFunctions = functions.filter(fn => fn.inputTypes.some(relevant));
  if (input.actions?.some(id => !actions.some(action => action.id === id)) || input.functions?.some(id => !functions.some(fn => fn.id === id))) throw new SecurityError('INSUFFICIENT_ACCESS');
  const paging = kind === 'types' ? typePage : kind === 'actions' ? actionPage : functionPage;
  // The external digest depends only on the authorized definitions. No private
  // model fingerprint or hidden count/continuation is exposed.
  return { model: catalogue.model,
    kind, types: typePage.items,
    actions: input.actions ? actions.filter(action => input.actions!.includes(action.id)) : kind === 'actions' ? actionPage.items : kind === 'types' ? relatedActions : [],
    functions: input.functions ? functions.filter(fn => input.functions!.includes(fn.id)) : kind === 'functions' ? functionPage.items : kind === 'types' ? relatedFunctions : [],
    hasMore: paging.hasMore, next: paging.next };
}

export class AuthorizedOntologyView {
  constructor(private graph: OntologyObjectStore, private security: SecurityStore, private principal: Principal) {}
  describe(input: unknown) {
    const { taskId, ...args } = secureDescribeSchema.parse(input);
    return this.security.withAgent(this.principal, taskId, 'task.query', scope => describeAuthorized(this.security, scope, args, taskId ? this.graph.model : this.security.model));
  }
  query(input: unknown) {
    const args = secureQuerySchema.parse(input);
    return this.security.withAgent(this.principal, args.taskId, 'task.query', scope => {
      this.revision(scope, args.expectedRequestRevision);
      const result = this.graph.query(scope.actor.ownerKey, args.query);
      if(scope.lineage.size) this.security.policies.requireRecipient(scope,this.security.policies.outputEnvelope(scope.actor.ownerKey),'agent_response');
      else if(!scope.grant!.channels.includes('agent_response')) throw new SecurityError('OUTPUT_NOT_ALLOWED');
      return { version: 2, taskId: args.taskId, requestRevision: scope.grant!.requestRevision,
        items: result.items.map(({ ref, revision, properties, derived }) => ({ ref, revision, properties, ...(derived ? { derived } : {}) })),
        page: { limit: result.page.limit, hasMore: result.page.hasMore, cursor: result.page.cursor } };
    });
  }
  evaluate(input: unknown) {
    const args = secureEvaluateSchema.parse(input);
    return this.security.withAgent(this.principal, args.taskId, 'task.query', scope => {
      this.revision(scope, args.expectedRequestRevision);
      this.security.policies.requireResource(scope,'function',args.call.function);
      const { model: _model, ...result } = this.graph.evaluate(scope.actor.ownerKey, args.call);
      if(scope.lineage.size) this.security.policies.requireRecipient(scope,this.security.policies.outputEnvelope(scope.actor.ownerKey),'agent_response');
      else if(!scope.grant!.channels.includes('agent_response')) throw new SecurityError('OUTPUT_NOT_ALLOWED');
      return { version: 2, taskId: args.taskId, requestRevision: scope.grant!.requestRevision, ...result };
    });
  }
  check(input: unknown) {
    const args = checkAccessSchema.parse(input);
    const operation=args.operation==='task.result.read'?'task.result.read':args.operation==='action.execute'?'task.process':'task.query';
    return this.security.withAgent(this.principal, args.taskId, operation, scope => {
      const binding = args.object ? this.security.policies.binding(scope, args.object) : undefined;
      let reason=(!args.object || !!binding && (args.fields??[]).every(f=>binding.fields.includes(f)))?'ALLOWED':'INSUFFICIENT_ACCESS';
      const policy=this.security.policies;
      if(args.operation==='resource.view')reason=args.resource && policy.resourceAllowed(scope,args.resource.kind,args.resource.id)?reason:'AUTHORIZATION_REQUIRED';
      if(args.operation==='function.invoke')reason=args.resource?.kind==='function' && policy.resourceAllowed(scope,'function',args.resource.id) && policy.resourceAllowed(scope,'function',args.resource.id,'function.invoke')?reason:'AUTHORIZATION_REQUIRED';
      if(args.operation==='action.execute')reason=args.resource?.kind==='actionType'?policy.checkAction(scope,args.resource.id):'AUTHORIZATION_REQUIRED';
      if(args.operation==='artifact.export')reason=args.artifactId && policy.artifacts(scope.actor.ownerKey,args.taskId).some(a=>a.id===args.artifactId)?'ALLOWED':'OUTPUT_NOT_ALLOWED';
      const allowed=reason==='ALLOWED';
      return { version: 2, allowed, reason, fields: allowed ? binding?.fields ?? [] : [],
        grant: { id: scope.grant!.id, revision: scope.grant!.revision }, policyRevision: scope.policyRevision, grantsAuthority: false };
    });
  }
  private revision(scope: AuthorizationScope, expected?: number) { if (expected !== undefined && scope.grant?.requestRevision !== expected) throw new SecurityError('POLICY_CHANGED'); }
}
