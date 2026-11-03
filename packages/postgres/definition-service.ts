import {z} from 'zod';
import type {Client} from 'pg';
import {DomainError,ownerKey,requireScope,type Job,type Principal,type Scope} from '../core/domain.js';
import type {ExecutionCatalog} from '../core/catalog.js';
import {taskSummary} from '../core/task-summary.js';
import type {TaskService} from '../core/tasks.js';
import type {TaskServicePort} from '../core/task-service-port.js';
import {definitionQuerySchema,definitionCommandSchema,foundationDefinitionQuerySchema,foundationDefinitionCommandSchema,prepareOntologyActionSchema,approveOntologyActionSchema} from '../ontology/definition-service.js';
import type {DefinitionServicePort} from '../ontology/definition-service-port.js';
import type {DefinitionDraft} from '../ontology/definition-store.js';
import type {OntologyReleaseRef} from '../ontology/definition-contracts.js';
import {ontologyReleaseRefSchema} from '../ontology/definition-contracts.js';
import {objectRefSchema} from '../ontology/model.js';
import type {StagedKernelBuilder} from '../ontology/seed-definition.js';
import {objectWriteScopeSchema} from '../ontology/actions.js';
import {stagedKernelComponents} from '../ontology/seed-definition.js';
import {currentKernelImplementation} from '../ontology/definition-store.js';
import {definitionEntries} from '../ontology/definition-validation.js';
import {assertReviewedModel} from '../security/model-review.js';
import {SecurityError,SecurityLineageLimitError} from '../security/errors.js';
import {storedSourceSchema} from '../security/source-policy.js';
import {reviewedFieldPolicy} from '../security/field-policy.js';
import type {PostgresDatabase} from './database.js';
import {PostgresDefinitionStore} from './definition-store.js';
import {discoverPostgresTaskActions} from './action-discovery.js';
import {PostgresTaskStorage} from './task-storage.js';
import {postgresTaskView} from './task-view.js';
import {postgresBusinessSchema,postgresBusinessToken,postgresConstrainReadDeadline} from './runtime-transaction.js';
import {withPostgresAgentScope,withPostgresTaskReadGrant,type PostgresTaskReadAdmission} from './task-read-access.js';
import {withPostgresTaskReadAuthorization,type PostgresTaskReadAuthorization} from './task-output.js';
import {postgresConsentDeadline} from './consent.js';

type Awaitable<F>=F extends(...args:infer A)=>infer R?(...args:A)=>R|Promise<Awaited<R>>:never;
type DefinitionTasks=Pick<TaskServicePort,'get'>&Partial<Pick<TaskServicePort,'authorize'>>&{
  prepareOntologyAction?:Awaitable<TaskService['prepareOntologyAction']>;
  preparePipelineValidation?:Awaitable<TaskService['preparePipelineValidation']>;
  /** Returns only the currently authorized preview contract; raw Intent output
   * is not accepted as a public metadata result. */
  callerActionPreview?:(principal:Principal,taskId:string)=>Promise<unknown>;
};
interface Context {client:Client;store:PostgresDefinitionStore;owner:string;admin:boolean;principal:Principal;token:object}
const summary=({document:_document,...value}:DefinitionDraft)=>value;
const invalid=(message:string):never=>{throw new DomainError('INVALID_INPUT',message);};
function envelope(result:unknown){if(Buffer.byteLength(JSON.stringify(result))>256000)throw new DomainError('CONFLICT','Metadata response exceeds the read limit; use a narrower page or exact definition');return {version:1 as const,result};}
const changesSchema=z.strictObject({id:z.string().min(1),componentId:z.string().min(1),object:objectRefSchema,reason:z.enum(['changed','conflicted','stale','restored']),fields:z.array(z.string().min(1).max(80)).max(256),semanticRevision:z.number().int().positive(),at:z.iso.datetime({offset:true})});
const publishCommands=new Set(['publish_draft','activate_release','verify_pipeline_task','report_pipeline_source_change','revoke_pipeline_verification','prepare_pipeline_validation']);

/** Production PostgreSQL definition metadata. Authentication is current at
 * both sides of every operation; publishing metadata never executes a model or
 * provider, activates a release implicitly, or mutates another task's pin. */
export class PostgresDefinitionService implements DefinitionServicePort {
  readonly secured=true;
  constructor(private readonly options:{database:Pick<PostgresDatabase,'run'>;tasks:DefinitionTasks;catalog:ExecutionCatalog;
    publisher:{withManagement<T>(client:Client,action:()=>Promise<T>):Promise<T>};policyDigest:string;builder?:StagedKernelBuilder}){
    if(!/^[a-f0-9]{64}$/.test(options.policyDigest)||typeof options.publisher.withManagement!=='function')throw new Error('A reviewed policy and the sole running authorization publisher are required');
  }
  private run<T>(principal:Principal,scope:Scope,action:(ctx:Context)=>Promise<T>){
    const captured=structuredClone(principal);
    return this.options.database.run(client=>this.options.publisher.withManagement(client,()=>
      withPostgresAgentScope(client,captured,this.options.policyDigest,scope,async()=>action({client,store:new PostgresDefinitionStore(client,{builder:this.options.builder}),owner:ownerKey(captured),admin:captured.scopes.includes('ontology:admin'),principal:captured,token:postgresBusinessToken(client)}))));
  }
  private async context(ctx:Context,id:string,management=false){return management?ctx.store.assertManagement(ctx.owner,id,ctx.admin):ctx.store.assertAccess(ctx.owner,id,ctx.admin);}
  private permissions(ctx:Context,namespace:{owner:string|null}){const manager=namespace.owner===ctx.owner||ctx.admin;return {read:ctx.principal.scopes.includes('ontology:read'),createOntology:ctx.principal.scopes.includes('ontology:write'),edit:manager&&ctx.principal.scopes.includes('ontology:write'),publish:manager&&ctx.principal.scopes.includes('ontology:publish'),execute:ctx.principal.scopes.includes('ontology:object_write')&&ctx.principal.scopes.includes('tasks:write')};}
  private async draft(ctx:Context,id:string,draftId:string,management=false){await this.context(ctx,id,management);const draft=await ctx.store.draft(draftId);if(draft.ontologyId!==id)throw new DomainError('NOT_FOUND','Draft is not available in this ontology');return draft;}
  private async document(ctx:Context,args:{ontologyId:string;draftId?:string;release?:OntologyReleaseRef}){
    await this.context(ctx,args.ontologyId);if(args.draftId&&args.release)return invalid('Choose either a draft or an immutable release');
    if(args.draftId)return {document:(await this.draft(ctx,args.ontologyId,args.draftId)).document,publication:'draft' as const,release:undefined};
    if(args.release&&args.release.ontologyId!==args.ontologyId)return invalid('Release belongs to another ontology');
    const selected=args.release?await ctx.store.resolve(args.release):await ctx.store.active(args.ontologyId);return {document:selected.document,publication:'published' as const,release:selected.ref};
  }
  private async withTask<T>(ctx:Context,id:string,taskId:string,operation:'task.query'|'task.result.read',action:(job:Job,visible:Awaited<ReturnType<typeof postgresTaskView>>,auth:PostgresTaskReadAuthorization,admission:PostgresTaskReadAdmission)=>Promise<T>){
    const visible=await postgresTaskView(ctx.client,ctx.principal,taskId,this.options.policyDigest,this.options.builder);
    return withPostgresTaskReadGrant(ctx.client,ctx.principal,taskId,this.options.policyDigest,admission=>{
      if(!admission.grant.operations.includes(operation))throw new SecurityError('AUTHORIZATION_REQUIRED');
      return withPostgresTaskReadAuthorization(ctx.client,ctx.principal,taskId,this.options.policyDigest,async auth=>{
        const job=await new PostgresTaskStorage(ctx.client,this.options.builder).get(ctx.owner,taskId);
        if(job.delegation?.ontologyRelease?.ontologyId!==id)throw new DomainError('NOT_FOUND','Task is not available in this ontology');
        const result=await action(job,visible,auth,admission);if(postgresBusinessToken(ctx.client)!==ctx.token)throw new SecurityError('AUTHORIZATION_REQUIRED');return result;
      },this.options.builder);
    });
  }
  private async querySources(ctx:Context,admission:PostgresTaskReadAdmission){
    const q=`"${postgresBusinessSchema(ctx.client)}"`,rows=await ctx.client.query(`SELECT binding_id,program_id,CASE WHEN octet_length(body)<=65536 THEN body END AS body FROM ${q}.security_sources WHERE owner=$1 AND installation_id=$2 AND state='active' LIMIT 257`,[ctx.owner,admission.actor.installationId]);
    if(rows.rows.length>256||rows.rows.some(row=>typeof row.body!=='string'))throw new SecurityError('SOURCE_NOT_AUTHORIZED');
    return rows.rows.map(row=>{const value=storedSourceSchema.parse(JSON.parse(String(row.body)));if(value.bindingId!==row.binding_id||value.programId!==row.program_id||value.installationId!==admission.actor.installationId)throw new SecurityError('SOURCE_NOT_AUTHORIZED');return value;}).filter(value=>value.parentGrant.id===admission.parent.id&&value.parentGrant.revision===admission.parent.revision&&postgresConsentDeadline(value.expiresAt,this.options.policyDigest)>Date.now());
  }
  async query(principal:Principal,input:unknown){
    const actor=structuredClone(principal),supplied=structuredClone(input);
    return this.run(actor,'ontology:read',async ctx=>{
      const query=definitionQuerySchema.parse(supplied);if(!foundationDefinitionQuerySchema.safeParse(query).success)throw new DomainError('FORBIDDEN','This metadata query requires a separately reviewed Foundation interface');
      if(query.operation==='list_ontologies')return envelope((await ctx.store.namespaces(ctx.owner,ctx.admin)).map(value=>({...value,permissions:this.permissions(ctx,value)})));
      await this.context(ctx,query.ontologyId,['get_ontology','get_pipeline_intake'].includes(query.operation));
      if(query.operation==='get_ontology'){const value=await ctx.store.namespace(query.ontologyId);return envelope({...value,permissions:this.permissions(ctx,value)});}
      if(query.operation==='get_pipeline_intake'){
        const selected=await this.document(ctx,query),ref=selected.document.pipeline?.find(value=>value.serviceId===query.serviceId);if(!ref)throw new DomainError('NOT_FOUND','Service intake is not attached to this ontology version');
        return envelope({...ref,publication:selected.publication,release:selected.release,intake:await ctx.store.pipeline.intake(query.ontologyId,ref)});
      }
      if(query.operation==='get_action_task')return this.withTask(ctx,query.ontologyId,query.taskId,'task.result.read',async(_job,visible)=>envelope({task:taskSummary(visible)}));
      if(query.operation==='discover_task_actions')return envelope(await discoverPostgresTaskActions(ctx.client,ctx.principal,query.taskId,query.ontologyId,query.query,{catalog:this.options.catalog,policyDigest:this.options.policyDigest,builder:this.options.builder}));
      if(query.operation==='get_pipeline_task_uses')return this.withTask(ctx,query.ontologyId,query.taskId,'task.query',async(job,_visible,_auth,admission)=>{
        const uses=await ctx.store.pipeline.uses(ctx.owner,job.id),sources=await this.querySources(ctx,admission),items=[];
        for(const use of uses){
          const value=z.object({release:ontologyReleaseRefSchema,serviceId:z.string().min(1),intakeDigest:z.string().regex(/^[a-f0-9]{64}$/)}).parse(use),intake=await ctx.store.pipeline.intake(value.release.ontologyId,value);
          if(value.release.ontologyId!==query.ontologyId)throw new SecurityError('POLICY_CHANGED');
          const source=sources.find(source=>source.programId===intake.programRef.id&&(source.programDigest===intake.configurationDigest||source.readbackVersions?.some(version=>version.programDigest===intake.configurationDigest))
            &&admission.grant.outputs.some(output=>output.programId===source.programId&&output.programDigest===intake.configurationDigest&&(output.sourceBindingId===source.bindingId||source.readbackVersions?.some(version=>version.programDigest===intake.configurationDigest&&version.sourceBindingId===output.sourceBindingId))));
          if(source){postgresConstrainReadDeadline(ctx.client,postgresConsentDeadline(source.expiresAt,this.options.policyDigest));items.push(use);}
        }return envelope({items});
      });
      if(query.operation==='get_pipeline_fact')return this.withTask(ctx,query.ontologyId,query.taskId,'task.query',async(_job,_visible,auth)=>{
        await auth.readObject(query.object);const q=`"${postgresBusinessSchema(ctx.client)}"`,rows=await ctx.client.query(`SELECT CASE WHEN octet_length(body)<=1048576 THEN body END AS body FROM ${q}.ontology_pipeline_facts WHERE owner=$1 AND ontology_id=$2 AND object_type=$3 AND object_id=$4 LIMIT 2`,[ctx.owner,query.ontologyId,query.object.type,query.object.id]);
        if(!rows.rowCount)throw new DomainError('NOT_FOUND','No pipeline observation exists for this object');if(rows.rowCount!==1||typeof rows.rows[0]?.body!=='string')throw new DomainError('CONFLICT','Pipeline provenance exceeds its read bound');
        const state=z.object({object:objectRefSchema,revision:z.number().int().positive(),semanticRevision:z.number().int().positive(),conflicted:z.boolean(),intakeDigest:z.string(),mappingId:z.string(),release:ontologyReleaseRefSchema,observedAt:z.iso.datetime({offset:true}),expiresAt:z.iso.datetime({offset:true}),evidenceRefs:z.array(z.string()),sourceId:z.string(),sourceRevision:z.string(),sourceDigest:z.string(),evidenceLevel:z.string(),providerVersion:z.number().optional(),relationshipDigest:z.string().optional(),relationshipTypes:z.array(z.string()).optional()}).parse(JSON.parse(rows.rows[0].body));
        if(state.object.type!==query.object.type||state.object.id!==query.object.id||state.release.ontologyId!==query.ontologyId)throw new SecurityError('POLICY_CHANGED');return envelope({...state,health:state.conflicted?'conflicted':Date.parse(state.expiresAt)<=Date.now()?'stale':'fresh'});
      });
      if(query.operation==='get_pipeline_task_changes')return this.withTask(ctx,query.ontologyId,query.taskId,'task.query',async(job,_visible,auth)=>{
        const q=`"${postgresBusinessSchema(ctx.client)}"`,invalid=await ctx.client.query(`SELECT 1 FROM ${q}.ontology_pipeline_fact_changes WHERE owner=$1 AND job_id=$2 AND request_revision=$3 AND ${q}.eigos_try_jsonb(body) IS NULL LIMIT 1`,[ctx.owner,job.id,job.delegation!.request.revision]);if(invalid.rowCount)throw new DomainError('CONFLICT','Task fact change history is incomplete');
        const rows=await ctx.client.query(`SELECT id,CASE WHEN octet_length(body)<=1048576 AND sum(octet_length(body)) OVER()<=8388608 THEN body END AS body FROM ${q}.ontology_pipeline_fact_changes WHERE __eigos_rowid IN(
          SELECT max(__eigos_rowid) FROM ${q}.ontology_pipeline_fact_changes WHERE owner=$1 AND job_id=$2 AND request_revision=$3
          GROUP BY ${q}.eigos_try_jsonb(body)->>'componentId',${q}.eigos_try_jsonb(body)#>>'{object,type}',${q}.eigos_try_jsonb(body)#>>'{object,id}') ORDER BY __eigos_rowid DESC LIMIT 101`,[ctx.owner,job.id,job.delegation!.request.revision]);
        if(rows.rows.length>100||rows.rows.some(row=>typeof row.body!=='string'))throw new DomainError('CONFLICT','Task fact changes exceed the bounded context limit');
        const model=(await ctx.store.resolve(job.delegation!.ontologyRelease!)).model,items=[];
        for(const row of rows.rows){const change=changesSchema.parse(JSON.parse(String(row.body)));if(change.id!==row.id)throw new SecurityError('POLICY_CHANGED');
          try{const view=await auth.readObject(change.object),binding=await auth.bindingMetadata(change.object);if(!binding)continue;
            const candidates=change.fields.filter(field=>binding.fields.includes(field)&&model.properties(change.object.type)[field]&&!model.properties(change.object.type)[field]!.restricted&&!model.properties(change.object.type)[field]!.derived&&reviewedFieldPolicy(model,change.object.type,field)!=='internal_only');
            const scoped=query.ontologyId!=='eigos.business',presence=await ctx.client.query(`SELECT field,${q}.eigos_try_jsonb(o.body)->'properties' ? field AS present FROM ${q}.ontology_${scoped?'scoped_':''}objects o CROSS JOIN unnest($5::text[]) AS f(field)
              WHERE o.owner=$1 AND o.type=$2 AND o.id=$3 AND o.revision=$4 ${scoped?'AND o.ontology_id=$6':''}`,[ctx.owner,change.object.type,change.object.id,view.object.revision,candidates,...(scoped?[query.ontologyId]:[])]);
            if(presence.rows.length!==candidates.length)throw new SecurityError('POLICY_CHANGED');const absent=new Set(presence.rows.filter(value=>value.present===false).map(value=>String(value.field)));
            const fields=change.fields.filter(field=>Object.hasOwn(view.object.properties,field)||absent.has(field));if(fields.length)items.push({...change,fields});
          }catch(error){
            if(error instanceof SecurityLineageLimitError)throw error;
            if(error instanceof SecurityError&&['AUTHORIZATION_REQUIRED','SOURCE_NOT_AUTHORIZED','OUTPUT_NOT_ALLOWED'].includes(error.reason))continue;
            if(error instanceof DomainError&&error.code==='NOT_FOUND')continue;
            throw error;
          }
        }return envelope({items});
      });
      throw new DomainError('FORBIDDEN','This metadata query requires a separately reviewed Foundation interface');
    });
  }
  async command(principal:Principal,input:unknown){
    const actor=structuredClone(principal),supplied=structuredClone(input),operation=supplied&&typeof supplied==='object'&&!Array.isArray(supplied)?Reflect.get(supplied,'operation'):undefined,scope=typeof operation==='string'&&publishCommands.has(operation)?'ontology:publish' as const:'ontology:write' as const;
    if(operation==='prepare_pipeline_validation'){
      const request=await this.run(actor,scope,async ctx=>{if(Buffer.byteLength(JSON.stringify(supplied))>48000)return invalid('One metadata command is limited to 48 KB; edit one bounded definition at a time');const command=definitionCommandSchema.parse(supplied);if(command.operation!=='prepare_pipeline_validation')return invalid('Invalid pipeline validation operation');await this.context(ctx,command.ontologyId,true);if(command.release.ontologyId!==command.ontologyId)return invalid('Release belongs to another ontology');return command;});
      if(!this.options.tasks.preparePipelineValidation)throw new SecurityError('AUTHORITY_UNAVAILABLE','The PostgreSQL Pipeline validation task adapter is not installed');
      const {operation:_operation,...args}=request;return envelope({task:taskSummary(await this.options.tasks.preparePipelineValidation(actor,args)),authorization:'per_action_required',validationOnly:true});
    }
    return this.run(actor,scope,async ctx=>{
      if(Buffer.byteLength(JSON.stringify(supplied))>48000)return invalid('One metadata command is limited to 48 KB; edit one bounded definition at a time');
      const command=definitionCommandSchema.parse(supplied);if(!foundationDefinitionCommandSchema.safeParse(command).success)throw new DomainError('FORBIDDEN','This metadata edit requires a separately reviewed Foundation interface');
      requireScope(ctx.principal,publishCommands.has(command.operation)?'ontology:publish':'ontology:write');
      if(command.operation==='create_ontology')return envelope(await ctx.store.createNamespace(ctx.owner,command));
      await this.context(ctx,command.ontologyId,true);
      if(command.operation==='create_draft')return envelope(summary(await ctx.store.createDraft(ctx.owner,command.ontologyId,command.title,ctx.admin)));
      if(command.operation==='activate_release'){
        if(command.release.ontologyId!==command.ontologyId)return invalid('Release belongs to another ontology');
        assertReviewedModel(this.options.builder?stagedKernelComponents(this.options.builder).model:currentKernelImplementation(),(await ctx.store.resolve(command.release)).model);return envelope(await ctx.store.activate(ctx.owner,command.release,command.expectedGeneration,ctx.admin));
      }
      if(command.operation==='report_pipeline_source_change'||command.operation==='revoke_pipeline_verification'){
        if(!(await ctx.store.active(command.ontologyId)).document.pipeline?.some(value=>value.serviceId===command.serviceId))throw new DomainError('NOT_FOUND','Published service intake is unavailable');
        return envelope(await ctx.store.pipeline.event(command.ontologyId,ctx.owner,command.serviceId,command.operation==='report_pipeline_source_change'?{kind:'source_changed',sourceDigest:command.sourceDigest}:{kind:'verification_revoked',verificationId:command.verificationId}));
      }
      if(command.operation==='prepare_pipeline_validation')return invalid('Pipeline preparation must use the separate task transaction');
      const draft=await this.draft(ctx,command.ontologyId,command.draftId,true);
      if(command.operation==='put_pipeline_intake')return envelope(summary(await ctx.store.putPipeline(ctx.owner,draft.id,command.expectedRevision,command.intake,ctx.admin)));
      if(command.operation==='validate_pipeline_intake')return envelope(await ctx.store.validatePipeline(ctx.owner,draft.id,command.expectedRevision,command.serviceId,command.expiresAt,ctx.admin));
      if(command.operation==='verify_pipeline_task'){
        const value=await ctx.store.pipelineDraft(ctx.owner,draft.id,command.expectedRevision,command.serviceId,ctx.admin);
        const accepted=await this.withTask(ctx,command.ontologyId,command.taskId,'task.result.read',async(job,visible)=>{if(visible.accepted!==true||visible.outputStatus!=='available')throw new DomainError('FORBIDDEN','Verification requires the currently authorized accepted task result');return job;});
        const intents=await new PostgresTaskStorage(ctx.client,this.options.builder).intents(ctx.owner,accepted.id),byId=new Map(intents.map(value=>[value.id,value]));
        return envelope(await ctx.store.pipeline.verifyTask(command.ontologyId,ctx.owner,value.ref,value.model,accepted,id=>{const intent=byId.get(id);if(!intent)throw new DomainError('NOT_FOUND','Action intent not found');return intent;},command.expiresAt));
      }
      if(command.operation==='put_definition'||command.operation==='retire_definition')throw new DomainError('FORBIDDEN','This metadata edit requires a separately reviewed Foundation interface');
      if(command.operation==='publish_draft'){
        const published=await ctx.store.publish(ctx.owner,draft.id,command.expectedRevision,ctx.admin);assertReviewedModel(this.options.builder?stagedKernelComponents(this.options.builder).model:currentKernelImplementation(),(await ctx.store.resolve(published.release)).model);return envelope(published);
      }
      return envelope(await ctx.store.discard(ctx.owner,draft.id,command.expectedRevision,ctx.admin));
    });
  }
  async prepare(principal:Principal,input:unknown){
    const actor=structuredClone(principal),supplied=structuredClone(input),args=await this.run(actor,'ontology:read',async ctx=>{const args=prepareOntologyActionSchema.parse(supplied);await this.context(ctx,args.ontologyId);return args;});
    if(!this.options.tasks.prepareOntologyAction||!this.options.tasks.callerActionPreview)throw new SecurityError('AUTHORITY_UNAVAILABLE','The PostgreSQL caller-action preparation and authorized preview adapters are not installed');
    const task=await this.options.tasks.prepareOntologyAction(actor,args),preview=z.object({status:z.enum(['prepared','committed','stale']),planDigest:z.string().regex(/^[a-f0-9]{64}$/),digest:z.string().regex(/^[a-f0-9]{64}$/),scope:objectWriteScopeSchema,objects:z.array(z.unknown()).optional(),links:z.array(z.unknown()).optional(),result:z.unknown().optional()}).parse(await this.options.tasks.callerActionPreview(actor,task.id));
    if(preview.scope.ontologyRelease.ontologyId!==args.ontologyId||preview.digest!==preview.scope.previewDigest)throw new SecurityError('POLICY_CHANGED');return envelope({task:taskSummary(task),preview});
  }
  async approve(principal:Principal,input:unknown){
    const actor=structuredClone(principal),supplied=structuredClone(input),args=await this.run(actor,'ontology:object_write',async ctx=>{const args=approveOntologyActionSchema.parse(supplied);await this.context(ctx,args.objectWrite.ontologyRelease.ontologyId);return args;});
    if(!this.options.tasks.authorize)throw new SecurityError('AUTHORITY_UNAVAILABLE','The PostgreSQL caller-action approval adapter is not installed');
    const {taskId,...permit}=args,authorized=await this.options.tasks.authorize(actor,taskId,{...permit,action:'approve_object_write',environment:'managed'});return envelope({task:taskSummary(authorized)});
  }
}
