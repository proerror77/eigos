import type {SemanticActionRanker} from '../semantic/catalog.js';
import type {Client} from 'pg';
import {z} from 'zod';
import {digest} from '../core/delegation.js';
import {DomainError,type Principal} from '../core/domain.js';
import {discoverActionMetadata,type ActionDiscoveryProgram} from '../core/catalog.js';
import {actionDiscoverySchema,type ActionBindingPin,type ActionDiscoveryPage,type ActionDiscoveryQuery} from '../core/action-bindings.js';
import type {ServiceRequest} from '../ontology/execution.js';
import type {StagedKernelBuilder} from '../ontology/seed-definition.js';
import type {PipelineStatus} from '../ontology/pipeline/contracts.js';
import type {ProjectionMetadata,GraphStorage} from '../ontology/graph-program.js';
import {storedSourceSchema} from '../security/source-policy.js';
import {SecurityError} from '../security/errors.js';
import {postgresConsentDeadline,postgresConstrainConsent} from './consent.js';
import {postgresBusinessSchema,postgresBusinessToken,postgresRequireLeaseAtCommit,postgresConstrainReadDeadline} from './runtime-transaction.js';
import {postgresClaimSnapshotMatches,postgresWorkReference,type PostgresWorkReference} from './work-claim.js';
import {withPostgresWorkerEvidenceAuthorization,type PostgresTaskReadAuthorization} from './task-output.js';
import type {PostgresTaskReadAdmission} from './task-read-access.js';
import {withPostgresTaskDefinitionAccess} from './ontology-metadata.js';
import {assertPostgresPlanningDiscoveryContext,type PostgresPlanningDiscoveryContext} from './native-planning-session.js';
import {PostgresReadProgramRegistry} from './didi-registry.js';
import {PostgresTaskStorage} from './task-storage.js';
import {PostgresDefinitionStore} from './definition-store.js';

export interface PostgresDocumentBindingOptions {
  semantic?:SemanticActionRanker;
  didiReadTiming?:{durationMs:number;receipts:number};
  policyDigest:string;modelChannel:string;builder?:StagedKernelBuilder;sourceBindingId?:string;registry?:PostgresReadProgramRegistry;
  inspectClaim:(claim:PostgresWorkReference)=>Promise<{validUntil:number}|undefined>;
}
// The compatibility Doc directory belongs to this host-options scope. Its
// registration identity must survive resolution and the subsequent current
// check; no authorization result or account state is cached here.
const defaultRegistries=new WeakMap<PostgresDocumentBindingOptions,{policyDigest:string;sourceBindingId?:string;registry:PostgresReadProgramRegistry}>();
export function postgresReadRegistry(options:PostgresDocumentBindingOptions){
  if(options.registry)return options.registry;
  const current=defaultRegistries.get(options);
  if(current&&current.policyDigest===options.policyDigest&&current.sourceBindingId===options.sourceBindingId)return current.registry;
  const registry=new PostgresReadProgramRegistry(options.policyDigest,{documentSourceBindingId:options.sourceBindingId});
  defaultRegistries.set(options,{policyDigest:options.policyDigest,sourceBindingId:options.sourceBindingId,registry});return registry;
}
const same=(a:unknown,b:unknown)=>digest(a)===digest(b);
const key=(program:ActionDiscoveryProgram,actionId:string)=>digest({ref:program.ref,configuration:program.configurationDigest,actionId});
function fail(message:string):never{throw new DomainError('CONFLICT',message);}

/** Actual host-registered readonly program directory. Agent/Worker boundaries
 * remain separate; this function consumes only the original Worker callback.
 * Metadata creates no source/action permission and never chooses a recipe. */
export async function discoverPostgresReadBindings(client:Client,input:PostgresWorkReference,requestInput:ServiceRequest,supplied:ActionDiscoveryQuery,options:PostgresDocumentBindingOptions,scope?:PostgresPlanningDiscoveryContext):Promise<ActionDiscoveryPage>{
  const token=postgresBusinessToken(client),q=`"${postgresBusinessSchema(client)}"`,claim=postgresWorkReference(input),request=structuredClone(requestInput),query=actionDiscoverySchema.parse(supplied),registry=postgresReadRegistry(options);
  const active=()=>{if(scope)assertPostgresPlanningDiscoveryContext(scope);if(postgresBusinessToken(client)!==token)throw new SecurityError('AUTHORIZATION_REQUIRED');};
  if(registry.policyDigest!==options.policyDigest||!options.modelChannel||typeof options.inspectClaim!=='function')throw new Error('Actual registered program and current Worker discovery authority are required');
  if(scope&&(scope.client!==client||!same(scope.claim,claim)||scope.policyDigest!==options.policyDigest||scope.modelChannel!==options.modelChannel))throw new SecurityError('POLICY_CHANGED');
  if(request.id!==claim.job.id||request.revision!==claim.job.delegation?.request.revision)throw new SecurityError('POLICY_CHANGED');
  if(!await postgresClaimSnapshotMatches(client,claim,options.policyDigest)||!await options.inspectClaim(claim))throw new SecurityError('ACCESS_REVOKED');postgresRequireLeaseAtCommit(client,digest(claim),()=>options.inspectClaim(claim));
  const read=async(auth:PostgresTaskReadAuthorization,admission:PostgresTaskReadAdmission,principal:Principal)=>{
    if(admission.actor.actorKind!=='worker'||admission.actor.taskId!==claim.job.id||admission.grant.taskId!==claim.job.id||admission.grant.requestRevision!==request.revision||admission.actor.authEpoch!==claim.securityEpoch||admission.policyRevision!==claim.securityPolicyRevision)throw new SecurityError('AUTHORIZATION_REQUIRED');
    const root=await auth.readTaskRoot();if(root.object.properties.revision!==request.revision||root.object.properties.originalGoal!==request.originalGoal)throw new SecurityError('POLICY_CHANGED');
    return withPostgresTaskDefinitionAccess(client,principal,request.id,options.policyDigest,async(access,model)=>{
      const store=new PostgresDefinitionStore(client,{builder:options.builder}),job=await new PostgresTaskStorage(client,options.builder).get(claim.owner,request.id),release=await store.resolve(job.delegation!.ontologyRelease!);
      if(!same(release.model.ref,model.ref)||request.revision!==job.delegation?.request.revision)throw new SecurityError('POLICY_CHANGED');
      const graph:ProjectionMetadata={model,releaseRef:release.ref,now:Date.now},programs=registry.catalog.actionDiscoveryPrograms(graph,claim.owner),allowed=(program:ActionDiscoveryProgram)=>[program.ref.id,program.capability().ref.id].some(id=>admission.parent.capabilityIds.includes(id))&&admission.grant.outputs.some(output=>output.programId===program.ref.id);
      const definitions=new Set(model.actionIds().filter(id=>access.resourceAllowed('actionType',id))),environment=request.executionEnvironment??'live';
      const eligible=programs.filter(program=>allowed(program)&&program.permitted(claim.owner)&&(!query.programRef||same(query.programRef,program.ref))&&(environment==='sandbox'?program.capability().environment!=='live':program.capability().environment!=='sandbox'));
      const rows=await client.query(`SELECT binding_id,program_id,CASE WHEN octet_length(body)<=65536 THEN body END AS body FROM ${q}.security_sources WHERE owner=$1 AND installation_id=$2 AND state='active' ORDER BY __eigos_rowid LIMIT 257`,[claim.owner,admission.actor.installationId]);active();
      if(rows.rows.length>256||rows.rows.some(row=>typeof row.body!=='string'))throw new SecurityError('SOURCE_NOT_AUTHORIZED');
      const sources=rows.rows.map(row=>{const source=storedSourceSchema.parse(JSON.parse(row.body));if(source.installationId!==admission.actor.installationId||source.bindingId!==row.binding_id||source.programId!==row.program_id)throw new SecurityError('SOURCE_NOT_AUTHORIZED');return source;})
        .filter(source=>source.parentGrant.id===admission.parent.id&&source.parentGrant.revision===admission.parent.revision&&postgresConsentDeadline(source.expiresAt,options.policyDigest)>Date.now());
      const pipelines=new Map<string,PipelineStatus>(),accountAllowed=new Map<string,boolean>();let combinations=0;
      for(const program of eligible){const entry=registry.require(program.ref,program.configurationDigest);let available=true;
        try{await registry.assertConfigured(client,entry,claim,job);}catch(error){if(error instanceof DomainError&&error.code==='FORBIDDEN'||error instanceof SecurityError&&error.reason==='SOURCE_NOT_AUTHORIZED')available=false;else throw error;}
        accountAllowed.set(digest(program.ref),available);
        for(const action of model.actionDefinitions()){
          if(!definitions.has(action.id)||!program.actionIds.includes(action.id)||query.actionId&&query.actionId!==action.id)continue;if(++combinations>2000)fail('Program metadata exceeds its complete discovery bound');
          const status=job.delegation!.pipelineValidation?await store.pipeline.validationStatus(claim.owner,release.document,model,job.delegation!.pipelineValidation,program.ref,program.configurationDigest,action.id):await store.pipeline.status(claim.owner,release.document,model,program.ref,program.configurationDigest,action.id);pipelines.set(key(program,action.id),status);
          if(status.verificationIds.length){const proofs=await client.query(`SELECT CASE WHEN octet_length(body)<=1048576 THEN body END AS body FROM ${q}.ontology_pipeline_verifications WHERE ontology_id=$1 AND id=ANY($2::text[])`,[release.ref.ontologyId,status.verificationIds]);if(proofs.rowCount!==new Set(status.verificationIds).size||proofs.rows.some(row=>typeof row.body!=='string'))throw new SecurityError('SOURCE_NOT_AUTHORIZED');for(const row of proofs.rows){const value=z.object({expiresAt:z.iso.datetime({offset:true})}).parse(JSON.parse(row.body)),until=Date.parse(value.expiresAt);if(until<=Date.now())throw new SecurityError('SOURCE_NOT_AUTHORIZED');postgresConstrainReadDeadline(client,until);}}
        }
      }
      const ranking=options.semantic&&query.search&&query.searchMode!=='keyword'&&!query.actionId
        ? await options.semantic.rank(client,release.ref,model.actionDefinitions().filter(action=>definitions.has(action.id)&&eligible.some(program=>program.actionIds.includes(action.id))),query.search):undefined;
      active();
      const page=discoverActionMetadata(graph,claim.owner,request,query,eligible,allowed,action=>definitions.has(action.id),(program,actionId)=>pipelines.get(key(program,actionId))??fail('Registered program Pipeline metadata is incomplete'),(program,actionId)=>{
        if(!accountAllowed.get(digest(program.ref)))return false;const entry=registry.require(program.ref,program.configurationDigest),bindingId=entry.sourceBindingId??(entry.kind==='document'?options.sourceBindingId:undefined);
        const source=sources.find(source=>source.programId===program.ref.id&&source.programDigest===program.configurationDigest&&source.operations.includes(actionId)&&(!bindingId||source.bindingId===bindingId)&&admission.parent.sourceBindingIds.includes(source.bindingId)&&admission.grant.outputs.some(output=>output.programId===source.programId&&output.programDigest===source.programDigest&&output.sourceBindingId===source.bindingId&&source.outputTypes.includes(output.type)&&output.fields.every(field=>admission.parent.resources.some(resource=>resource.type===output.type&&resource.fields.includes(field)))));
        if(source)postgresConstrainConsent(client,source.expiresAt,options.policyDigest);return !!source;
      },ranking);active();return page;
    },options.builder);
  };
  return scope?read(scope.authorization,scope.admission,scope.principal):withPostgresWorkerEvidenceAuthorization(client,claim,options.policyDigest,read,options.builder,options.modelChannel,options.inspectClaim);
}
export async function resolvePostgresReadBinding(client:Client,claim:PostgresWorkReference,request:ServiceRequest,pin:ActionBindingPin,options:PostgresDocumentBindingOptions,scope?:PostgresPlanningDiscoveryContext){
  const {digest:expected,...body}=pin;if(digest(body)!==expected||pin.ownerDigest!==digest(claim.owner)||pin.requestId!==request.id||pin.requestRevision!==request.revision)throw new SecurityError('POLICY_CHANGED');
  const registry=postgresReadRegistry(options),registration=registry.require(pin.programRef,pin.configurationDigest),page=await discoverPostgresReadBindings(client,claim,request,{actionId:pin.actionId,programRef:pin.programRef},options,scope),binding=page.items.flatMap(item=>item.bindings).find(binding=>same(binding.pin,pin));
  if(!binding||binding.readiness!=='ready')throw new SecurityError(binding?.readiness==='source_authorization_required'?'SOURCE_NOT_AUTHORIZED':'AUTHORITY_UNAVAILABLE',binding?.reason??'The exact registered program is unavailable');return {program:registration.program,binding,registration};
}
export async function discoverPostgresReadActions(graph:ProjectionMetadata&GraphStorage,owner:string,request:ServiceRequest,input:ActionDiscoveryQuery,context:PostgresPlanningDiscoveryContext,options:PostgresDocumentBindingOptions){
  assertPostgresPlanningDiscoveryContext(context);if(owner!==context.claim.owner||request.id!==context.claim.job.id||context.policyDigest!==options.policyDigest||context.modelChannel!==options.modelChannel)throw new SecurityError('POLICY_CHANGED');
  await graph.read(owner,{type:'ServiceRequest',id:request.id});const page=await discoverPostgresReadBindings(context.client,context.claim,request,input,options,context);assertPostgresPlanningDiscoveryContext(context);if(!same(page.ontologyRelease,graph.releaseRef))throw new SecurityError('POLICY_CHANGED');return page;
}
// Existing Doc callers keep their published API; they now use the same actual
// registry/pin/filter/pagination path as other explicitly installed reads.
export const discoverPostgresDocumentBindings=discoverPostgresReadBindings;
export const resolvePostgresDocumentBinding=resolvePostgresReadBinding;
export const discoverPostgresDocumentActions=discoverPostgresReadActions;
