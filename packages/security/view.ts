import { secureDescribeSchema, secureQuerySchema, secureEvaluateSchema, checkAccessSchema } from './view-contracts.js';
export { secureDescribeSchema, secureQuerySchema, secureFunctionCallSchema, secureEvaluateSchema, checkAccessSchema } from './view-contracts.js';
import { authorizedDefinitionCatalogue, describeDefinitionCatalogue, type DefinitionAccess, type DefinitionDescriptionInput } from './definition-view.js';
import type { Principal } from '../core/domain.js';
import type { OntologyObjectStore } from '../ontology/object-store.js';
import type { SecurityStore } from './store.js';
import { SecurityError } from './store.js';
import type { AuthorizationScope } from './context.js';

function definitionAccess(security: SecurityStore, scope: AuthorizationScope): DefinitionAccess {
  return { model: security.model, parent: security.agentGrant(scope.actor.installationId),
    resourceAllowed: (kind, id) => security.policies.resourceAllowed(scope, kind, id),
    fields: type => security.policies.fields(type), fieldPolicy: (type, field) => security.policies.fieldPolicy(type, field) };
}
export function authorizedDefinitions(security: SecurityStore, scope: AuthorizationScope, model = security.model) {
  security.policies.assertModel(model);
  return authorizedDefinitionCatalogue(definitionAccess(security, scope), model);
}
export function describeAuthorized(security: SecurityStore, scope: AuthorizationScope, input: DefinitionDescriptionInput = {}, model = security.model) {
  security.policies.assertModel(model);
  return describeDefinitionCatalogue(definitionAccess(security, scope), input, model);
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
