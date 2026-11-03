import type {Client} from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {DomainError,ownerKey,requireScope,type Job,type Principal} from '../core/domain.js';
import {digest} from '../core/delegation.js';
import type {AgentProgram} from '../core/agent-program.js';
import {BACKEND_VERSION,type Ref} from '../ontology/execution.js';
import {objectRefSchema,type ObjectRef} from '../ontology/model.js';
import {assertDefinitionJson,ontologyReleaseRefSchema,type OntologyReleaseRef} from '../ontology/definition-contracts.js';
import {prepareObservationSchema,type ObservationContract,type ObservationContractView,type ObservationPins} from '../ontology/observation-contract.js';
import type {StagedKernelBuilder} from '../ontology/seed-definition.js';
import {SecurityError} from '../security/errors.js';
import {storedSourceSchema} from '../security/source-policy.js';
import {postgresConsentIndex} from './consent.js';
import {postgresBusinessSchema,postgresConstrainReadDeadline} from './runtime-transaction.js';
import {PostgresTaskStorage} from './task-storage.js';
import {PostgresDefinitionStore} from './definition-store.js';
import {withPostgresTaskQueryAuthorization,withPostgresTaskReadAuthorization} from './task-output.js';
import {withPostgresPlanningReadGraph} from './planning-read-graph.js';
import {postgresTaskResourcePermissionValidUntil,postgresTaskFieldClassification,type PostgresTaskReadAdmission} from './task-read-access.js';

export type PostgresObservationProgram=Pick<AgentProgram,'ref'|'configurationDigest'|'permitted'|'capability'|'actionIds'|'schema'>;
export interface PostgresObservationOptions {policyDigest:string;builder?:StagedKernelBuilder;
  /** Actual host registry metadata only; no provider/observer is started. */
  resolveProgram?:(client:Client,owner:string,release:OntologyReleaseRef,program:Ref)=>Promise<PostgresObservationProgram|undefined>;
}
const conflict=(message:string):never=>{throw new DomainError('CONFLICT',message);};
const same=(a:unknown,b:unknown)=>digest(a)===digest(b);
const pinsSchema=z.strictObject({release:ontologyReleaseRefSchema,intakeDigest:z.string().regex(/^[a-f0-9]{64}$/),sourceRevision:z.string().min(1).max(200),sourceDigest:z.string().regex(/^[a-f0-9]{64}$/),
  programRef:z.strictObject({id:z.string().min(1).max(200),version:z.string().min(1).max(200)}),configurationDigest:z.string().regex(/^[a-f0-9]{64}$/),actionDigest:z.string().regex(/^[a-f0-9]{64}$/),inputDigest:z.string().regex(/^[a-f0-9]{64}$/),
  installationId:z.string().min(1),memberId:z.string().min(1),parentGrant:z.strictObject({id:z.string().min(1),revision:z.number().int().positive().safe()}),sourceBindingId:z.string().min(1),authEpoch:z.number().int().positive().safe(),policyVersion:z.string().min(1),policyRevision:z.number().int().positive().safe(),expiresAt:z.iso.datetime({offset:true})});

export async function readPostgresObservationContract(client:Client,owner:string,id:string):Promise<ObservationContract>{
  const q=`"${postgresBusinessSchema(client)}"`,rows=await client.query(`SELECT original_task_id,revision,status,until_ms,CASE WHEN octet_length(body)<=8388608 THEN body END AS body FROM ${q}.observation_contracts WHERE owner=$1 AND task_id=$2 LIMIT 2`,[owner,id]);
  if(!rows.rowCount)throw new DomainError('NOT_FOUND','Observation contract is unavailable');
  if(rows.rowCount!==1||typeof rows.rows[0]?.body!=='string')return conflict('Observation contract exceeds its read bound');
  const row=rows.rows[0],value=JSON.parse(row.body) as ObservationContract;
  if(!value||value.version!=='1'||value.owner!==owner||value.id!==id||value.revision!==Number(row.revision)||value.status!==row.status||!['configured','revoked'].includes(value.status)
    ||value.revocationRevision!==(value.status==='revoked'?1:0)||value.revision!==value.revocationRevision+1)return conflict('Observation contract integrity or revision changed');
  const declaration=prepareObservationSchema.parse(value.declaration),pins=pinsSchema.parse(value.pins);
  if(declaration.originalTaskId!==row.original_task_id||Date.parse(declaration.until)!==Number(row.until_ms)||value.digest!==digest({declaration,pins}))return conflict('Observation contract integrity or revision changed');
  z.strictObject({reads:z.number().int().nonnegative().safe(),modelTurns:z.number().int().nonnegative().safe(),activeMs:z.number().int().nonnegative().safe(),costMinor:z.string().regex(/^\d+$/)}).parse(value.usage);
  return {...value,declaration,pins};
}

/** Real stage-one registration only. The completed original task remains
 * untouched; no Worker authority, scheduler or source account proof is issued. */
export async function preparePostgresObservationContract(client:Client,p:Principal,input:unknown,contextId:string|undefined,options:PostgresObservationOptions):Promise<Job>{
  requireScope(p,'tasks:write');requireScope(p,'tasks:read');const args=prepareObservationSchema.parse(input),owner=ownerKey(p),store=new PostgresTaskStorage(client,options.builder);
  assertDefinitionJson(args.read.input);if(Buffer.byteLength(JSON.stringify(args.read.input))>16000)throw new DomainError('INVALID_INPUT','Observation read input exceeds its bound');
  const original=await store.get(owner,args.originalTaskId);
  await withPostgresTaskReadAuthorization(client,p,original.id,options.policyDigest,auth=>auth.readTaskRoot(),options.builder);
  if(contextId&&contextId!==original.contextId)throw new DomainError('INVALID_INPUT','Context does not match the original task');
  if(original.state!=='completed'||original.delegation?.backendVersion!==BACKEND_VERSION||original.delegation.observationContract||original.revision!==args.expectedRevision||original.delegation.recoveryPending)return conflict('Select the current completed business task; its history cannot be reopened');
  if((await store.intents(owner,original.id)).some(intent=>!['read','local'].includes(intent.effect)&&['dispatching','awaiting_remote','effect_unknown','needs_review'].includes(intent.state)))return conflict('Reconcile the original business operation before delegating observation');
  const checked=await withPostgresTaskQueryAuthorization(client,p,original.id,options.policyDigest,async(auth,admission)=>{
    await auth.readTaskRoot();const definitions=new PostgresDefinitionStore(client,{builder:options.builder}),release=await definitions.resolve(original.delegation!.ontologyRelease!),selected=release.document.pipeline?.find(value=>value.serviceId===args.source.serviceId);
    if(!selected)throw new DomainError('FORBIDDEN','The selected source read is not currently authorized');
    const intake=await definitions.pipeline.intake(release.ref.ontologyId,selected),active=(await definitions.active(release.ref.ontologyId)).document.pipeline?.find(value=>value.serviceId===args.source.serviceId);
    if(active?.intakeDigest!==selected.intakeDigest)return conflict('The source mapping changed; select a current source contract');
    if((await definitions.pipeline.validateIntake(release.ref.ontologyId,selected,release.model)).length)return conflict('The published mapping needs current validation');
    const q=`"${postgresBusinessSchema(client)}"`,rows=await client.query(`SELECT binding_id,program_id,CASE WHEN octet_length(body)<=65536 THEN body END AS body FROM ${q}.security_sources WHERE owner=$1 AND installation_id=$2 AND state='active' LIMIT 257`,[owner,admission.actor.installationId]);
    if(rows.rows.length>256||rows.rows.some(row=>typeof row.body!=='string'))throw new SecurityError('SOURCE_NOT_AUTHORIZED');
    const source=rows.rows.map(row=>{const value=storedSourceSchema.parse(JSON.parse(row.body));if(value.bindingId!==row.binding_id||value.programId!==row.program_id||value.installationId!==admission.actor.installationId)throw new SecurityError('SOURCE_NOT_AUTHORIZED');return value;})
      .find(value=>value.programId===intake.programRef.id&&value.programDigest===intake.configurationDigest&&value.operations.includes(args.read.action)&&value.outputTypes.includes(args.target.object.type)
        &&value.parentGrant.id===admission.parent.id&&value.parentGrant.revision===admission.parent.revision&&admission.parent.capabilityIds.includes(value.programId)&&admission.parent.sourceBindingIds.includes(value.bindingId)&&postgresConsentIndex(value.expiresAt,options.policyDigest)>Date.now());
    if(!source)throw new DomainError('FORBIDDEN','The selected source read is not currently authorized');
    const mapping=intake.mappings.find(value=>value.id===args.source.mappingId)??conflict('The selected source mapping is unavailable');
    if(mapping.objectType!==args.target.object.type||args.maxStalenessMs>mapping.maxAgeMs)return conflict('The selected object or freshness limit differs from the published mapping');
    if(args.target.fields.some(field=>!mapping.fields.some(value=>value.to[0]===field)))return conflict('Observed fields must be supplied by the selected source mapping');
    const program=await options.resolveProgram?.(client,owner,release.ref,intake.programRef);
    if(!program)throw new SecurityError('AUTHORITY_UNAVAILABLE','The original configured PostgreSQL source metadata adapter is not installed');
    const definition=release.model.action(args.read.action),action=intake.actions.find(value=>value.actionId===args.read.action);
    if(!program.permitted(owner)||!same(program.ref,intake.programRef)||program.configurationDigest!==intake.configurationDigest||(program.capability().environment??'local')!==intake.environment||!program.actionIds.includes(args.read.action)||!definition.read||definition.operation||definition.read.effect!=='read'||!action||action.definitionDigest!==digest(definition))return conflict('Observation requires an exact published source read action');
    const permission=await postgresTaskResourcePermissionValidUntil(client,p,original.id,options.policyDigest,'actionType',args.read.action,'action.execute',options.builder);if(permission<=Date.now())throw new SecurityError('AUTHORIZATION_REQUIRED');postgresConstrainReadDeadline(client,permission);
    const until=Math.min(Date.parse(args.until),postgresConsentIndex(admission.parent.expiresAt,options.policyDigest),postgresConsentIndex(source.expiresAt,options.policyDigest));if(Date.parse(args.until)>until)return conflict('Observation cannot outlive the current installation and source permission');
    const normalized=z.record(z.string(),z.unknown()).parse(program.schema(args.read.action).parse(args.read.input));assertDefinitionJson(normalized);if(Buffer.byteLength(JSON.stringify(normalized))>16000)return conflict('The normalized read input exceeds its bound');
    await withPostgresPlanningReadGraph(client,p,original.id,options.policyDigest,auth,admission,async graph=>{
      const target=(await graph.query(owner,{object:args.target.object,select:args.target.fields})).items[0]??conflict('The selected source object is unavailable');
      if(target.revision!==args.target.revision)return conflict('The selected source object revision changed');
      for(const relation of args.target.relations){const nav=graph.model.navigation(target.ref.type,relation);if(!mapping.links?.some(value=>value.linkType===nav.link.id))return conflict('Observed relationships must come from the selected mapping');
        const permission=await postgresTaskResourcePermissionValidUntil(client,p,original.id,options.policyDigest,'linkType',nav.link.id,'resource.view',options.builder);if(permission<=Date.now())throw new SecurityError('AUTHORIZATION_REQUIRED');postgresConstrainReadDeadline(client,permission);}
      if(args.terminal.kind==='source_evidence'){const property=graph.model.properties(target.ref.type)[args.terminal.field];if(!property||!['string','boolean','integer','decimal','timestamp'].includes(property.kind)||!property.schema.safeParse(args.terminal.equals).success)return conflict('Terminal evidence must match a selected scalar source property');}
      const refs=new Map<string,ObjectRef>();let nodes=0;
      const walk=(value:unknown)=>{if(++nodes>5000)return conflict('Observation input traversal bound exceeded');if(!value||typeof value!=='object')return;const ref=objectRefSchema.safeParse(value);if(ref.success)refs.set(digest(ref.data),ref.data);else for(const child of Object.values(value))walk(child);};walk(normalized);
      if(refs.size>20)return conflict('The read input has too many source references');for(const ref of refs.values()){const type=graph.model.object(ref.type);await graph.query(owner,{object:ref,select:[...new Set([type.primaryKey,type.titleKey])]});}
    },options.builder);
    const pins:ObservationPins={release:release.ref,intakeDigest:selected.intakeDigest,sourceRevision:intake.source.revision,sourceDigest:intake.source.digest,programRef:program.ref,configurationDigest:program.configurationDigest,actionDigest:digest(definition),inputDigest:digest(normalized),installationId:admission.actor.installationId,memberId:admission.actor.memberId,parentGrant:{id:admission.parent.id,revision:admission.parent.revision},sourceBindingId:source.bindingId,authEpoch:admission.actor.authEpoch,policyVersion:admission.actor.policyVersion,policyRevision:admission.policyRevision,expiresAt:new Date(until).toISOString()};
    return {declaration:{...args,read:{...args.read,input:normalized}},pins};
  },options.builder);
  const q=`"${postgresBusinessSchema(client)}"`,now=Date.now(),start=Date.parse(checked.declaration.startsAt),end=Date.parse(checked.declaration.until);
  if(end<=now||end>now+86400000||start<now-60000||end>Date.parse(checked.pins.expiresAt))return conflict('The declared observation window exceeds current authority or the 24-hour horizon');
  const count=Number((await client.query(`SELECT count(*) AS n FROM ${q}.observation_contracts WHERE owner=$1 AND status='configured' AND until_ms>$2`,[owner,now])).rows[0]?.n);if(!Number.isSafeInteger(count)||count>=100)return conflict('Observation contract capacity reached');
  const id=randomUUID(),at=new Date(now).toISOString(),contract:ObservationContract={version:'1',id,owner,revision:1,revocationRevision:0,status:'configured',createdAt:at,...checked,digest:digest(checked),usage:{reads:0,modelTurns:0,activeMs:0,costMinor:'0'}};
  await client.query(`INSERT INTO ${q}.observation_contracts(owner,task_id,original_task_id,revision,status,until_ms,body) VALUES($1,$2,$3,1,'configured',$4,$5)`,[owner,id,args.originalTaskId,end,JSON.stringify(contract)]);
  await client.query(`INSERT INTO ${q}.observation_contract_events(owner,task_id,revision,body) VALUES($1,$2,1,$3)`,[owner,id,JSON.stringify({kind:'configured',at,digest:contract.digest,revocationRevision:0})]);
  const job:Job={id,contextId:original.contextId,service:'eigos.delegate',state:'paused',revision:1,executionMode:'worker',goal:args.goal,messages:[{id:args.requestId,role:'user',text:args.goal,at}],runs:[],createdAt:at,updatedAt:at,
    delegation:{backendVersion:BACKEND_VERSION,ontologyRelease:checked.pins.release,ontologyReadScope:'request',request:{id,revision:1,originalGoal:args.goal,requirements:[],messages:[{id:args.requestId,text:args.goal,receivedAt:at}]},phase:'paused',observationContract:{id,digest:contract.digest},events:[{at,event:'observation_contract_configured',evidence:contract.digest}]}};
  return store.save(owner,job);
}

export async function postgresObservationContractView(client:Client,p:Principal,job:Pick<Job,'id'>,expectedDigest:string,policy:string,admission:PostgresTaskReadAdmission,builder?:StagedKernelBuilder):Promise<ObservationContractView>{
  const owner=ownerKey(p),contract=await readPostgresObservationContract(client,owner,job.id),d=contract.declaration,pins=contract.pins;
  if(pins.installationId!==admission.actor.installationId||contract.digest!==expectedDigest)throw new SecurityError('AUTHORIZATION_REQUIRED');
  let permitted=pins.parentGrant.id===admission.parent.id&&pins.parentGrant.revision===admission.parent.revision&&Date.parse(pins.expiresAt)>Date.now();
  for(const [kind,id,permission]of [['objectType',d.target.object.type,'resource.view'],['actionType',d.read.action,'action.execute']]as const)permitted=(await postgresTaskResourcePermissionValidUntil(client,p,job.id,policy,kind,id,permission,builder))>Date.now()&&permitted;
  permitted=permitted&&d.target.fields.every(field=>admission.parent.resources.some(resource=>resource.type===d.target.object.type&&resource.fields.includes(field)));
  for(const field of d.target.fields)permitted=(await postgresTaskFieldClassification(client,p,job.id,policy,d.target.object.type,field,builder))!=='internal_only'&&permitted;
  const q=`"${postgresBusinessSchema(client)}"`,rows=await client.query(`SELECT binding_id,program_id,CASE WHEN octet_length(body)<=65536 THEN body END AS body FROM ${q}.security_sources WHERE owner=$1 AND installation_id=$2 AND state='active' LIMIT 257`,[owner,admission.actor.installationId]);
  if(rows.rows.length>256||rows.rows.some(row=>typeof row.body!=='string'))throw new SecurityError('SOURCE_NOT_AUTHORIZED');
  permitted=permitted&&rows.rows.some(row=>{const source=storedSourceSchema.parse(JSON.parse(row.body));return source.bindingId===row.binding_id&&source.programId===row.program_id&&source.installationId===admission.actor.installationId&&source.parentGrant.id===admission.parent.id&&source.parentGrant.revision===admission.parent.revision&&source.bindingId===pins.sourceBindingId&&source.programId===pins.programRef.id&&source.programDigest===pins.configurationDigest&&source.operations.includes(d.read.action)&&source.outputTypes.includes(d.target.object.type)&&postgresConsentIndex(source.expiresAt,policy)>Date.now();});
  return {id:job.id,revision:contract.revision,revocationRevision:contract.revocationRevision,status:contract.status==='revoked'?'revoked':Date.parse(d.until)<=Date.now()?'expired':'configured',monitoring:false,targetIdentity:'unverified',activation:'observer_not_installed',sourcePermission:permitted?'current':'unavailable',startsAt:d.startsAt,until:d.until,nextDueAt:contract.status==='configured'&&Date.parse(d.until)>Date.now()?d.startsAt:null,maxStalenessMs:d.maxStalenessMs,strategy:structuredClone(d.strategy),perReadBudget:structuredClone(d.perReadBudget),lifetimeBudget:structuredClone(d.lifetimeBudget),usage:{...contract.usage}};
}

export async function revokePostgresObservationContract(client:Client,owner:string,id:string,expectedDigest:string){
  const value=await readPostgresObservationContract(client,owner,id);if(value.digest!==expectedDigest)return conflict('Observation contract integrity changed');
  if(value.status==='revoked')return;
  const previous=value.revision;value.status='revoked';value.revision++;value.revocationRevision++;value.revokedAt=new Date().toISOString();
  const q=`"${postgresBusinessSchema(client)}"`,written=await client.query(`UPDATE ${q}.observation_contracts SET revision=$1,status=$2,body=$3 WHERE owner=$4 AND task_id=$5 AND revision=$6 AND status='configured'`,[value.revision,value.status,JSON.stringify(value),owner,id,previous]);
  if(written.rowCount!==1)return conflict('Observation contract revision changed');
  await client.query(`INSERT INTO ${q}.observation_contract_events(owner,task_id,revision,body) VALUES($1,$2,$3,$4)`,[owner,id,value.revision,JSON.stringify({kind:'revoked',at:value.revokedAt,digest:value.digest,revocationRevision:value.revocationRevision})]);
}
