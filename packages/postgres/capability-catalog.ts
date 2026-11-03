import {randomUUID} from 'node:crypto';
import type {Client} from 'pg';
import {z} from 'zod';
import {digest} from '../core/delegation.js';
import type {ExecutionCatalog} from '../core/catalog.js';
import type {AgentProgram} from '../core/agent-program.js';
import type {ServiceCapability} from '../ontology/execution.js';
import {projectCapabilityCatalogProgram,readCapabilityCatalogProgram} from '../ontology/capability-catalog.js';
import {runGraphProgramAsync} from '../ontology/graph-program.js';
import type {StagedKernelBuilder} from '../ontology/seed-definition.js';
import {parsePipelineIntake} from '../ontology/pipeline/contracts.js';
import {SecurityError} from '../security/errors.js';
import {postgresBusinessSchema,postgresBusinessToken,postgresConstrainReadDeadline,postgresRequireLeaseAtCommit} from './runtime-transaction.js';
import {postgresWorkReference,postgresClaimSnapshotMatches,type PostgresWorkReference} from './work-claim.js';
import {postgresWorkerAdmission} from './worker-admission.js';
import {postgresWorkerRequest} from './worker-input.js';
import {PostgresTaskStorage} from './task-storage.js';
import {PostgresProjectionGraph} from './projection-graph.js';
import {postgresOntologyRelease} from './ontology-release.js';
import {withPostgresWorkerEvidenceAuthorization} from './task-output.js';
import {withPostgresTaskDefinitionAccess} from './ontology-metadata.js';
import {withPostgresPlanningReadGraph} from './planning-read-graph.js';

type Summary=ReturnType<ExecutionCatalog['summaries']>[number];
/** Host registry entries contain actual configured program methods. Request
 * JSON, an MCP argument or a model-authored summary is not a registry entry. */
export interface PostgresCapabilityCatalogEntry {
  readonly capability:ServiceCapability;
  readonly program:Pick<AgentProgram,'ref'|'configurationDigest'|'actionIds'|'capability'|'permitted'|'listingBinding'>;
}
export interface PostgresCapabilityCatalogOptions {
  policyDigest:string;modelChannel:string;builder?:StagedKernelBuilder;
  inspectClaim:(claim:PostgresWorkReference)=>Promise<{validUntil:number}|undefined>;
}
export interface PostgresCapabilityCatalogPage {items:Summary[];hasMore:boolean}
const ref=z.strictObject({id:z.string().min(1).max(200),version:z.string().min(1).max(80)});
const same=(a:unknown,b:unknown)=>digest(a)===digest(b);
const basicFields=['id','name','capabilityRef','description','tags','inputSchema','predicates','outcomePredicates','requirementRoles','definitionDigest'];
function registration(entry:PostgresCapabilityCatalogEntry,owner:string){
  const program=entry.program;
  if(!program||typeof program.capability!=='function'||typeof program.permitted!=='function'
    ||!/^[a-f0-9]{64}$/.test(program.configurationDigest)||!Array.isArray(program.actionIds))throw new SecurityError('AUTHORITY_UNAVAILABLE','Server-registered capability metadata is required');
  ref.parse(program.ref);const capability=structuredClone(program.capability());ref.parse(capability.ref);
  if(!same(capability,entry.capability))throw new SecurityError('POLICY_CHANGED','Capability metadata differs from its configured program');
  const binding=program.listingBinding?.(),permitted=program.permitted(owner);
  if(typeof permitted!=='boolean'||binding&&!same(binding.capabilityRef,capability.ref))throw new SecurityError('POLICY_CHANGED','Capability listing identity differs from its configured program');
  return structuredClone({capability,programRef:program.ref,configurationDigest:program.configurationDigest,actionIds:[...program.actionIds],binding,permitted});
}
function summary(capability:ServiceCapability):Summary{
  return {ref:structuredClone(capability.ref),name:capability.name,description:capability.description,tags:[...capability.tags],inputSchema:structuredClone(capability.inputSchema),
    predicates:structuredClone(capability.predicates),outcomePredicates:[...(capability.outcomePredicates??[])],requirementRoles:structuredClone(capability.requirementRoles??[]),
    ...(capability.goalOutcomes?{goalOutcomes:structuredClone(capability.goalOutcomes)}:{}),locationSemantics:capability.locationSemantics,constraintEvaluation:capability.constraintEvaluation,scopeReviewMode:capability.scopeReviewMode,sourceAuthorization:undefined};
}

/** The same task-owned capability projection as JobStore.projectCapabilities.
 * This writes reviewed task_context metadata, never a source result, an asset
 * input, execution permission or a new grant. The caller owns the business
 * transaction; no model/provider I/O or automatic replay occurs here. */
export async function postgresProjectCapabilityCatalog(client:Client,input:PostgresWorkReference,entries:readonly PostgresCapabilityCatalogEntry[],options:PostgresCapabilityCatalogOptions):Promise<PostgresCapabilityCatalogPage>{
  const schema=postgresBusinessSchema(client),token=postgresBusinessToken(client),q=`"${schema}"`,claim=postgresWorkReference(input);
  if(!/^[a-f0-9]{64}$/.test(options.policyDigest)||!options.modelChannel||typeof options.inspectClaim!=='function'||entries.length>200)throw new Error('Explicit bounded PostgreSQL capability catalogue authority is required');
  if(claim.recovery||claim.job.state!=='working')throw new SecurityError('ACCESS_REVOKED');
  options={...options};const registry=[...entries],captured=registry.map(entry=>registration(entry,claim.owner));
  if(new Set(captured.map(value=>digest(value.programRef))).size!==captured.length)throw new SecurityError('POLICY_CHANGED','Capability catalogue program registrations are ambiguous');
  const definitions=new Map<string,string>();for(const value of captured){const key=digest(value.capability.ref),body=digest(value.capability),previous=definitions.get(key);if(previous&&previous!==body)throw new SecurityError('POLICY_CHANGED','Capability catalogue definitions are ambiguous');definitions.set(key,body);}
  const active=()=>{if(postgresBusinessToken(client)!==token)throw new SecurityError('AUTHORIZATION_REQUIRED');};
  const fence=async()=>{
    active();if(!await postgresClaimSnapshotMatches(client,claim,options.policyDigest))throw new SecurityError('ACCESS_REVOKED');
    const lease=await options.inspectClaim(claim);if(!lease||!Number.isSafeInteger(lease.validUntil)||lease.validUntil<=Date.now())throw new SecurityError('ACCESS_REVOKED');
    const admission=await postgresWorkerAdmission(client,claim.owner,claim.job.id,options.policyDigest);
    if(admission.authority.id!==claim.securityAuthorityId||admission.authority.authEpoch!==claim.securityEpoch||admission.policyRevision!==claim.securityPolicyRevision)throw new SecurityError('POLICY_CHANGED');
    postgresConstrainReadDeadline(client,admission.validUntil);postgresRequireLeaseAtCommit(client,digest(claim),()=>options.inspectClaim(claim));return admission;
  };
  await fence();const name=`catalogue_${randomUUID().replaceAll('-','')}`;await client.query(`SAVEPOINT ${name}`);
  try{
    const request=await postgresWorkerRequest(client,claim,options.policyDigest,options.modelChannel,options.builder,options.inspectClaim);
    const before=await fence(),store=new PostgresTaskStorage(client,options.builder),job=await store.get(claim.owner,claim.job.id),release=job.delegation?.ontologyRelease;
    if(!release||job.delegation?.request.revision!==request.revision)throw new SecurityError('POLICY_CHANGED');
    const eligible=captured.filter(value=>value.permitted&&(!value.binding||value.binding.enabled&&value.binding.configurationDigest===value.configurationDigest)
      &&[value.programRef.id,value.capability.ref.id].some(id=>before.parent.capabilityIds.includes(id))&&before.grant.outputs.some(output=>output.programId===value.programRef.id)
      &&(request.executionEnvironment==='sandbox'?value.capability.environment!=='live':value.capability.environment!=='sandbox')
      &&(!request.capabilityRef||same(request.capabilityRef,value.capability.ref)));
    const visible=[...new Map(eligible.map(value=>[digest(value.capability.ref),value.capability])).values()],selected=eligible.filter(value=>visible.slice(0,16).some(capability=>same(capability.ref,value.capability.ref))),items=visible.slice(0,16).map(summary);
    // Source summaryPage checks published Pipeline status when supplied the
    // task graph. Until its PostgreSQL reader exists, never invent unmanaged
    // readiness for a related published intake. Unrelated intakes do not gate
    // the selected configured program or its metadata.
    const pinned=await postgresOntologyRelease(client,release,options.builder);
    for(const reference of pinned.document.pipeline??[]){
      const rows=await client.query(`SELECT CASE WHEN octet_length(body)<=1048576 THEN body END AS body FROM ${q}.ontology_pipeline_intakes WHERE ontology_id=$1 AND digest=$2 AND service_id=$3 LIMIT 2`,[release.ontologyId,reference.intakeDigest,reference.serviceId]);
      if(rows.rowCount!==1||typeof rows.rows[0].body!=='string')throw new SecurityError('POLICY_CHANGED','Published capability Pipeline intake is unavailable');
      const intake=parsePipelineIntake(JSON.parse(rows.rows[0].body));if(digest(intake)!==reference.intakeDigest||intake.serviceId!==reference.serviceId)throw new SecurityError('POLICY_CHANGED');
      if(selected.some(value=>value.programRef.id===intake.programRef.id&&intake.actions.some(action=>value.actionIds.includes(action.actionId))))throw new SecurityError('AUTHORITY_UNAVAILABLE','PostgreSQL capability catalogue Pipeline readiness adapter is not installed');
    }
    await withPostgresWorkerEvidenceAuthorization(client,claim,options.policyDigest,(_auth,_admission,principal)=>
      withPostgresTaskDefinitionAccess(client,principal,job.id,options.policyDigest,async access=>{
        if(!access.resourceAllowed('objectType','RegisteredCapability')||!access.resourceAllowed('linkType','CapabilityRequest'))throw new SecurityError('INSUFFICIENT_ACCESS');
        const allowed=access.parent.resources.find(resource=>resource.type==='RegisteredCapability')?.fields??[];
        for(const item of items){const fields=[...basicFields,...(['goalOutcomes','locationSemantics','constraintEvaluation','scopeReviewMode'] as const).filter(field=>!!item[field])];
          if(fields.some(field=>!allowed.includes(field)||!Object.hasOwn(access.fields('RegisteredCapability'),field)||access.fieldPolicy('RegisteredCapability',field)==='internal_only'))throw new SecurityError('INSUFFICIENT_ACCESS');}
      },options.builder),options.builder,options.modelChannel,options.inspectClaim);
    const graph=await PostgresProjectionGraph.create(client,claim.owner,release,options.builder);
    await graph.run(metadata=>projectCapabilityCatalogProgram(metadata,claim.owner,job.id,items));
    await store.save(claim.owner,job);
    const actual=await withPostgresWorkerEvidenceAuthorization(client,claim,options.policyDigest,(auth,admission,principal)=>
      withPostgresPlanningReadGraph(client,principal,job.id,options.policyDigest,auth,admission,async read=>{
        const result=await runGraphProgramAsync(read,readCapabilityCatalogProgram(read,claim.owner,job.id)),influence=await read.authorize();
        if(influence)await client.query(`INSERT INTO ${q}.security_reads(grant_id,digest,body) VALUES($1,$2,$3) ON CONFLICT(grant_id,digest) DO NOTHING`,[admission.grant.id,digest(influence),JSON.stringify(influence)]);
        return result;
      },options.builder),options.builder,options.modelChannel,options.inspectClaim);
    if(!same(items,actual)||!same(before,await fence())||!same(captured,registry.map(entry=>registration(entry,claim.owner))))throw new SecurityError('POLICY_CHANGED');
    await client.query(`RELEASE SAVEPOINT ${name}`);return {items:structuredClone(actual),hasMore:visible.length>items.length};
  }catch(error){await client.query(`ROLLBACK TO SAVEPOINT ${name}`);await client.query(`RELEASE SAVEPOINT ${name}`);throw error;}
}
