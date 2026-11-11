import {randomUUID} from 'node:crypto';
import type {Client} from 'pg';
import {z} from 'zod';
import {DomainError,type Job} from '../core/domain.js';
import {digest} from '../core/delegation.js';
import {definitionKindSchema,ontologyIdSchema,ontologyReleaseRefSchema,parseOntologyDocument,resourceIdSchema,
  type DefinitionKind,type OntologyDocument,type OntologyReleaseRef} from '../ontology/definition-contracts.js';
import type {DefinitionDraft,DefinitionResource,DefinitionValidation,OntologyNamespace} from '../ontology/definition-store.js';
import {compileOntologyDocument,normalizeOntologyDocument,type TrustedDefinitionRegistry} from '../ontology/model-compiler.js';
import {createSeedDefinition,createCurrentKernelDefinition,stagedKernelComponents,StagedKernelBuilder,BUSINESS_DESCRIPTIONS_KERNEL_MODEL_REF,SEMANTIC_RETRIEVAL_KERNEL_MODEL_REF,
  PA_CLASSIFICATION_KERNEL_MODEL_REF,DOMAIN_VOCABULARY_KERNEL_MODEL_REF,CONTRACT_CLOSURE_KERNEL_MODEL_REF,EFFECT_COVERAGE_KERNEL_MODEL_REF,EXECUTABLE_CONTRACT_KERNEL_MODEL_REF} from '../ontology/seed-definition.js';
import {FUNCTION_CONTRACT_CLOSEOUT_DOCUMENT_DIGEST,FUNCTION_CONTRACT_CLOSEOUT_MODEL_REF} from '../ontology/function-contract-closeout-compatibility.js';
import {reviewedExecutableModelPair} from '../ontology/executable-contract-compatibility.js';
import {assertReviewedModel} from '../security/model-review.js';
import {SecurityError} from '../security/errors.js';
import type {ActionIntent} from '../ontology/actions.js';
import type {OntologyModel} from '../ontology/model.js';
import {definitionChanges,definitionNameCategory,invalidDefinitionValidation,validateDefinitionSnapshot} from '../ontology/definition-validation.js';
import {parsePipelineIntake,pipelineMappingDigest,verificationCoversAction,type PipelineIntake,type PipelineVerification,type PipelineStatus,type PipelineValidationScope} from '../ontology/pipeline/contracts.js';
import {pipelineContract,pipelineContractIssues,assertPipelineVerificationExpiry,pipelineTaskVerification} from '../ontology/pipeline/validation.js';
import {actionEffects} from '../ontology/composition-contract.js';
import {postgresBusinessSchema,postgresBusinessToken} from './runtime-transaction.js';
import {postgresOntologyRelease,postgresOntologyDefinitionCompatible} from './ontology-release.js';

const kinds={object:'objects',interface:'interfaces',link:'links',action:'actions'} as const;
const entries=(document:OntologyDocument)=>(Object.keys(kinds) as DefinitionKind[]).flatMap(kind=>document[kinds[kind]].map(definition=>({kind,definition})));
const category=(kind:DefinitionKind)=>kind==='object'||kind==='interface'?'type':kind;
const conflict=(message:string):never=>{throw new DomainError('CONFLICT',message);};
const invalid=(message:string):never=>{throw new DomainError('INVALID_INPUT',message);};
const summary=({document:_document,...value}:DefinitionDraft)=>value;
let templates:{registry:TrustedDefinitionRegistry;document:OntologyDocument}|undefined;
function trusted(){if(!templates){const seed=createSeedDefinition(),current=createCurrentKernelDefinition(seed.registry);templates={registry:seed.registry,document:current.document};}return templates;}

export const reviewedKernelReleaseRequestSchema=z.strictObject({
  expectedActive:z.strictObject({ref:ontologyReleaseRefSchema,generation:z.number().int().positive().max(Number.MAX_SAFE_INTEGER-1)}),
  reviewDigest:z.string().regex(/^[a-f0-9]{64}$/),
});
export type ReviewedKernelReleaseRequest=z.infer<typeof reviewedKernelReleaseRequestSchema>;
const reviewedPredecessors=[BUSINESS_DESCRIPTIONS_KERNEL_MODEL_REF,SEMANTIC_RETRIEVAL_KERNEL_MODEL_REF,PA_CLASSIFICATION_KERNEL_MODEL_REF,DOMAIN_VOCABULARY_KERNEL_MODEL_REF,
  CONTRACT_CLOSURE_KERNEL_MODEL_REF,EFFECT_COVERAGE_KERNEL_MODEL_REF,EXECUTABLE_CONTRACT_KERNEL_MODEL_REF];

/** Internal metadata persistence on the caller's original serialized business
 * transaction. This class grants no namespace, OAuth scope or actor authority,
 * never bootstraps a runtime and never opens another database. */
export class PostgresDefinitionStore {
  private readonly schema:string;
  private readonly token:object;
  private readonly registry:TrustedDefinitionRegistry;
  readonly pipeline:PostgresDefinitionPipeline;
  constructor(private readonly client:Client,private readonly options:{builder?:StagedKernelBuilder;now?:()=>number}={}){
    this.schema=postgresBusinessSchema(client);this.token=postgresBusinessToken(client);
    this.registry=options.builder?stagedKernelComponents(options.builder).registry:trusted().registry;
    this.pipeline=new PostgresDefinitionPipeline(this.q,(text,values)=>this.sql(text,values),this.now);
  }
  readonly now=()=>this.options.now?.()??Date.now();
  private get q(){return `"${this.schema}"`;}
  private async sql(text:string,values:unknown[]=[]){
    if(postgresBusinessToken(this.client)!==this.token)throw new SecurityError('AUTHORIZATION_REQUIRED');
    const result=await this.client.query(text,values);
    if(postgresBusinessToken(this.client)!==this.token)throw new SecurityError('AUTHORIZATION_REQUIRED');return result;
  }
  compile(input:OntologyDocument){return compileOntologyDocument(input,this.registry);}
  resolve(ref:OntologyReleaseRef){return postgresOntologyRelease(this.client,ref,this.options.builder);}
  async namespace(input='eigos.business'):Promise<OntologyNamespace>{
    const id=ontologyIdSchema.parse(input),result=await this.sql(`SELECT n.id,n.owner,n.name,n.active_release_id,n.generation,n.created_at,r.digest
      FROM ${this.q}.ontology_namespaces n JOIN ${this.q}.ontology_definition_releases r ON r.id=n.active_release_id AND r.ontology_id=n.id WHERE n.id=$1 LIMIT 2`,[id]);
    if(!result.rowCount)throw new DomainError('NOT_FOUND','Ontology is not available');
    const row=result.rows[0],generation=Number(row?.generation);
    if(result.rowCount!==1||row.id!==id||!Number.isSafeInteger(generation)||generation<1||typeof row.name!=='string'||typeof row.created_at!=='string')return conflict('Ontology namespace metadata is invalid');
    return {id,owner:row.owner===null?null:String(row.owner),name:row.name,active:ontologyReleaseRefSchema.parse({ontologyId:id,releaseId:row.active_release_id,digest:row.digest}),generation,createdAt:row.created_at};
  }
  async assertAccess(owner:string,id:string,admin=false){const namespace=await this.namespace(id);if(namespace.owner!==null&&namespace.owner!==owner&&!admin)throw new DomainError('FORBIDDEN','Ontology belongs to another owner');return namespace;}
  async assertManagement(owner:string,id:string,admin=false){const namespace=await this.namespace(id);if(namespace.owner!==owner&&!admin)throw new DomainError('FORBIDDEN','Ontology management requires its owner or an administrator');return namespace;}
  async namespaces(owner:string,admin=false){
    const rows=await this.sql(`SELECT id FROM ${this.q}.ontology_namespaces ${admin?'':'WHERE owner IS NULL OR owner=$1'} ORDER BY id COLLATE "C" LIMIT 1001`,admin?[]:[owner]);
    if(rows.rows.length>1000)return conflict('Ontology namespace inventory exceeds its read bound');
    const result=[];for(const row of rows.rows)result.push(await this.namespace(String(row.id)));return result;
  }
  async active(id='eigos.business'){return this.resolve((await this.namespace(id)).active);}
  private reviewedKernel(){
    if(!this.options.builder)return conflict('The actual completed v35 software kernel is required');
    const document=StagedKernelBuilder.prototype.result.call(this.options.builder).document,model=this.compile(document);
    if(document.id!=='eigos.business'||document.version!=='35'||digest(document)!==FUNCTION_CONTRACT_CLOSEOUT_DOCUMENT_DIGEST
      ||digest(model.ref)!==digest(FUNCTION_CONTRACT_CLOSEOUT_MODEL_REF))return conflict('The fixed reviewed v35 document or model changed');
    assertReviewedModel(stagedKernelComponents(this.options.builder).model,model);return {document,model};
  }
  private async reviewedKernelBase(owner:string,input:ReviewedKernelReleaseRequest,admin:boolean){
    const request=reviewedKernelReleaseRequestSchema.parse(input),expected=request.expectedActive;
    if(!admin||expected.ref.ontologyId!=='eigos.business')throw new DomainError('FORBIDDEN','Reviewed kernel maintenance requires an authenticated system administrator');
    const namespace=await this.assertManagement(owner,expected.ref.ontologyId,admin),base=await this.resolve(expected.ref);
    // Only the historical display version may differ. Reuse the exact reviewed
    // document/implementation pins, rather than treating a model digest alone
    // as proof that metadata and immutable handler references are unchanged.
    const canonical=reviewedPredecessors.find(ref=>ref.digest===base.model.ref.digest);
    if(!canonical||base.document.version!==canonical.version&&!/^release-[1-9][0-9]*$/.test(base.document.version)
      ||!reviewedExecutableModelPair(this.reviewedKernel().model,this.compile({...base.document,version:canonical.version})))return conflict('Reviewed kernel maintenance requires an unchanged canonical predecessor');
    return {request,namespace,base};
  }
  private async reviewedKernelTarget(){
    const {document,model}=this.reviewedKernel(),rows=await this.sql(`SELECT id,digest,model_digest FROM ${this.q}.ontology_definition_releases
      WHERE ontology_id=$1 AND(digest=$2 OR model_digest=$3 OR ${this.q}.eigos_try_jsonb(body)->>'version'='35') LIMIT 2`,[document.id,FUNCTION_CONTRACT_CLOSEOUT_DOCUMENT_DIGEST,model.ref.digest]);
    if(!rows.rowCount)return {document,model};
    if(rows.rowCount!==1||rows.rows[0].digest!==FUNCTION_CONTRACT_CLOSEOUT_DOCUMENT_DIGEST||rows.rows[0].model_digest!==model.ref.digest)return conflict('An existing v35 release differs from the fixed reviewed document');
    const release=await this.resolve({ontologyId:document.id,releaseId:String(rows.rows[0].id),digest:FUNCTION_CONTRACT_CLOSEOUT_DOCUMENT_DIGEST});
    return {document,model,release};
  }
  private kernelPublication(request:ReviewedKernelReleaseRequest,ref:OntologyReleaseRef){return {release:ref,expectedActive:request.expectedActive,reviewDigest:request.reviewDigest,model:FUNCTION_CONTRACT_CLOSEOUT_MODEL_REF};}
  private async assertKernelPublication(request:ReviewedKernelReleaseRequest,ref:OntologyReleaseRef){
    const lineage=await this.sql(`SELECT CASE WHEN octet_length(base_ref)<=1024 THEN base_ref END AS base_ref FROM ${this.q}.ontology_definition_lineage WHERE ontology_id=$1 AND release_id=$2 LIMIT 2`,[ref.ontologyId,ref.releaseId]);
    if(lineage.rowCount!==1||typeof lineage.rows[0]?.base_ref!=='string'||digest(ontologyReleaseRefSchema.parse(JSON.parse(lineage.rows[0].base_ref)))!==digest(request.expectedActive.ref))return conflict('Reviewed kernel publication lineage changed');
    const events=await this.sql(`SELECT CASE WHEN octet_length(body)<=4096 THEN body END AS body FROM ${this.q}.ontology_definition_events
      WHERE ontology_id=$1 AND kind='reviewed_kernel_published' AND ${this.q}.eigos_try_jsonb(body)#>>'{release,releaseId}'=$2 LIMIT 2`,[ref.ontologyId,ref.releaseId]);
    if(events.rowCount!==1||typeof events.rows[0]?.body!=='string'||digest(JSON.parse(events.rows[0].body))!==digest(this.kernelPublication(request,ref)))return conflict('Reviewed kernel publication preconditions changed');
  }
  /** Host-only metadata publication. The maintenance wrapper proves the actual
   * database identity; no public command accepts this operation or a document. */
  async publishReviewedKernel(owner:string,input:ReviewedKernelReleaseRequest,admin=false){
    const {request,namespace}=await this.reviewedKernelBase(owner,input,admin),target=await this.reviewedKernelTarget(),expected=request.expectedActive;
    if(namespace.generation!==expected.generation||digest(namespace.active)!==digest(expected.ref))return conflict('Reviewed active ontology changed before publication');
    if(target.release){await this.assertKernelPublication(request,target.release.ref);return {release:target.release.ref,namespace,created:false};}
    const release=await this.insertRelease(target.document,owner,expected.ref);
    await this.event(namespace.id,owner,'reviewed_kernel_published',this.kernelPublication(request,release.ref));
    return {release:release.ref,namespace,created:true};
  }
  async inspectReviewedKernel(owner:string,input:ReviewedKernelReleaseRequest,inputRef:OntologyReleaseRef,state:'published'|'active',admin=false){
    const {request,namespace}=await this.reviewedKernelBase(owner,input,admin),ref=ontologyReleaseRefSchema.parse(inputRef),target=await this.reviewedKernelTarget(),expected=request.expectedActive;
    if(!target.release||digest(target.release.ref)!==digest(ref))return conflict('The exact reviewed kernel publication is unavailable');
    await this.assertKernelPublication(request,ref);
    if(state==='published'){
      if(namespace.generation!==expected.generation||digest(namespace.active)!==digest(expected.ref))return conflict('Reviewed active ontology changed after publication');
    }else{
      if(state!=='active'||namespace.generation!==expected.generation+1||digest(namespace.active)!==digest(ref))return conflict('Reviewed kernel activation generation changed');
      const events=await this.sql(`SELECT CASE WHEN octet_length(body)<=4096 THEN body END AS body FROM ${this.q}.ontology_definition_events WHERE ontology_id=$1 AND kind='activated'
        AND ${this.q}.eigos_try_jsonb(body)#>>'{to,releaseId}'=$2 AND ${this.q}.eigos_try_jsonb(body)->>'generation'=$3 LIMIT 2`,[ref.ontologyId,ref.releaseId,String(namespace.generation)]);
      const promoted=await this.sql(`SELECT 1 FROM ${this.q}.ontology_definition_promotions WHERE ontology_id=$1 AND release_id=$2 LIMIT 2`,[ref.ontologyId,ref.releaseId]);
      if(promoted.rowCount!==1||events.rowCount!==1||typeof events.rows[0]?.body!=='string'||digest(JSON.parse(events.rows[0].body))!==digest({from:expected.ref,to:ref,generation:expected.generation+1}))return conflict('Reviewed kernel activation history changed');
    }
    return {release:ref,namespace,state};
  }
  /** Publication and activation are separate transactions. The original
   * activation path retains all Pipeline, in-flight task and fact checks. */
  async activateReviewedKernel(owner:string,input:ReviewedKernelReleaseRequest,ref:OntologyReleaseRef,admin=false){
    const request=reviewedKernelReleaseRequestSchema.parse(input),namespace=await this.namespace(request.expectedActive.ref.ontologyId);
    if(digest(namespace.active)===digest(ref))return this.inspectReviewedKernel(owner,request,ref,'active',admin);
    await this.inspectReviewedKernel(owner,request,ref,'published',admin);
    await this.activate(owner,ref,request.expectedActive.generation,admin);
    return this.inspectReviewedKernel(owner,request,ref,'active',admin);
  }
  /** Explicit software installation, never startup or request JSON. The host
   * must separately prove its real namespace-owner administrator identity. */
  async installSemanticRetrieval(owner:string,expected:OntologyReleaseRef,expectedGeneration:number,admin=false){
    const namespace=await this.assertManagement(owner,expected.ontologyId,admin);
    if(!admin||digest(namespace.active)!==digest(expected)||namespace.generation!==expectedGeneration)throw new DomainError('CONFLICT','The reviewed active release changed before semantic installation');
    const template=this.options.builder?StagedKernelBuilder.prototype.result.call(this.options.builder).document:trusted().document;
    if(template.version!=='29'||template.functions.filter(fn=>fn.id==='semanticCandidates').length!==1)throw new DomainError('CONFLICT','The actual semantic software kernel is unavailable');
    const current=await this.resolve(namespace.active);
    if(digest(current.document)===digest(template))throw new DomainError('CONFLICT','Semantic kernel is already installed; independently verify the existing release');
    const predecessor=structuredClone(template);predecessor.version='28';predecessor.functions=predecessor.functions.filter(fn=>fn.id!=='semanticCandidates');
    if(digest(predecessor)!==digest(current.document))throw new DomainError('CONFLICT','Semantic installation requires its exact reviewed descriptions-v28 predecessor');
    await this.sql('SAVEPOINT eigos_semantic_kernel_install');
    try{const release=await this.insertRelease(template,owner,current.ref),activated=await this.activate(owner,release.ref,expectedGeneration,true);await this.sql('RELEASE SAVEPOINT eigos_semantic_kernel_install');return activated;}
    catch(error){await this.sql('ROLLBACK TO SAVEPOINT eigos_semantic_kernel_install');await this.sql('RELEASE SAVEPOINT eigos_semantic_kernel_install');throw error;}
  }
  async createNamespace(owner:string,input:{id?:string;name:string}){
    const id=ontologyIdSchema.parse(input.id??`ontology-${randomUUID()}`);
    if(!owner||owner.length>2000||!input.name.trim()||input.name.length>200)return invalid('Invalid ontology owner or name');
    if((await this.sql(`SELECT 1 FROM ${this.q}.ontology_namespaces WHERE id=$1`,[id])).rowCount)return conflict('Ontology identity already exists');
    const at=new Date(this.now()).toISOString();
    await this.sql(`INSERT INTO ${this.q}.ontology_namespaces(id,owner,name,active_release_id,generation,created_at) VALUES($1,$2,$3,NULL,0,$4)`,[id,owner,input.name.trim(),at]);
    const document=structuredClone(trusted().document);document.id=id;document.version='1';
    const release=await this.insertRelease(document,owner);
    const changed=await this.sql(`UPDATE ${this.q}.ontology_namespaces SET active_release_id=$1,generation=1 WHERE id=$2 AND generation=0 AND active_release_id IS NULL`,[release.ref.releaseId,id]);
    if(changed.rowCount!==1)return conflict('Ontology namespace changed');
    await this.promotion(release.ref);await this.event(id,owner,'created',{release:release.ref});return this.namespace(id);
  }
  async event(id:string,actor:string,kind:string,body:unknown){await this.sql(`INSERT INTO ${this.q}.ontology_definition_events(id,ontology_id,actor,kind,body,at) VALUES($1,$2,$3,$4,$5,$6)`,[randomUUID(),id,actor,kind,JSON.stringify(body),new Date(this.now()).toISOString()]);}
  private async promotion(ref:OntologyReleaseRef){await this.sql(`INSERT INTO ${this.q}.ontology_definition_promotions(ontology_id,release_id,at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[ref.ontologyId,ref.releaseId,new Date(this.now()).toISOString()]);}
  private async insertRelease(input:OntologyDocument,actor:string,base?:OntologyReleaseRef){
    const document=normalizeOntologyDocument(input),model=this.compile(document),hash=digest(document);
    const existing=await this.sql(`SELECT id,digest FROM ${this.q}.ontology_definition_releases WHERE ontology_id=$1 AND digest=$2 LIMIT 2`,[document.id,hash]);
    if(existing.rowCount){if(existing.rowCount!==1)return conflict('Immutable release identity is ambiguous');return this.resolve({ontologyId:document.id,releaseId:String(existing.rows[0].id),digest:hash});}
    const definitions=entries(document).map(({kind,definition})=>({kind,category:category(kind),resource_id:definition.resourceId,api_name:definition.id,digest:digest(definition),body:JSON.stringify(definition)}));
    const locks=await this.sql(`WITH input AS(SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(kind text,category text,resource_id text,api_name text))
      SELECT i.resource_id AS requested_id,n.resource_id,n.kind,n.api_name,n.category FROM input i JOIN ${this.q}.ontology_definition_names n ON n.ontology_id=$1
        AND(n.resource_id=i.resource_id OR(n.category=i.category AND n.api_name=i.api_name))`,[document.id,JSON.stringify(definitions)]);
    if(locks.rows.some(row=>!definitions.some(value=>value.resource_id===row.requested_id&&value.resource_id===row.resource_id&&value.kind===row.kind&&value.api_name===row.api_name&&value.category===row.category)))return conflict('Published definition identities and API names cannot be reused or renamed');
    const occupied=new Set(locks.rows.map(row=>String(row.resource_id))),missing=definitions.filter(value=>!occupied.has(value.resource_id));
    if(missing.length){const written=await this.sql(`INSERT INTO ${this.q}.ontology_definition_names(ontology_id,category,api_name,resource_id,kind)
      SELECT $1,x.category,x.api_name,x.resource_id,x.kind FROM jsonb_to_recordset($2::jsonb) AS x(category text,api_name text,resource_id text,kind text) ON CONFLICT DO NOTHING`,[document.id,JSON.stringify(missing)]);if(written.rowCount!==missing.length)return conflict('Published definition identity changed');}
    const versions=await this.sql(`WITH input AS(SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(resource_id text,digest text))
      SELECT i.resource_id,coalesce(max(r.revision),0)::text AS maximum,bool_or(r.digest=i.digest) AS present
      FROM input i LEFT JOIN ${this.q}.ontology_definition_revisions r ON r.ontology_id=$1 AND r.resource_id=i.resource_id GROUP BY i.resource_id`,[document.id,JSON.stringify(definitions)]);
    if(versions.rows.length!==definitions.length)return conflict('Definition revision inventory is invalid');
    const at=new Date(this.now()).toISOString(),newVersions=[];
    for(const row of versions.rows){const value=definitions.find(value=>value.resource_id===row.resource_id);if(!value)return conflict('Definition revision inventory changed');
      const maximum=Number(row.maximum);if(!Number.isSafeInteger(maximum)||maximum<0||!Number.isSafeInteger(maximum+1))return conflict('Definition revision exceeds its supported range');
      if(row.present!==true)newVersions.push({...value,revision:maximum+1});}
    if(newVersions.length)await this.sql(`INSERT INTO ${this.q}.ontology_definition_revisions(ontology_id,resource_id,revision,kind,api_name,digest,body,created_at)
      SELECT $1,x.resource_id,x.revision,x.kind,x.api_name,x.digest,x.body,$3 FROM jsonb_to_recordset($2::jsonb) AS x(resource_id text,revision bigint,kind text,api_name text,digest text,body text)`,[document.id,JSON.stringify(newVersions),at]);
    const sequence=Number((await this.sql(`SELECT coalesce(max(sequence),0)+1 AS next FROM ${this.q}.ontology_definition_releases WHERE ontology_id=$1`,[document.id])).rows[0]?.next);
    if(!Number.isSafeInteger(sequence)||sequence<1)return conflict('Release sequence exceeds its supported range');
    const ref={ontologyId:document.id,releaseId:randomUUID(),digest:hash};
    await this.sql(`INSERT INTO ${this.q}.ontology_definition_releases(id,ontology_id,sequence,digest,model_digest,body,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,[ref.releaseId,document.id,sequence,hash,model.ref.digest,JSON.stringify(document),at]);
    await this.sql(`INSERT INTO ${this.q}.ontology_definition_lineage(release_id,ontology_id,base_ref) VALUES($1,$2,$3)`,[ref.releaseId,document.id,base?JSON.stringify(base):null]);
    const fingerprints=[...document.objects.map(value=>({kind:'object',api_name:value.id,fingerprint:model.fingerprint(value.id)})),...document.links.map(value=>({kind:'link',api_name:value.id,fingerprint:digest(model.link(value.id))}))];
    if(fingerprints.length)await this.sql(`INSERT INTO ${this.q}.ontology_definition_fingerprints(ontology_id,kind,api_name,fingerprint,release_id)
      SELECT $1,x.kind,x.api_name,x.fingerprint,$3 FROM jsonb_to_recordset($2::jsonb) AS x(kind text,api_name text,fingerprint text) ON CONFLICT DO NOTHING`,[document.id,JSON.stringify(fingerprints),ref.releaseId]);
    await this.event(document.id,actor,'release_created',{release:ref,model:model.ref});return this.resolve(ref);
  }
  async createDraft(owner:string,id:string,title:string,admin=false){
    const namespace=await this.assertManagement(owner,id,admin);if(!title.trim()||title.length>200)return invalid('Draft title is required');
    const base=await this.resolve(namespace.active),at=new Date(this.now()).toISOString();
    const draft:DefinitionDraft={id:randomUUID(),ontologyId:id,owner,base:{...base.ref},baseGeneration:namespace.generation,revision:1,status:'open',title:title.trim(),document:structuredClone(base.document),createdAt:at,updatedAt:at};
    await this.sql(`INSERT INTO ${this.q}.ontology_definition_drafts(id,ontology_id,owner,revision,status,body) VALUES($1,$2,$3,1,'open',$4)`,[draft.id,id,owner,JSON.stringify(draft)]);
    await this.event(id,owner,'draft_created',{draftId:draft.id,base:draft.base});return draft;
  }
  async draft(input:string):Promise<DefinitionDraft>{
    const id=resourceIdSchema.parse(input),rows=await this.sql(`SELECT ontology_id,owner,revision,status,CASE WHEN octet_length(body)<=8388608 THEN body END AS body FROM ${this.q}.ontology_definition_drafts WHERE id=$1 LIMIT 2`,[id]);
    if(!rows.rowCount)throw new DomainError('NOT_FOUND','Definition draft is not available');
    if(rows.rowCount!==1||typeof rows.rows[0]?.body!=='string')return conflict('Definition draft exceeds its read bound');
    const row=rows.rows[0],draft=JSON.parse(row.body) as DefinitionDraft;
    if(draft.id!==id||draft.ontologyId!==row.ontology_id||draft.owner!==row.owner||draft.revision!==Number(row.revision)||draft.status!==row.status||!Number.isSafeInteger(draft.revision)||draft.revision<1)return conflict('Definition draft record is inconsistent');
    z.object({owner:z.string().min(1).max(2000),title:z.string().min(1).max(200),status:z.enum(['open','published','discarded']),baseGeneration:z.number().int().nonnegative().safe(),createdAt:z.iso.datetime({offset:true}),updatedAt:z.iso.datetime({offset:true})}).parse(draft);
    draft.document=parseOntologyDocument(draft.document);const base=ontologyReleaseRefSchema.parse(draft.base);
    if(base.ontologyId!==draft.ontologyId||draft.document.id!==draft.ontologyId||draft.published&&ontologyReleaseRefSchema.parse(draft.published).ontologyId!==draft.ontologyId)return conflict('Draft release belongs to another ontology');return draft;
  }
  private page(page:{limit:number;offset:number}){if(!Number.isInteger(page.limit)||page.limit<1||page.limit>100||!Number.isInteger(page.offset)||page.offset<0||page.offset>10000)return invalid('Invalid definition history page');return page;}
  async draftPage(id:string,input:{limit:number;offset:number}){
    const page=this.page(input),count=Number((await this.sql(`SELECT count(*) AS n FROM ${this.q}.ontology_definition_drafts WHERE ontology_id=$1`,[id])).rows[0]?.n);
    if(!Number.isSafeInteger(count)||count<0)return conflict('Draft inventory exceeds its supported range');
    const rows=await this.sql(`SELECT id FROM ${this.q}.ontology_definition_drafts WHERE ontology_id=$1 ORDER BY __eigos_rowid DESC LIMIT $2 OFFSET $3`,[id,page.limit,page.offset]);
    const items=[];for(const row of rows.rows)items.push(summary(await this.draft(String(row.id))));return {items,total:count,page:{...page,hasMore:page.offset+items.length<count}};
  }
  private async saveDraft(draft:DefinitionDraft,expected:number){
    draft.revision=expected+1;draft.updatedAt=new Date(this.now()).toISOString();
    if(!Number.isSafeInteger(draft.revision))return conflict('Draft revision exceeds its supported range');
    const body=JSON.stringify(draft);if(Buffer.byteLength(body)>8388608)return invalid('Definition draft is too large');
    const row=await this.sql(`UPDATE ${this.q}.ontology_definition_drafts SET revision=$1,status=$2,body=$3 WHERE id=$4 AND ontology_id=$5 AND owner=$6 AND revision=$7`,[draft.revision,draft.status,body,draft.id,draft.ontologyId,draft.owner,expected]);
    if(row.rowCount!==1)return conflict('Definition draft revision changed');return draft;
  }
  private async editing(owner:string,id:string,revision:number,admin:boolean){const draft=await this.draft(id);await this.assertManagement(owner,draft.ontologyId,admin);if(draft.status!=='open'||draft.revision!==revision)return conflict('Draft is not open at the expected revision');return draft;}
  async putResource(owner:string,id:string,revision:number,inputKind:DefinitionKind,input:unknown,admin=false){
    const kind=definitionKindSchema.parse(inputKind),draft=await this.editing(owner,id,revision,admin);
    if(!input||typeof input!=='object'||Array.isArray(input))return invalid('Definition must be an object');
    const candidate=structuredClone(input) as Record<string,unknown>,old=entries(draft.document).find(value=>value.kind===kind&&(value.definition.resourceId===candidate.resourceId||value.definition.id===candidate.id));
    candidate.resourceId??=old?.definition.resourceId??`resource:${randomUUID()}`;
    if(old&&(candidate.resourceId!==old.definition.resourceId||candidate.id!==old.definition.id))return conflict('Definition identity cannot be renamed in place');
    if(!old&&/^(?:builtin:|generated:)/.test(String(candidate.resourceId)))return invalid('Reserved definition identity');
    const document=structuredClone(draft.document),list=document[kinds[kind]] as DefinitionResource[];
    if(old)list[list.findIndex(value=>value.resourceId===old.definition.resourceId)]=candidate as unknown as DefinitionResource;else list.push(candidate as unknown as DefinitionResource);
    draft.document=parseOntologyDocument(document);await this.event(draft.ontologyId,owner,'definition_edited',{draftId:id,kind,resourceId:candidate.resourceId});return this.saveDraft(draft,revision);
  }
  async retireResource(owner:string,id:string,revision:number,resourceId:string,admin=false){
    const draft=await this.editing(owner,id,revision,admin),resource=entries(draft.document).find(value=>value.definition.resourceId===resourceId);
    if(!resource)throw new DomainError('NOT_FOUND','Definition resource is not available');
    if(this.registry.isProtected(resourceId)||resourceId.startsWith('generated:'))throw new DomainError('FORBIDDEN','Trusted kernel definitions cannot be retired through a business draft');
    const list=draft.document[kinds[resource.kind]] as DefinitionResource[];list.splice(list.findIndex(value=>value.resourceId===resourceId),1);
    if(resource.kind==='object')draft.document.links=draft.document.links.filter(link=>!(link.resourceId.startsWith('generated:execution-link:')&&(link.from.type===resource.definition.id||link.to.type===resource.definition.id)));
    await this.event(draft.ontologyId,owner,'definition_retired_in_draft',{draftId:id,resourceId});return this.saveDraft(draft,revision);
  }
  async changes(draft:DefinitionDraft){return definitionChanges((await this.resolve(draft.base)).document,draft.document);}
  private async instances(id:string,type:string){
    const scoped=id!=='eigos.business',rows=await this.sql(`SELECT o.definition_digest,
      CASE WHEN octet_length(o.body)<=1048576 AND sum(octet_length(o.body)) OVER()<=33554432 THEN o.body END AS body
      FROM ${this.q}.ontology_${scoped?'scoped_':''}objects o WHERE ${scoped?'o.ontology_id=$1 AND o.type=$2':'o.type=$2'}
      AND NOT EXISTS(SELECT 1 FROM ${this.q}.ontology_tombstones t WHERE t.ontology_id=$1 AND t.owner=o.owner AND t.type=o.type AND t.id=o.id)
      ORDER BY o.owner COLLATE "C",o.id COLLATE "C" LIMIT 10001`,[id,type]);
    return {items:rows.rows.filter(row=>typeof row.body==='string').slice(0,10000),overflow:rows.rows.length>10000||rows.rows.some(row=>typeof row.body!=='string')};
  }
  private async links(id:string,type?:string){
    const scoped=id!=='eigos.business';return (await this.sql(`SELECT DISTINCT l.type COLLATE "C" AS type,l.definition_digest COLLATE "C" AS definition_digest FROM ${this.q}.ontology_${scoped?'scoped_':''}links l
      WHERE ${scoped?'l.ontology_id=$1 AND ':''}${type?'l.type=$2 AND ':''}NOT EXISTS(SELECT 1 FROM ${this.q}.ontology_tombstones t WHERE t.ontology_id=$1 AND t.owner=l.owner
        AND((t.type=l.from_type AND t.id=l.from_id) OR(t.type=l.to_type AND t.id=l.to_id))) ORDER BY l.type COLLATE "C",l.definition_digest COLLATE "C" LIMIT 10001`,type?[id,type]:[id])).rows;
  }
  private async inflight(id:string){
    const rows=await this.sql(`SELECT ${this.q}.eigos_try_jsonb(body) IS NULL AS invalid FROM ${this.q}.jobs WHERE state NOT IN('completed','canceled','rejected','failed')
      AND(${this.q}.eigos_try_jsonb(body) IS NULL OR coalesce(${this.q}.eigos_try_jsonb(body)#>>'{delegation,ontologyRelease,ontologyId}','eigos.business')=$1) LIMIT 1`,[id]);
    if(rows.rows.some(row=>row.invalid))return conflict('In-flight task metadata is incomplete');return !!rows.rowCount;
  }
  async validate(id:string):Promise<DefinitionValidation>{
    const draft=await this.draft(id);let document=draft.document;
    try{
      document=normalizeOntologyDocument(document);const model=this.compile(document),base=await this.resolve(draft.base),changes=definitionChanges(base.document,document);
      const pipelineIssues=await this.pipeline.validateDocument(document,model),names=new Map<string,{resource_id:unknown;kind:unknown}|undefined>(),canonicalGeneratedLinks=new Set<string>(),objects=new Map<string,{items:Record<string,unknown>[];overflow:boolean}>(),linkPresence=new Map<string,boolean>();
      for(const change of changes){
        const row=await this.sql(`SELECT resource_id,kind FROM ${this.q}.ontology_definition_names WHERE ontology_id=$1 AND category=$2 AND api_name=$3 LIMIT 2`,[draft.ontologyId,definitionNameCategory(change.kind),change.id]);
        if((row.rowCount??0)>1)return conflict('Published definition identity is ambiguous');names.set(JSON.stringify([definitionNameCategory(change.kind),change.id]),row.rows[0]);
        if(row.rowCount&&change.change==='added'){
          const restored=document.links.find(link=>link.resourceId===change.resourceId);
          if(change.kind==='link'&&change.resourceId.startsWith('generated:execution-link:')&&restored&&(await this.sql(`SELECT 1 FROM ${this.q}.ontology_definition_revisions WHERE ontology_id=$1 AND resource_id=$2 AND kind='link' AND digest=$3 LIMIT 1`,[draft.ontologyId,change.resourceId,digest(restored)])).rowCount)canonicalGeneratedLinks.add(JSON.stringify([change.resourceId,digest(restored)]));
        }
        if(change.kind==='object'&&change.change!=='added')objects.set(change.id,await this.instances(draft.ontologyId,change.id));
        if(change.kind==='link'&&change.change==='retired')linkPresence.set(change.id,(await this.links(draft.ontologyId,change.id)).length>0);
      }
      return validateDefinitionSnapshot(draft,{document,model,base,namespace:await this.namespace(draft.ontologyId),pipelineIssues,names,canonicalGeneratedLinks,objects,linkPresence,hasInflightTasks:changes.some(value=>value.change==='retired')&&await this.inflight(draft.ontologyId)});
    }catch(error){return invalidDefinitionValidation(draft,document,error,await this.changes({...draft,document}));}
  }
  private async pipelineIdentity(id:string,prior:NonNullable<OntologyDocument['pipeline']>[number],next:NonNullable<OntologyDocument['pipeline']>[number]|undefined){
    if(!next)return conflict('Activation cannot remove governed service intake policies');
    const before=await this.pipeline.intake(id,prior),after=await this.pipeline.intake(id,next);
    if(before.programRef.id!==after.programRef.id||before.source.id!==after.source.id||before.actions.some(action=>!after.actions.some(value=>value.actionId===action.actionId)))return conflict('A governed service/action identity cannot be removed or reassigned; publish definition_only to retire execution');
  }
  async putPipeline(owner:string,id:string,revision:number,input:unknown,admin=false){
    const draft=await this.editing(owner,id,revision,admin),ref=await this.pipeline.put(draft.ontologyId,owner,input),prior=draft.document.pipeline?.find(value=>value.serviceId===ref.serviceId);
    if(prior)await this.pipelineIdentity(draft.ontologyId,prior,ref);
    draft.document.pipeline=[...(draft.document.pipeline??[]).filter(value=>value.serviceId!==ref.serviceId),ref].sort((a,b)=>a.serviceId.localeCompare(b.serviceId));draft.document=parseOntologyDocument(draft.document);
    await this.event(draft.ontologyId,owner,'pipeline_intake_edited',{draftId:id,...ref});return this.saveDraft(draft,revision);
  }
  async pipelineDraft(owner:string,id:string,revision:number,serviceId:string,admin=false){
    const draft=await this.editing(owner,id,revision,admin),ref=draft.document.pipeline?.find(value=>value.serviceId===serviceId);
    if(!ref)throw new DomainError('NOT_FOUND','Service intake is not attached to this draft');return {draft,ref,model:this.compile(draft.document)};
  }
  async validatePipeline(owner:string,id:string,revision:number,serviceId:string,expiresAt:string,admin=false){const {draft,ref,model}=await this.pipelineDraft(owner,id,revision,serviceId,admin);return this.pipeline.validate(draft.ontologyId,owner,ref,model,expiresAt);}
  private async activationFacts(release:Awaited<ReturnType<PostgresDefinitionStore['resolve']>>){
    const id=release.ref.ontologyId,scoped=id!=='eigos.business',types=await this.sql(`SELECT DISTINCT o.type COLLATE "C" AS type FROM ${this.q}.ontology_${scoped?'scoped_':''}objects o
      WHERE ${scoped?'o.ontology_id=$1 AND ':''}NOT EXISTS(SELECT 1 FROM ${this.q}.ontology_tombstones t WHERE t.ontology_id=$1 AND t.owner=o.owner AND t.type=o.type AND t.id=o.id) ORDER BY o.type COLLATE "C" LIMIT 2001`,[id]);
    if(types.rows.length>2000)return conflict('Activation data compatibility needs an explicit bounded migration');
    for(const row of types.rows){
      const type=String(row.type),rows=await this.instances(id,type);if(rows.overflow)return conflict('Activation data compatibility needs an explicit bounded migration');
      try{
        const currentDigest=release.model.fingerprint(type);
        for(const item of rows.items){const properties=JSON.parse(String(item.body)).properties,storedDigest=String(item.definition_digest);
          if(digest(release.model.parseProperties(type,properties))!==digest(properties)||storedDigest!==currentDigest&&!await postgresOntologyDefinitionCompatible(this.client,release.ref,{kind:'object',id:type,storedDigest,currentDigest,properties},this.options.builder))return conflict('Activation would reinterpret existing facts');}
      }catch{return conflict(`Activation requires a data migration for ${type}`);}
    }
    const links=await this.links(id);if(links.length>10000)return conflict('Activation link compatibility needs an explicit bounded migration');
    for(const row of links){const type=String(row.type),storedDigest=String(row.definition_digest);
      try{const currentDigest=digest(release.model.link(type));if(storedDigest!==currentDigest&&!await postgresOntologyDefinitionCompatible(this.client,release.ref,{kind:'link',id:type,storedDigest,currentDigest},this.options.builder))return conflict('Activation would reinterpret existing relationships');}
      catch{return conflict(`Activation requires a relationship migration for ${type}`);}}
  }
  async publish(owner:string,id:string,revision:number,admin=false){
    const draft=await this.draft(id);await this.assertManagement(owner,draft.ontologyId,admin);
    if(draft.status==='published'&&draft.published&&draft.revision===revision+1)return {release:draft.published,draft:summary(draft)};
    if(draft.status!=='open'||draft.revision!==revision)return conflict('Draft is not open at the expected revision');
    const validation=await this.validate(id);if(!validation.valid)return conflict(validation.issues.map(value=>value.message).join('; '));
    const sequence=Number((await this.sql(`SELECT coalesce(max(sequence),0)+1 AS next FROM ${this.q}.ontology_definition_releases WHERE ontology_id=$1`,[draft.ontologyId])).rows[0]?.next);
    if(!Number.isSafeInteger(sequence)||sequence<1)return conflict('Release sequence exceeds its supported range');
    draft.document=normalizeOntologyDocument({...draft.document,version:`release-${sequence}`});const release=await this.insertRelease(draft.document,owner,draft.base);
    draft.status='published';draft.published={...release.ref};const saved=await this.saveDraft(draft,revision);await this.event(draft.ontologyId,owner,'published',{draftId:id,release:release.ref});return {release:release.ref,draft:summary(saved)};
  }
  async activate(owner:string,input:OntologyReleaseRef,expected:number,admin=false){
    const ref=ontologyReleaseRefSchema.parse(input);await this.assertManagement(owner,ref.ontologyId,admin);
    const release=await this.resolve(ref),namespace=await this.namespace(ref.ontologyId);
    if(digest(namespace.active)===digest(ref)&&[expected,expected+1].includes(namespace.generation))return namespace;
    if(namespace.generation!==expected)return conflict('Active ontology generation changed');
    const prior=await this.sql(`SELECT 1 FROM ${this.q}.ontology_definition_promotions WHERE ontology_id=$1 AND release_id=$2 LIMIT 1`,[ref.ontologyId,ref.releaseId]);
    const lineage=await this.sql(`SELECT CASE WHEN octet_length(base_ref)<=1024 THEN base_ref END AS base_ref FROM ${this.q}.ontology_definition_lineage WHERE ontology_id=$1 AND release_id=$2 LIMIT 2`,[ref.ontologyId,ref.releaseId]);
    if(!prior.rowCount&&(lineage.rowCount!==1||typeof lineage.rows[0]?.base_ref!=='string'||digest(ontologyReleaseRefSchema.parse(JSON.parse(lineage.rows[0].base_ref)))!==digest(namespace.active)))return conflict('Published release base changed; publish a fresh reviewed draft before activation');
    const current=await this.resolve(namespace.active);for(const intake of current.document.pipeline??[])await this.pipelineIdentity(ref.ontologyId,intake,release.document.pipeline?.find(value=>value.serviceId===intake.serviceId));
    const issues=await this.pipeline.validateDocument(release.document,release.model);if(issues.length)return conflict(issues.map(value=>value.message).join('; '));
    const identities=new Set(entries(release.document).map(value=>value.definition.resourceId));if(entries(current.document).some(value=>!identities.has(value.definition.resourceId))&&await this.inflight(ref.ontologyId))return conflict('Retiring definitions used by in-flight tasks requires a migration');
    await this.activationFacts(release);
    const changed=await this.sql(`UPDATE ${this.q}.ontology_namespaces SET active_release_id=$1,generation=generation+1 WHERE id=$2 AND generation=$3`,[ref.releaseId,ref.ontologyId,expected]);
    if(changed.rowCount!==1)return conflict('Active ontology generation changed');await this.promotion(ref);await this.event(ref.ontologyId,owner,'activated',{from:namespace.active,to:ref,generation:expected+1});return this.namespace(ref.ontologyId);
  }
  async discard(owner:string,id:string,revision:number,admin=false){const draft=await this.editing(owner,id,revision,admin);draft.status='discarded';const saved=await this.saveDraft(draft,revision);await this.event(draft.ontologyId,owner,'draft_discarded',{draftId:id});return summary(saved);}
  async releasePage(id:string,input:{limit:number;offset:number}){
    const page=this.page(input),total=Number((await this.sql(`SELECT count(*) AS n FROM ${this.q}.ontology_definition_releases WHERE ontology_id=$1`,[id])).rows[0]?.n);
    if(!Number.isSafeInteger(total)||total<0)return conflict('Release inventory exceeds its supported range');
    const rows=await this.sql(`SELECT id,sequence,digest,model_digest,created_at FROM ${this.q}.ontology_definition_releases WHERE ontology_id=$1 ORDER BY sequence DESC LIMIT $2 OFFSET $3`,[id,page.limit,page.offset]);
    return {items:rows.rows.map(row=>({ref:ontologyReleaseRefSchema.parse({ontologyId:id,releaseId:row.id,digest:row.digest}),sequence:Number(row.sequence),modelDigest:String(row.model_digest),createdAt:String(row.created_at)})),total,page:{...page,hasMore:page.offset+rows.rows.length<total}};
  }
  async events(id:string,limit=50){
    const rows=await this.sql(`SELECT id,actor,kind,CASE WHEN octet_length(body)<=1048576 THEN body END AS body,at FROM ${this.q}.ontology_definition_events WHERE ontology_id=$1 ORDER BY __eigos_rowid DESC LIMIT $2`,[id,Math.max(1,Math.min(100,limit))]);
    if(rows.rows.some(row=>typeof row.body!=='string'))return conflict('Definition history exceeds its read bound');return rows.rows.map(row=>({id:String(row.id),actor:String(row.actor),kind:String(row.kind),data:JSON.parse(row.body),at:String(row.at)}));
  }
}

type IntakeRef=NonNullable<OntologyDocument['pipeline']>[number];
type Sql=(text:string,values?:unknown[])=>Promise<{rowCount:number|null;rows:Record<string,unknown>[]} >;
const sha=z.string().regex(/^[a-f0-9]{64}$/),instant=z.iso.datetime({offset:true});
const verificationSchema=z.strictObject({id:z.string().min(1).max(100),intakeDigest:sha,mappingDigest:sha,contractDigest:sha,kind:z.enum(['mapping_test','task_evidence']),level:z.string().min(1).max(100),
  actionIds:z.array(z.string().min(1).max(200)).max(1000),evidenceRefs:z.array(z.string().min(1).max(2000)).max(10000),taskId:z.string().min(1).max(200).optional(),verifiedAt:instant,expiresAt:instant,
  actionEvidence:z.record(z.string(),z.strictObject({level:z.string().min(1).max(100),evidenceRefs:z.array(z.string().min(1).max(2000)).max(10000),observedAt:instant})).optional(),availabilityProof:z.literal(false),authorizationProof:z.literal(false)});

/** SQL counterpart of the shared Pipeline policy. Verification reads are
 * complete within explicit bounds; no runtime, availability or authority is
 * inferred from mapping fixtures or from a whole-task evidence label. */
class PostgresDefinitionPipeline {
  constructor(private readonly q:string,private readonly sql:Sql,readonly now:()=>number){}
  async put(id:string,actor:string,input:unknown){
    const intake=parsePipelineIntake(input),hash=digest(intake);if(Date.parse(intake.source.observedAt)>this.now())return conflict('Source material cannot be observed in the future');
    await this.sql(`INSERT INTO ${this.q}.ontology_pipeline_intakes(ontology_id,digest,service_id,actor,body,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[id,hash,intake.serviceId,actor,JSON.stringify(intake),new Date(this.now()).toISOString()]);
    await this.intake(id,{serviceId:intake.serviceId,intakeDigest:hash});return {serviceId:intake.serviceId,intakeDigest:hash};
  }
  async intake(id:string,ref:IntakeRef):Promise<PipelineIntake>{
    const rows=await this.sql(`SELECT CASE WHEN octet_length(body)<=8388608 THEN body END AS body FROM ${this.q}.ontology_pipeline_intakes WHERE ontology_id=$1 AND digest=$2 AND service_id=$3 LIMIT 2`,[id,ref.intakeDigest,ref.serviceId]);
    if(!rows.rowCount)throw new DomainError('NOT_FOUND','Published service intake is unavailable');
    if(rows.rowCount!==1||typeof rows.rows[0]?.body!=='string')return conflict('Service intake exceeds its read bound');
    const intake=parsePipelineIntake(JSON.parse(rows.rows[0].body));if(digest(intake)!==ref.intakeDigest||intake.serviceId!==ref.serviceId)return conflict('Service intake digest changed');return intake;
  }
  contract(model:OntologyModel,intake:PipelineIntake){return pipelineContract(model,intake);}
  private async save(id:string,owner:string,proof:PipelineVerification){
    const value=verificationSchema.parse(proof);await this.sql(`INSERT INTO ${this.q}.ontology_pipeline_verifications(id,ontology_id,intake_digest,owner,body) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[value.id,id,value.intakeDigest,owner,JSON.stringify(value)]);
    const rows=await this.sql(`SELECT ontology_id,intake_digest,owner,CASE WHEN octet_length(body)<=1048576 THEN body END AS body FROM ${this.q}.ontology_pipeline_verifications WHERE id=$1 LIMIT 2`,[value.id]);
    if(rows.rowCount!==1||rows.rows[0]?.ontology_id!==id||rows.rows[0].intake_digest!==value.intakeDigest||rows.rows[0].owner!==owner||typeof rows.rows[0].body!=='string'||digest(verificationSchema.parse(JSON.parse(rows.rows[0].body)))!==digest(value))return conflict('Immutable Pipeline verification differs');
  }
  async validate(id:string,actor:string,ref:IntakeRef,model:OntologyModel,expiresAt:string){
    const intake=await this.intake(id,ref),issues=pipelineContractIssues(model,intake);if(issues.length)return {valid:false as const,issues};
    assertPipelineVerificationExpiry(expiresAt,this.now(),this.now);
    const verification:PipelineVerification={id:randomUUID(),intakeDigest:ref.intakeDigest,mappingDigest:pipelineMappingDigest(intake),contractDigest:pipelineContract(model,intake),kind:'mapping_test',level:'synthetic',actionIds:[],evidenceRefs:intake.fixtures.map(value=>`fixture:${digest(value)}`),verifiedAt:new Date(this.now()).toISOString(),expiresAt,availabilityProof:false,authorizationProof:false};
    await this.save(id,actor,verification);return {valid:true as const,issues,verification};
  }
  async verifyTask(id:string,owner:string,ref:IntakeRef,model:OntologyModel,job:Job,intent:(id:string)=>ActionIntent,expiresAt:string){
    const intake=await this.intake(id,ref),rows=await this.sql(`SELECT 1 FROM ${this.q}.ontology_pipeline_verifications WHERE owner=$1 AND ontology_id=$2
      AND(${this.q}.eigos_try_jsonb(body) IS NULL OR(${this.q}.eigos_try_jsonb(body)->>'taskId'=$3 AND ${this.q}.eigos_try_jsonb(body)->>'mappingDigest'<>$4)) LIMIT 1`,[owner,id,job.id,pipelineMappingDigest(intake)]);
    const proof=pipelineTaskVerification(id,owner,ref,model,intake,job,intent,expiresAt,this.now,!!rows.rowCount);await this.save(id,owner,proof);return proof;
  }
  private async verifications(id:string,ref:IntakeRef,kind:PipelineVerification['kind'],owner=''){
    const rows=await this.sql(`SELECT id,intake_digest,owner,CASE WHEN octet_length(body)<=1048576 AND sum(octet_length(body)) OVER()<=8388608 THEN body END AS body
      FROM ${this.q}.ontology_pipeline_verifications WHERE ontology_id=$1 AND intake_digest=$2
      AND(${this.q}.eigos_try_jsonb(body) IS NULL OR(${this.q}.eigos_try_jsonb(body)->>'kind'=$3 AND($3='mapping_test' OR owner=$4))) ORDER BY __eigos_rowid DESC LIMIT 201`,[id,ref.intakeDigest,kind,owner]);
    if(rows.rows.length>200||rows.rows.some(row=>typeof row.body!=='string'))return conflict('Pipeline verification history exceeds its complete read bound');
    return rows.rows.map(row=>{const value=verificationSchema.parse(JSON.parse(String(row.body)));if(value.id!==row.id||value.intakeDigest!==row.intake_digest||value.intakeDigest!==ref.intakeDigest||value.kind!==kind||kind==='task_evidence'&&row.owner!==owner)return conflict('Pipeline verification identity is invalid');return value;});
  }
  private async revokedMany(id:string,serviceId:string,proofIds:readonly string[]){
    const rows=await this.sql(`WITH events AS(SELECT CASE WHEN octet_length(body)<=1048576 THEN ${this.q}.eigos_try_jsonb(body) END AS value
      FROM ${this.q}.ontology_pipeline_events WHERE ontology_id=$1 AND service_id=$2 AND kind='verification_revoked')
      SELECT bool_or(value IS NULL OR jsonb_typeof(value->'verificationId') IS DISTINCT FROM 'string' OR octet_length(value->>'verificationId')>100) AS invalid,
        coalesce(array_agg(DISTINCT value->>'verificationId') FILTER(WHERE value->>'verificationId'=ANY($3::text[])),ARRAY[]::text[]) AS ids FROM events`,[id,serviceId,[...new Set(proofIds)]]);
    const row=rows.rows[0];if(rows.rowCount!==1||row?.invalid===true||!Array.isArray(row?.ids)||row.ids.some(value=>typeof value!=='string'||!proofIds.includes(value)))return conflict('Pipeline revocation history is incomplete');
    return new Set(row.ids as string[]);
  }
  private async sourceMatches(id:string,intake:PipelineIntake){
    const rows=await this.sql(`SELECT CASE WHEN octet_length(body)<=1048576 THEN body END AS body FROM ${this.q}.ontology_pipeline_events WHERE ontology_id=$1 AND service_id=$2 AND kind='source_changed' ORDER BY sequence DESC LIMIT 1`,[id,intake.serviceId]);
    if(!rows.rowCount)return true;if(typeof rows.rows[0]?.body!=='string')return conflict('Pipeline source history exceeds its read bound');
    const source=z.object({sourceDigest:sha}).parse(JSON.parse(rows.rows[0].body));return source.sourceDigest===intake.source.digest;
  }
  private async intakeIssues(id:string,ref:IntakeRef,intake:PipelineIntake,model:OntologyModel){
    const issues=pipelineContractIssues(model,intake);if(!await this.sourceMatches(id,intake))issues.push('Latest observed source contract differs from this intake');
    const contract=pipelineContract(model,intake),proofs=await this.verifications(id,ref,'mapping_test'),revoked=await this.revokedMany(id,intake.serviceId,proofs.map(value=>value.id));let valid=false;
    for(const proof of proofs)if(proof.contractDigest===contract&&Date.parse(proof.expiresAt)>this.now()&&!revoked.has(proof.id))valid=true;
    if(!valid)issues.push('Current intake needs a fresh mapping validation');return issues;
  }
  async validateIntake(id:string,ref:IntakeRef,model:OntologyModel){try{return (await this.intakeIssues(id,ref,await this.intake(id,ref),model)).map(message=>({code:'pipeline_validation_required',message:`${ref.serviceId}: ${message}`}));}catch(error){return [{code:'pipeline_invalid',message:error instanceof Error?error.message:'Invalid intake'}];}}
  async validateDocument(document:OntologyDocument,model:OntologyModel){
    const issues:{code:string;message:string}[]=[],services=new Set<string>(),bindings=new Set<string>();
    for(const ref of document.pipeline??[]){try{
      if(services.has(ref.serviceId))return conflict('Duplicate service intake');services.add(ref.serviceId);
      const intake=await this.intake(document.id,ref),errors=await this.intakeIssues(document.id,ref,intake,model);
      for(const action of intake.actions){const key=digest({program:intake.programRef,configuration:intake.configurationDigest,action:action.actionId});if(bindings.has(key))errors.push('Two intakes claim the same exact executable binding');bindings.add(key);}
      issues.push(...errors.map(message=>({code:'pipeline_validation_required',message:`${ref.serviceId}: ${message}`})));
    }catch(error){issues.push({code:'pipeline_invalid',message:error instanceof Error?error.message:'Invalid intake'});}}
    return issues;
  }
  async event(id:string,actor:string,serviceId:string,change:{kind:'source_changed';sourceDigest:string}|{kind:'verification_revoked';verificationId:string}){
    if(change.kind==='verification_revoked'){
      const rows=await this.sql(`SELECT intake_digest FROM ${this.q}.ontology_pipeline_verifications WHERE ontology_id=$1 AND id=$2 LIMIT 2`,[id,change.verificationId]);
      if(rows.rowCount!==1||!rows.rows[0])throw new DomainError('NOT_FOUND','Verification is not available');await this.intake(id,{serviceId,intakeDigest:String(rows.rows[0].intake_digest)});
    }else sha.parse(change.sourceDigest);
    const body={...change,at:new Date(this.now()).toISOString()};await this.sql(`INSERT INTO ${this.q}.ontology_pipeline_events(ontology_id,actor,service_id,kind,body) VALUES($1,$2,$3,$4,$5)`,[id,actor,serviceId,change.kind,JSON.stringify(body)]);return body;
  }
  async status(owner:string,document:OntologyDocument,model:OntologyModel,programRef:{id:string;version:string},configurationDigest:string,actionId:string):Promise<PipelineStatus>{
    const base={authorization:'per_action_required' as const,availabilityProof:false as const,verificationIds:[] as string[]},candidates=[];
    for(const ref of document.pipeline??[]){const intake=await this.intake(document.id,ref);if(intake.programRef.id===programRef.id&&intake.actions.some(action=>action.actionId===actionId))candidates.push({ref,intake});}
    if(!candidates.length)return {...base,status:'unmanaged',reason:'This historical/configured binding has not entered the intake pipeline'};
    const selected=candidates.find(({intake})=>digest(intake.programRef)===digest(programRef)&&intake.configurationDigest===configurationDigest);
    if(!selected)return {...base,status:'contract_changed',reason:'Program or connection configuration needs a matching validated intake'};
    const {ref,intake}=selected,detail={...base,serviceId:ref.serviceId,intakeDigest:ref.intakeDigest,mappingDigest:pipelineMappingDigest(intake),conditions:intake.conditions,terms:[...new Set(intake.vocabulary.flatMap(value=>[value.term,...value.aliases]))].slice(0,50)},entry=intake.actions.find(value=>value.actionId===actionId)!;
    if(entry.requiredEvidence==='definition_only')return {...detail,status:'definition_only',reason:'This claim is published for modeling only'};
    if(!await this.sourceMatches(document.id,intake))return {...detail,status:'source_changed',reason:'Source contract changed; revalidate and publish its new mapping'};
    let contract:string;try{contract=pipelineContract(model,intake);if(digest(model.action(actionId))!==entry.definitionDigest)return conflict('Changed definition');}catch{return {...detail,status:'contract_changed',reason:'Published action or mapped object contract changed'};}
    const all=[...await this.verifications(document.id,ref,'mapping_test'),...await this.verifications(document.id,ref,'task_evidence',owner)].filter(value=>value.contractDigest===contract),revokedIds=await this.revokedMany(document.id,intake.serviceId,all.map(value=>value.id)),fresh=all.filter(value=>Date.parse(value.expiresAt)>this.now()&&!revokedIds.has(value.id));const revoked=all.some(value=>revokedIds.has(value.id));
    const structure=fresh.find(value=>value.kind==='mapping_test'),proof=fresh.find(value=>verificationCoversAction(entry,intake.actions,value));
    if(structure&&proof)return {...detail,status:'verified',verificationIds:[structure.id,proof.id],reason:'Exact contract and owner-scoped execution evidence match; current availability and authorization still require checks'};
    return {...detail,status:revoked?'revoked':all.some(value=>Date.parse(value.expiresAt)<=this.now())?'expired':'verification_required',reason:'Fresh mapping and matching action/readback evidence are required for this owner'};
  }
  async validationStatus(owner:string,document:OntologyDocument,model:OntologyModel,scope:PipelineValidationScope,programRef:{id:string;version:string},configurationDigest:string,actionId:string):Promise<PipelineStatus>{
    const closed:PipelineStatus={status:'definition_only',reason:'This action is outside the bounded operator validation task',verificationIds:[],authorization:'per_action_required',availabilityProof:false};
    if(scope.ownerDigest!==digest(owner)||Date.parse(scope.expiresAt)<=this.now())return closed;
    const ref=document.pipeline?.find(value=>value.serviceId===scope.serviceId&&value.intakeDigest===scope.intakeDigest);if(!ref)return closed;
    const intake=await this.intake(document.id,ref);if(pipelineMappingDigest(intake)!==scope.mappingDigest||!await this.sourceMatches(document.id,intake))return closed;
    if((programRef.id==='eigos.goal'||programRef.id.startsWith('services.compose.'))&&actionEffects(model.action(actionId)).every(effect=>effect==='local'))return {...closed,status:'unmanaged',reason:'Local goal bookkeeping'};
    if(digest(programRef)!==digest(intake.programRef)||configurationDigest!==intake.configurationDigest||!intake.actions.some(value=>value.actionId===actionId&&value.definitionDigest===digest(model.action(actionId))))return closed;
    const contract=pipelineContract(model,intake),proofs=await this.verifications(document.id,ref,'mapping_test'),revoked=await this.revokedMany(document.id,intake.serviceId,proofs.map(value=>value.id));let structural:PipelineVerification|undefined;
    for(const value of proofs)if(value.contractDigest===contract&&Date.parse(value.expiresAt)>this.now()&&!revoked.has(value.id)){structural=value;break;}
    return structural?{...closed,status:'validation_only',serviceId:ref.serviceId,intakeDigest:ref.intakeDigest,mappingDigest:scope.mappingDigest,conditions:intake.conditions,verificationIds:[structural.id],reason:'Operator-scoped validation only; the normal source, goal and exact effect grants remain required'}:closed;
  }
  async uses(owner:string,jobId:string){const rows=await this.sql(`SELECT intent_id,CASE WHEN octet_length(body)<=1048576 AND sum(octet_length(body)) OVER()<=8388608 THEN body END AS body FROM ${this.q}.ontology_pipeline_uses WHERE owner=$1 AND job_id=$2 ORDER BY __eigos_rowid LIMIT 101`,[owner,jobId]);if(rows.rows.length>100||rows.rows.some(row=>typeof row.body!=='string'))return conflict('Pipeline task uses exceed their complete read bound');return rows.rows.map(row=>({intentId:String(row.intent_id),...JSON.parse(String(row.body))}));}
}
