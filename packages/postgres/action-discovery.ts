import type {SemanticActionRanker} from '../semantic/catalog.js';
import type {Client} from 'pg';
import {z} from 'zod';
import {DomainError,ownerKey,taskIdSchema,type Principal} from '../core/domain.js';
import {digest} from '../core/delegation.js';
import {discoverActionMetadata,sameRef,type ActionDiscoveryProgram,type ExecutionCatalog} from '../core/catalog.js';
import {actionDiscoverySchema,type ActionDiscoveryPage,type ActionDiscoveryQuery} from '../core/action-bindings.js';
import type {ProjectionMetadata} from '../ontology/graph-program.js';
import {ontologyReleaseRefSchema} from '../ontology/definition-contracts.js';
import type {PipelineStatus} from '../ontology/pipeline/contracts.js';
import type {StagedKernelBuilder} from '../ontology/seed-definition.js';
import {storedSourceSchema,type StoredSource} from '../security/source-policy.js';
import {SecurityError} from '../security/errors.js';
import {PostgresDefinitionStore} from './definition-store.js';
import {PostgresTaskStorage} from './task-storage.js';
import {withPostgresTaskDefinitionAccess} from './ontology-metadata.js';
import {withPostgresTaskQueryAuthorization} from './task-output.js';
import {withPostgresAgentScope,postgresTaskReadOntology,type PostgresTaskReadAdmission} from './task-read-access.js';
import {postgresConsentDeadline,postgresConstrainConsent} from './consent.js';
import {postgresBusinessToken,postgresBusinessSchema,postgresConstrainReadDeadline} from './runtime-transaction.js';

const validationScopeSchema=z.strictObject({ownerDigest:z.string().regex(/^[a-f0-9]{64}$/),requestRevision:z.number().int().positive(),release:ontologyReleaseRefSchema,
  serviceId:z.string().min(1).max(200),intakeDigest:z.string().regex(/^[a-f0-9]{64}$/),mappingDigest:z.string().regex(/^[a-f0-9]{64}$/),expiresAt:z.iso.datetime({offset:true})});
const pipelineKey=(program:ActionDiscoveryProgram,actionId:string)=>digest({ref:program.ref,configuration:program.configurationDigest,actionId});

/** Agent-owned task discovery, without a Worker claim, registered-model
 * channel or provider call. The host supplies the catalog and operation; JSON
 * can select only the existing directory filters. A binding is metadata and
 * every later invocation must reacquire its exact action permission. */
export async function discoverPostgresTaskActions(client:Client,principal:Principal,taskId:string,ontologyId:string,input:ActionDiscoveryQuery,
  options:{semantic?:SemanticActionRanker;catalog:ExecutionCatalog;policyDigest:string;builder?:StagedKernelBuilder}):Promise<ActionDiscoveryPage>{
  const captured=structuredClone(principal),id=taskIdSchema.parse(taskId),owner=ownerKey(captured),token=postgresBusinessToken(client),q=`"${postgresBusinessSchema(client)}"`;
  const active=()=>{if(postgresBusinessToken(client)!==token)throw new SecurityError('AUTHORIZATION_REQUIRED');};
  const sql=async(text:string,values:unknown[]=[])=>{active();const rows=await client.query(text,values);active();return rows;};
  if(!/^[a-f0-9]{64}$/.test(options.policyDigest))throw new Error('A reviewed policy is required for task action discovery');
  return withPostgresAgentScope(client,captured,options.policyDigest,'ontology:read',()=>
    withPostgresTaskQueryAuthorization(client,captured,id,options.policyDigest,async(auth,admission)=>{
      if(admission.actor.actorKind!=='agent'||admission.grant.taskId!==id||!admission.grant.operations.includes('task.query'))throw new SecurityError('AUTHORIZATION_REQUIRED');
      if(!admission.parent.channels.includes('agent_response')||!admission.grant.channels.includes('agent_response'))throw new SecurityError('OUTPUT_NOT_ALLOWED');
      const query=actionDiscoverySchema.parse(structuredClone(input)),store=new PostgresDefinitionStore(client,{builder:options.builder});
      await store.assertAccess(owner,ontologyId,captured.scopes.includes('ontology:admin'));
      const job=await new PostgresTaskStorage(client,options.builder).get(owner,id),selected=await postgresTaskReadOntology(client,captured,id,options.policyDigest,options.builder);
      if(!job.delegation||selected.ref.ontologyId!==ontologyId)throw new DomainError('NOT_FOUND','Task is not available in this ontology');
      const request=job.delegation.request;
      if(request.id!==id||request.revision!==admission.grant.requestRevision||job.delegation.ontologyRelease&&digest(job.delegation.ontologyRelease)!==digest(selected.ref))throw new SecurityError('POLICY_CHANGED');
      // Only the authorized read supplies the request revision. The raw ledger
      // above is internal identity data and never becomes a public task view.
      const root=await auth.readTaskRoot();
      if(root.object.ref.type!=='ServiceRequest'||root.object.ref.id!==id||root.object.properties.revision!==request.revision)throw new SecurityError('POLICY_CHANGED');
      const validation=job.delegation.pipelineValidation===undefined?undefined:validationScopeSchema.parse(job.delegation.pipelineValidation);
      if(validation&&(validation.ownerDigest!==digest(owner)||validation.requestRevision!==request.revision||digest(validation.release)!==digest(selected.ref)))throw new SecurityError('POLICY_CHANGED');
      return withPostgresTaskDefinitionAccess(client,captured,id,options.policyDigest,async(access,model)=>{
        if(digest(model.ref)!==digest(selected.model.ref))throw new SecurityError('POLICY_CHANGED');
        // Action discovery follows the existing action-type metadata view. Parent
        // data-resource grants still bound values and execution separately; they
        // do not erase viewable, definition-only entries from directory paging.
        const allowed=new Set(model.actionIds().filter(id=>access.resourceAllowed('actionType',id))),graph:ProjectionMetadata={model,releaseRef:selected.ref,now:Date.now};
        const programs=options.catalog.actionDiscoveryPrograms(graph,owner),environment=request.executionEnvironment??'live';
        const permitted=(program:ActionDiscoveryProgram)=>[program.ref.id,program.capability().ref.id].some(value=>admission.parent.capabilityIds.includes(value))
          &&admission.grant.outputs.some(output=>output.programId===program.ref.id);
        const eligible=programs.filter(program=>permitted(program)&&program.permitted(owner)&&(!query.programRef||sameRef(query.programRef,program.ref))
          &&(environment==='sandbox'?program.capability().environment!=='live':program.capability().environment!=='sandbox'));
        const sources=await loadSources(admission),pipelines=new Map<string,PipelineStatus>();
        // A bounded complete snapshot is materialized before the synchronous
        // catalog algorithm. Missing SQL/proofs never become an empty result.
        let combinations=0;
        for(const program of eligible)for(const action of model.actionDefinitions()){
          if(!allowed.has(action.id)||!program.actionIds.includes(action.id)||query.actionId&&query.actionId!==action.id)continue;
          if(++combinations>2000)throw new DomainError('CONFLICT','Action discovery exceeds its complete metadata bound; select an exact program or action');
          const status=validation?await store.pipeline.validationStatus(owner,selected.document,model,validation,program.ref,program.configurationDigest,action.id)
            :await store.pipeline.status(owner,selected.document,model,program.ref,program.configurationDigest,action.id);
          pipelines.set(pipelineKey(program,action.id),status);
          if(['verified','validation_only'].includes(status.status)){
            if(validation&&Date.parse(validation.expiresAt)>Date.now())postgresConstrainReadDeadline(client,Date.parse(validation.expiresAt));
            const ids=[...new Set(status.verificationIds)];
            if(!ids.length||ids.length>2)throw new SecurityError('POLICY_CHANGED');
            const rows=await sql(`SELECT id,CASE WHEN octet_length(body)<=1048576 AND sum(octet_length(body)) OVER()<=2097152 THEN body END AS body FROM ${q}.ontology_pipeline_verifications WHERE ontology_id=$1 AND id=ANY($2::text[])`,[ontologyId,ids]);
            if(rows.rows.length!==ids.length)throw new SecurityError('POLICY_CHANGED');
            for(const row of rows.rows){
              if(typeof row.body!=='string')throw new DomainError('CONFLICT','Pipeline verification exceeds its complete metadata bound');
              const proof=z.object({id:z.string(),intakeDigest:z.string(),expiresAt:z.iso.datetime({offset:true})}).parse(JSON.parse(row.body));
              if(proof.id!==row.id||proof.intakeDigest!==status.intakeDigest||Date.parse(proof.expiresAt)<=Date.now())throw new SecurityError('POLICY_CHANGED');
              postgresConstrainReadDeadline(client,Date.parse(proof.expiresAt));
            }
          }
        }
        const sourceAllowed=(program:ActionDiscoveryProgram,actionId:string)=>{
          const source=sources.find(source=>source.programId===program.ref.id&&source.programDigest===program.configurationDigest&&source.operations.includes(actionId)
            &&admission.parent.sourceBindingIds.includes(source.bindingId)&&admission.grant.outputs.some(output=>output.programId===source.programId&&output.programDigest===source.programDigest&&output.sourceBindingId===source.bindingId
              &&source.outputTypes.includes(output.type)&&output.fields.every(field=>admission.parent.resources.some(resource=>resource.type===output.type&&resource.fields.includes(field)))));
          if(source)postgresConstrainConsent(client,source.expiresAt,options.policyDigest);return !!source;
        };
        const ranking=options.semantic&&query.search&&query.searchMode!=='keyword'&&!query.actionId
          ? await options.semantic.rank(client,selected.ref,model.actionDefinitions().filter(action=>allowed.has(action.id)&&eligible.some(program=>program.actionIds.includes(action.id))),query.search):undefined;
        active();
        const page=discoverActionMetadata(graph,owner,request,query,eligible,permitted,action=>allowed.has(action.id),(program,actionId)=>{
          const status=pipelines.get(pipelineKey(program,actionId));if(!status)throw new DomainError('CONFLICT','Action discovery metadata is incomplete');return status;
        },sourceAllowed,ranking);
        active();return page;
      },options.builder);
    },options.builder));

  async function loadSources(admission:PostgresTaskReadAdmission):Promise<StoredSource[]>{
    const rows=await sql(`SELECT binding_id,program_id,CASE WHEN octet_length(body)<=65536 THEN body END AS body FROM ${q}.security_sources WHERE owner=$1 AND installation_id=$2 AND state='active' ORDER BY binding_id LIMIT 257`,[owner,admission.actor.installationId]);
    if(rows.rows.length>256||rows.rows.some(row=>typeof row.body!=='string'))throw new SecurityError('SOURCE_NOT_AUTHORIZED');
    return rows.rows.map(row=>{
      const source=storedSourceSchema.parse(JSON.parse(String(row.body)));
      if(source.installationId!==admission.actor.installationId||source.bindingId!==row.binding_id||source.programId!==row.program_id)throw new SecurityError('SOURCE_NOT_AUTHORIZED');return source;
    }).filter(source=>source.parentGrant.id===admission.parent.id&&source.parentGrant.revision===admission.parent.revision&&postgresConsentDeadline(source.expiresAt,options.policyDigest)>Date.now());
  }
}
