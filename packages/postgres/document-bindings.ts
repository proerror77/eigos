import {postgresConsentDeadline,postgresConstrainConsent} from './consent.js';
import type {Client} from 'pg';
import {z} from 'zod';
import {digest} from '../core/delegation.js';
import {DomainError,type Principal} from '../core/domain.js';
import {bindingDigest} from '../core/catalog.js';
import {actionDiscoverySchema,type ActionBindingPin,type ActionDiscoveryPage,type ActionDiscoveryQuery,type DiscoveredActionBinding} from '../core/action-bindings.js';
import {DocumentAgentProgram} from '../capabilities/document-agent.js';
import {documentDefinition} from '../capabilities/document-program.js';
import {actionVersion,actionEffects} from '../ontology/composition-contract.js';
import type {ServiceRequest} from '../ontology/execution.js';
import type {StagedKernelBuilder} from '../ontology/seed-definition.js';
import {parsePipelineIntake} from '../ontology/pipeline/contracts.js';
import {describeDefinitionCatalogue} from '../security/definition-view.js';
import {storedSourceSchema} from '../security/source-policy.js';
import {SecurityError} from '../security/errors.js';
import {postgresBusinessSchema,postgresBusinessToken,postgresConstrainReadDeadline,postgresRequireLeaseAtCommit} from './runtime-transaction.js';
import {postgresClaimSnapshotMatches,postgresWorkReference,type PostgresWorkReference} from './work-claim.js';
import {withPostgresWorkerEvidenceAuthorization,type PostgresTaskReadAuthorization} from './task-output.js';
import type {PostgresTaskReadAdmission} from './task-read-access.js';
import {withPostgresTaskDefinitionAccess} from './ontology-metadata.js';
import {postgresOntologyRelease} from './ontology-release.js';
import {assertPostgresPlanningDiscoveryContext,type PostgresPlanningDiscoveryContext} from './native-planning-session.js';
import type {ProjectionMetadata,GraphStorage} from '../ontology/graph-program.js';

export interface PostgresDocumentBindingOptions {
  policyDigest:string;modelChannel:string;builder?:StagedKernelBuilder;sourceBindingId?:string;
  inspectClaim:(claim:PostgresWorkReference)=>Promise<{validUntil:number}|undefined>;
}
function fail(message:string):never{throw new DomainError('CONFLICT',message);}
const same=(a:unknown,b:unknown)=>digest(a)===digest(b);

/** Exact pure pin rules of ExecutionCatalog.discoverActions, applied only to
 * the actual installed document program and its current pinned definition. */
function documentPin(graph:ProjectionMetadata,owner:string,request:ServiceRequest,program:DocumentAgentProgram):ActionBindingPin{
  const action=documentDefinition(graph,'ComposeDocument'),provider=program.listingBinding();
  if(!graph.releaseRef)fail('Document discovery requires the original published ontology release');
  const body:Omit<ActionBindingPin,'digest'>={ref:{id:`action:${digest({program:program.ref,actionId:action.id})}`,version:actionVersion(action)??'unversioned'},programRef:program.ref,actionId:action.id,actionVersion:actionVersion(action)??'unversioned',definitionDigest:digest(action),
    ...(action.composition?{compositionDigest:digest(action.composition)}:{}),configurationDigest:program.configurationDigest,
    providerBinding:provider.ref,providerSnapshot:structuredClone(provider),providerDefinitionDigest:bindingDigest(provider),ontologyRelease:graph.releaseRef,ownerDigest:digest(owner),requestId:request.id,requestRevision:request.revision};
  return {...body,digest:digest(body)};
}

/** Current document binding discovery. It shares the original Worker read
 * admission, but performs its own source and exact pinned-definition checks.
 * A listed binding is metadata only; every invocation retains its own policy. */
export async function discoverPostgresDocumentBindings(client:Client,input:PostgresWorkReference,requestInput:ServiceRequest,supplied:ActionDiscoveryQuery,options:PostgresDocumentBindingOptions,scope?:PostgresPlanningDiscoveryContext):Promise<ActionDiscoveryPage>{
  const token=postgresBusinessToken(client),schema=postgresBusinessSchema(client),claim=postgresWorkReference(input),request=structuredClone(requestInput),{cursor,...query}=actionDiscoverySchema.parse(supplied),q=`"${schema}"`;
  const active=()=>{if(scope)assertPostgresPlanningDiscoveryContext(scope);if(postgresBusinessToken(client)!==token)throw new SecurityError('AUTHORIZATION_REQUIRED');};
  if(!/^[a-f0-9]{64}$/.test(options.policyDigest)||!options.modelChannel||typeof options.inspectClaim!=='function')throw new Error('Explicit checked document discovery is required');
  if(scope)assertPostgresPlanningDiscoveryContext(scope);
  if(scope&&(scope.client!==client||!same(scope.claim,claim)||scope.policyDigest!==options.policyDigest||scope.modelChannel!==options.modelChannel))throw new SecurityError('POLICY_CHANGED');
  if(request.id!==claim.job.id||request.revision!==claim.job.delegation?.request.revision)throw new SecurityError('POLICY_CHANGED');
  const sql=async(text:string,values:unknown[]=[])=>{active();const result=await client.query(text,values);active();return result;};
  if(!await postgresClaimSnapshotMatches(client,claim,options.policyDigest)||!await options.inspectClaim(claim))throw new SecurityError('ACCESS_REVOKED');
  postgresRequireLeaseAtCommit(client,digest(claim),()=>options.inspectClaim(claim));
  const read=async(auth:PostgresTaskReadAuthorization,admission:PostgresTaskReadAdmission,principal:Principal):Promise<ActionDiscoveryPage>=>{
    if(admission.actor.actorKind!=='worker'||admission.actor.taskId!==claim.job.id||admission.grant.taskId!==claim.job.id||admission.grant.requestRevision!==request.revision||admission.actor.authEpoch!==claim.securityEpoch||admission.policyRevision!==claim.securityPolicyRevision)throw new SecurityError('AUTHORIZATION_REQUIRED');
    const root=await auth.readTaskRoot();if(root.object.properties.revision!==request.revision||root.object.properties.originalGoal!==request.originalGoal)throw new SecurityError('POLICY_CHANGED');
    return withPostgresTaskDefinitionAccess(client,principal,request.id,options.policyDigest,async(access,model)=>{
      const rows=await sql(`SELECT CASE WHEN octet_length((body::json#>'{delegation,ontologyRelease}')::text)<=1024 THEN(body::json#>'{delegation,ontologyRelease}')::text END AS release FROM ${q}.jobs WHERE owner=$1 AND id=$2 LIMIT 2`,[claim.owner,request.id]);
      if(rows.rowCount!==1||typeof rows.rows[0].release!=='string')throw new SecurityError('POLICY_CHANGED');
      const release=await postgresOntologyRelease(client,JSON.parse(rows.rows[0].release),options.builder),program=new DocumentAgentProgram(),environment=request.executionEnvironment??'live',items:ActionDiscoveryPage['items']=[];
      if(!same(release.model.ref,model.ref))throw new SecurityError('POLICY_CHANGED');
      for(const type of [query.inputType,query.outputType])if(type&&!model.hasType(type))throw new DomainError('INVALID_INPUT','Unknown action discovery type');
      const permitted=admission.parent.capabilityIds.includes(program.ref.id)&&program.permitted()&&(!query.programRef||same(query.programRef,program.ref));
      const action=model.action('ComposeDocument'),version=actionVersion(action),capability=program.capability(),operation=action.operation;
      const supported=operation?.effect==='local'&&version==='1'&&same(operation.inputSchema,z.toJSONSchema(program.schema(action.id)))&&model.actionImplementation(action.id)?.kind==='trusted';
      if(permitted&&supported&&(!query.actionId||query.actionId===action.id)
        &&(!query.inputType||Object.values(action.inputs).some(type=>model.assignableType(query.inputType!,type)))
        &&(!query.outputType||action.resultTypes?.some(type=>model.assignableType(type,query.outputType!)))
        &&(!query.effects||actionEffects(action).every(effect=>query.effects!.includes(effect)))
        &&(!query.search||`${action.id} ${action.description} ${capability.name} ${capability.description} ${capability.tags.join(' ')}`.toLocaleLowerCase().includes(query.search.toLocaleLowerCase()))){
        // The shared definition filter includes concrete/interface metadata
        // eligibility. It never grants an object value or action execution.
        let visible=false;try{visible=describeDefinitionCatalogue(access,{actions:[action.id],kind:'actions'},model).actions.some(value=>value.id===action.id);}catch(error){if(!(error instanceof SecurityError&&error.reason==='INSUFFICIENT_ACCESS'))throw error;}
        if(visible){
          const sourceRows=await sql(`SELECT binding_id,program_id,CASE WHEN octet_length(body)<=65536 THEN body END AS body FROM ${q}.security_sources WHERE owner=$1 AND installation_id=$2 AND state='active' LIMIT 257`,[claim.owner,admission.actor.installationId]);
          if(sourceRows.rows.length>256||sourceRows.rows.some(row=>typeof row.body!=='string'))throw new SecurityError('SOURCE_NOT_AUTHORIZED');
          const sources=sourceRows.rows.map(row=>{const source=storedSourceSchema.parse(JSON.parse(row.body));if(source.bindingId!==row.binding_id||source.programId!==row.program_id||source.installationId!==admission.actor.installationId)throw new SecurityError('SOURCE_NOT_AUTHORIZED');return source;}).filter(source=>source.programId===program.ref.id&&source.programDigest===program.configurationDigest&&source.operations.includes(action.id)&&(!options.sourceBindingId||source.bindingId===options.sourceBindingId)
            &&source.parentGrant.id===admission.parent.id&&source.parentGrant.revision===admission.parent.revision&&admission.parent.sourceBindingIds.includes(source.bindingId)&&postgresConsentDeadline(source.expiresAt,options.policyDigest,model)>Date.now()
            &&['DocumentTask','DocumentDraft'].every(type=>source.outputTypes.includes(type)&&admission.grant.outputs.some(output=>output.type===type&&output.programId===source.programId&&output.programDigest===source.programDigest&&output.sourceBindingId===source.bindingId&&output.fields.every(field=>admission.parent.resources.some(resource=>resource.type===type&&resource.fields.includes(field))))));
          let readiness:DiscoveredActionBinding['readiness']=sources.length===1?'ready':'source_authorization_required',reason=sources.length===1?'Exact task-scoped action binding; current inputs and effect authorization must still pass':'The exact document source binding requires current owner approval';
          if(sources.length===1)postgresConstrainConsent(client,sources[0]!.expiresAt,options.policyDigest,model);
          // Resolve only the relevant program's published intake. Unrelated
          // services' pending/expired verification never blocks document work.
          // Matching intake semantics need their real verifier port; absence
          // of that port is never interpreted as a successful pipeline proof.
          const refs=release.document.pipeline??[];if(refs.length>256)fail('Published intake metadata exceeds its bounded read');
          let matching=false;
          for(const ref of refs){
            const found=await sql(`SELECT CASE WHEN octet_length(body)<=8388608 THEN body END AS body FROM ${q}.ontology_pipeline_intakes WHERE ontology_id=$1 AND digest=$2 AND service_id=$3 LIMIT 2`,[release.document.id,ref.intakeDigest,ref.serviceId]);
            if(found.rowCount!==1||typeof found.rows[0].body!=='string')throw new SecurityError('AUTHORITY_UNAVAILABLE','Published pipeline intake metadata is unavailable');
            const intake=parsePipelineIntake(JSON.parse(found.rows[0].body));if(digest(intake)!==ref.intakeDigest)throw new SecurityError('POLICY_CHANGED');
            if(intake.programRef.id===program.ref.id&&intake.actions.some(value=>value.actionId===action.id))matching=true;
          }
          if(matching&&readiness==='ready'){readiness='pipeline_unverified';reason='The published document intake requires its installed PostgreSQL pipeline verifier';}
          if(query.serviceConditions&&readiness==='ready'){readiness='conditions_unmet';reason='The document binding has no declared regional, payment or operator availability conditions';}
          const binding:DiscoveredActionBinding={pin:documentPin({model,releaseRef:release.ref,now:Date.now},claim.owner,request,program),readiness,reason,environment:capability.environment??'local',inputSchema:capability.inputSchema,
            capability:{name:capability.name,description:capability.description,predicates:capability.predicates,outcomePredicates:capability.outcomePredicates??[],requirementRoles:capability.requirementRoles??[],...(capability.locationSemantics?{locationSemantics:capability.locationSemantics}:{}),...(capability.effectConstraints?{effectConstraints:capability.effectConstraints}:{})},
            completionSchema:program.completionSchema,guidance:program.guidance,...(capability.goalOutcomes?{goalOutcomes:capability.goalOutcomes}:{})};
          items.push({action,bindings:[binding],status:readiness==='ready'?'available':'not_ready'});
        }
      }
      const snapshotDigest=digest({owner:claim.owner,requestId:request.id,revision:request.revision,environment,release:release.ref,query:{...query,limit:undefined},items});
      let offset=0;if(cursor){let decoded:unknown;try{decoded=JSON.parse(Buffer.from(cursor,'base64url').toString());}catch{throw new DomainError('INVALID_INPUT','Invalid action discovery cursor');}const page=decoded as {snapshot?:unknown;offset?:unknown};if(!page||typeof page!=='object'||page.snapshot!==snapshotDigest||!Number.isInteger(page.offset)||Number(page.offset)<0||Number(page.offset)>items.length)fail('Action discovery cursor no longer matches the task, permissions or bindings');offset=Number(page.offset);}
      const selected=items.slice(offset,offset+query.limit),hasMore=offset+selected.length<items.length;
      active();return {ontologyRelease:release.ref,requestId:request.id,requestRevision:request.revision,items:structuredClone(selected),page:{limit:query.limit,hasMore,...(hasMore?{cursor:Buffer.from(JSON.stringify({snapshot:snapshotDigest,offset:offset+selected.length})).toString('base64url')}: {})},authorization:'per_action_required',allowedEffects:query.effects??['local','read','object_write',...(environment==='sandbox'?['reserve','order','payment','change','cancel','refund'] as const:[])],snapshotDigest};
    },options.builder);
  };
  return scope?read(scope.authorization,scope.admission,scope.principal):withPostgresWorkerEvidenceAuthorization(client,claim,options.policyDigest,read,options.builder,options.modelChannel,options.inspectClaim);
}

export async function resolvePostgresDocumentBinding(client:Client,claim:PostgresWorkReference,request:ServiceRequest,pin:ActionBindingPin,options:PostgresDocumentBindingOptions,scope?:PostgresPlanningDiscoveryContext){
  const {digest:expected,...body}=pin;if(digest(body)!==expected||pin.ownerDigest!==digest(claim.owner)||pin.requestId!==request.id||pin.requestRevision!==request.revision)throw new SecurityError('POLICY_CHANGED');
  const page=await discoverPostgresDocumentBindings(client,claim,request,{actionId:pin.actionId,programRef:pin.programRef},options,scope),binding=page.items.flatMap(item=>item.bindings).find(value=>same(value.pin,pin));
  if(!binding||binding.readiness!=='ready')throw new SecurityError(binding?.readiness==='source_authorization_required'?'SOURCE_NOT_AUTHORIZED':'AUTHORITY_UNAVAILABLE',binding?.reason??'The exact registered document binding is unavailable');
  return {program:new DocumentAgentProgram(),binding};
}

/** Adapter for the actual NativePlanningSession host callback. A retained
 * callback/client cannot borrow a later transaction or a closed read scope. */
export async function discoverPostgresDocumentActions(graph:ProjectionMetadata&GraphStorage,owner:string,request:ServiceRequest,input:ActionDiscoveryQuery,context:PostgresPlanningDiscoveryContext,options:PostgresDocumentBindingOptions){
  assertPostgresPlanningDiscoveryContext(context);if(owner!==context.claim.owner||request.id!==context.claim.job.id||context.policyDigest!==options.policyDigest||context.modelChannel!==options.modelChannel)throw new SecurityError('POLICY_CHANGED');
  await graph.read(owner,{type:'ServiceRequest',id:request.id});assertPostgresPlanningDiscoveryContext(context);
  const page=await discoverPostgresDocumentBindings(context.client,context.claim,request,input,options,context);assertPostgresPlanningDiscoveryContext(context);
  if(!same(page.ontologyRelease,graph.releaseRef))throw new SecurityError('POLICY_CHANGED');return page;
}
