import type {Client,QueryResult,QueryResultRow} from 'pg';
import {z} from 'zod';
import {digest} from '../core/delegation.js';
import {DomainError} from '../core/domain.js';
import {ownerIdentitySchema} from '../security/contracts.js';
import {SecurityError} from '../security/errors.js';
import {objectRefSchema,type ObjectRef,type OntologyModel} from '../ontology/model.js';
import {ontologyReleaseRefSchema,type OntologyReleaseRef} from '../ontology/definition-contracts.js';
import {isVirtualRef,networkLinkIds} from '../ontology/network-model.js';
import {IncompleteRelationshipRead,linkSnapshotDigest,objectQuerySchema,ontologyCursorSchema,ontologyBatchSchema,ontologySourceSchema,
  type ObjectBatch,type ObjectSource,type ObjectView,type ObjectQuery,type OntologyQueryResult,type ReadBudget,type LinkWrite} from '../ontology/object-store.js';
import {runGraphProgramAsync,type GraphProgram,type GraphStorage,type ProjectionMetadata} from '../ontology/graph-program.js';
import type {StagedKernelBuilder} from '../ontology/seed-definition.js';
import {postgresBusinessSchema,postgresBusinessToken} from './runtime-transaction.js';
import {postgresAssertOntologyAccess,postgresOntologyRelease,postgresOntologyDefinitionCompatible} from './ontology-release.js';
import {assertIdentityAssertionWriteProgram} from '../ontology/identity-mapping.js';
import {assertTransactionPartyRoleWriteProgram} from '../ontology/errand-domain.js';

function fail(message:string):never {throw new DomainError('INVALID_INPUT',message);}
type RawObject={view:ObjectView;definitionDigest:string;body:string};

/** Privileged projection storage only, never a public ontology reader. The
 * enclosing task/source command supplies its authorization and mutation fence.
 * Definitions come from the exact shared immutable release, not a local copy.
 * Object writes during its lifetime use this graph; direct SQL mutation must
 * finish before a graph is constructed. Caches never cross its transaction. */
export class PostgresProjectionGraph implements GraphStorage,ProjectionMetadata {
  readonly security=true;
  readonly model:OntologyModel;
  readonly releaseRef:OntologyReleaseRef;
  readonly ontologyId:string;
  readonly now:()=>number;
  private readonly schema:string;
  private readonly token:object;
  private readonly scoped:boolean;
  private readonly compatibility=new Map<string,Promise<boolean>>();
  private readonly objects=new Map<string,RawObject|undefined>();
  private readonly deleted=new Map<string,{ref:ObjectRef;revision:number;deletedAt:string}|undefined>();
  private objectBytes=0;
  private constructor(private readonly client:Client,private readonly owner:string,
    release:Awaited<ReturnType<typeof postgresOntologyRelease>>,private readonly builder:StagedKernelBuilder|undefined,now:()=>number) {
    this.schema=postgresBusinessSchema(client);this.token=postgresBusinessToken(client);
    this.model=release.model;this.releaseRef=release.ref;this.ontologyId=release.ref.ontologyId;
    this.scoped=this.ontologyId!=='eigos.business';this.now=now;
  }
  static async create(client:Client,owner:string,input:OntologyReleaseRef,builder?:StagedKernelBuilder,options:{admin?:boolean;now?:()=>number}={}) {
    ownerIdentitySchema.parse(owner);const ref=ontologyReleaseRefSchema.parse(input),token=postgresBusinessToken(client);
    if(options.admin!==undefined && typeof options.admin!=='boolean')throw new Error('Invalid ontology administration context');
    await postgresAssertOntologyAccess(client,owner,ref.ontologyId,options.admin??false);
    const release=await postgresOntologyRelease(client,ref,builder);
    if(postgresBusinessToken(client)!==token)throw new SecurityError('AUTHORIZATION_REQUIRED');
    return new PostgresProjectionGraph(client,owner,release,builder,options.now??Date.now);
  }
  private assertOpen(owner=this.owner) {
    if(owner!==this.owner)throw new DomainError('FORBIDDEN','Projection belongs to another owner');
    try {if(postgresBusinessSchema(this.client)!==this.schema || postgresBusinessToken(this.client)!==this.token)throw new Error('Transaction changed');}
    catch {throw new SecurityError('AUTHORIZATION_REQUIRED');}
  }
  private table(kind:'objects'|'links'|'revisions') {return `"${this.schema}".ontology_${this.scoped?'scoped_':''}${kind}`;}
  private owned(values:unknown[],alias='') {
    const prefix=alias?alias+'.':'';const clauses=[];
    if(this.scoped){values.push(this.ontologyId);clauses.push(`${prefix}ontology_id=$${values.length}`);}
    values.push(this.owner);clauses.push(`${prefix}owner=$${values.length}`);return clauses.join(' AND ');
  }
  private async sql<R extends QueryResultRow=Record<string,unknown>>(text:string,values:unknown[]=[]){
    this.assertOpen();const result=await this.client.query<R>(text,values);this.assertOpen();return result;
  }
  private one<R extends QueryResultRow>(result:QueryResult<R>):R {
    const row=result.rows[0];if(result.rowCount!==1||result.rows.length!==1||!row)throw new DomainError('CONFLICT','Unexpected projection row count');return row;
  }
  private count(result:QueryResult<Record<string,unknown>>,field='n'):number {
    const value=Number(this.one(result)[field]);if(!Number.isSafeInteger(value)||value<0)throw new DomainError('CONFLICT','Invalid projection count');return value;
  }
  private charge(budget:ReadBudget,count=1){budget.remaining-=count;if(budget.remaining<0)throw new DomainError('CONFLICT','Ontology read work budget exhausted; narrow the query');}
  private cacheObject(ref:ObjectRef,value:RawObject|undefined){
    const key=JSON.stringify([ref.type,ref.id]),old=this.objects.get(key);
    this.objectBytes-=old?Buffer.byteLength(old.body):0;this.objects.delete(key);
    const bytes=value?Buffer.byteLength(value.body):0;
    while(this.objects.size>=512||this.objectBytes+bytes>8388608){const first=this.objects.keys().next().value;if(first===undefined)break;
      const removed=this.objects.get(first);this.objectBytes-=removed?Buffer.byteLength(removed.body):0;this.objects.delete(first);}
    this.objects.set(key,value);this.objectBytes+=bytes;
  }
  private async objectDefinition(type:string,storedDigest:string,properties:Record<string,unknown>){
    const currentDigest=this.model.fingerprint(type);if(storedDigest===currentDigest)return;
    const key=digest(['object',type,storedDigest,currentDigest,properties]);
    let pending=this.compatibility.get(key);
    if(!pending){pending=postgresOntologyDefinitionCompatible(this.client,this.releaseRef,{kind:'object',id:type,storedDigest,currentDigest,properties},this.builder);this.compatibility.set(key,pending);}
    const compatible=await pending;this.assertOpen();
    if(!compatible || digest(this.model.parseProperties(type,properties))!==digest(properties))throw new DomainError('CONFLICT','Object definition changed; historical data cannot be reinterpreted');
  }
  private async linkDefinition(type:string,storedDigest:string){
    const currentDigest=digest(this.model.link(type));if(storedDigest===currentDigest)return;
    const key=digest(['link',type,storedDigest,currentDigest]);let pending=this.compatibility.get(key);
    if(!pending){pending=postgresOntologyDefinitionCompatible(this.client,this.releaseRef,{kind:'link',id:type,storedDigest,currentDigest},this.builder);this.compatibility.set(key,pending);}
    const compatible=await pending;this.assertOpen();if(!compatible)throw new DomainError('CONFLICT','Pinned link definition changed');
  }
  private async raw(ref:ObjectRef,budget:ReadBudget,allowTombstone=false):Promise<RawObject>{
    objectRefSchema.parse(ref);this.model.object(ref.type);this.charge(budget);
    if(isVirtualRef(ref))throw new DomainError('FORBIDDEN','Network objects require their authorized read view');
    const key=JSON.stringify([ref.type,ref.id]);
    if(this.objects.has(key)){
      const cached=this.objects.get(key);if(!cached)throw new DomainError('NOT_FOUND','Ontology object not found');
      if(cached.view.tombstone&&!allowTombstone)throw new DomainError('NOT_FOUND','Ontology object was tombstoned');
      return structuredClone(cached);
    }
    const values:unknown[]=[],where=this.owned(values,'o');values.push(ref.type,ref.id,this.ontologyId);
    const rows=await this.sql(`SELECT o.revision,o.definition_digest,CASE WHEN octet_length(o.body)<=1048576 THEN o.body END AS body,
      deleted.revision AS deleted_revision,deleted.deleted_at FROM ${this.table('objects')} o LEFT JOIN "${this.schema}".ontology_tombstones deleted
        ON deleted.ontology_id=$${values.length} AND deleted.owner=o.owner AND deleted.type=o.type AND deleted.id=o.id
      WHERE ${where} AND o.type=$${values.length-2} AND o.id=$${values.length-1} LIMIT 2`,values);
    if(rows.rowCount===0){this.cacheObject(ref,undefined);throw new DomainError('NOT_FOUND','Ontology object not found');}
    const row=this.one(rows);if(row.body===null)throw new DomainError('CONFLICT','Ontology object exceeds its safe read bound');
    if(row.deleted_revision!==null&&!allowTombstone)throw new DomainError('NOT_FOUND','Ontology object was tombstoned');
    const body=JSON.parse(String(row.body));
    const revision=Number(row.revision);if(!Number.isSafeInteger(revision)||revision<1)throw new DomainError('CONFLICT','Invalid ontology revision');
    const deletedRevision=row.deleted_revision===null?undefined:Number(row.deleted_revision);
    if(deletedRevision!==undefined&&(!Number.isSafeInteger(deletedRevision)||deletedRevision<1))throw new DomainError('CONFLICT','Invalid tombstone revision');
    if(!body || !body.properties || typeof body.properties!=='object' || Array.isArray(body.properties) || !body.source || typeof body.createdAt!=='string'
      || body.properties[this.model.object(ref.type).primaryKey]!==ref.id)throw new DomainError('CONFLICT','Invalid ontology object body');
    await this.objectDefinition(ref.type,String(row.definition_digest),body.properties);
    const result:RawObject={definitionDigest:String(row.definition_digest),body:String(row.body),view:{ref,revision,properties:body.properties,source:body.source,createdAt:body.createdAt,
      ...(deletedRevision!==undefined?{tombstone:{revision:deletedRevision,deletedAt:String(row.deleted_at)}}:{})}};
    this.cacheObject(ref,result);
    if(this.deleted.size>=512)this.deleted.clear();
    this.deleted.set(key,result.view.tombstone?{ref,revision:result.view.tombstone.revision,deletedAt:result.view.tombstone.deletedAt}:undefined);
    return structuredClone(result);
  }
  private project(object:ObjectView,target:string,selected?:string[]):ObjectView {
    const definitions=this.model.properties(target),fields=selected??Object.keys(definitions).filter(name=>!definitions[name]!.restricted&&!definitions[name]!.derived),properties:Record<string,unknown>={};
    for(const name of fields){const property=definitions[name];if(!property)fail('Unknown property');
      if(property.restricted)throw new DomainError('FORBIDDEN','Property is not available through the agent query interface');
      if(property.derived)throw new DomainError('CONFLICT','Derived projection requires its authorized calculation runtime');
      const actual=this.model.propertyName(object.ref.type,target,name);if(object.properties[actual]!==undefined)properties[name]=object.properties[actual];
    }
    const {readContext:_readContext,...source}=object.source;return {...object,source,properties};
  }
  async read(owner:string,ref:ObjectRef,budget:ReadBudget={remaining:1000}){this.assertOpen(owner);const object=await this.raw(ref,budget);this.assertOpen(owner);return this.project(object.view,ref.type);}
  async readPrivate(owner:string,ref:ObjectRef,budget:ReadBudget={remaining:1000}){this.assertOpen(owner);const object=await this.raw(ref,budget);this.assertOpen(owner);return structuredClone(object.view);}
  async tombstone(owner:string,ref:ObjectRef){
    this.assertOpen(owner);objectRefSchema.parse(ref);
    const key=JSON.stringify([ref.type,ref.id]);if(this.deleted.has(key))return structuredClone(this.deleted.get(key));
    const rows=await this.sql(`SELECT revision,deleted_at FROM "${this.schema}".ontology_tombstones WHERE ontology_id=$1 AND owner=$2 AND type=$3 AND id=$4 LIMIT 2`,[this.ontologyId,this.owner,ref.type,ref.id]);
    if(this.deleted.size>=512)this.deleted.clear();
    if(rows.rowCount===0){this.deleted.set(key,undefined);return undefined;}if(rows.rowCount!==1)throw new DomainError('CONFLICT','Ambiguous tombstone');
    const row=this.one(rows),revision=Number(row.revision);if(!Number.isSafeInteger(revision)||revision<1)throw new DomainError('CONFLICT','Invalid tombstone revision');
    const value={ref,revision,deletedAt:String(row.deleted_at)};this.deleted.set(key,value);return structuredClone(value);
  }
  async containsLinks(owner:string,links:LinkWrite[]):Promise<boolean>{
    this.assertOpen(owner);
    for(const link of links){const values:unknown[]=[],where=this.owned(values);values.push(link.type,link.from.type,link.from.id,link.to.type,link.to.id);
      const n=values.length,rows=await this.sql(`SELECT definition_digest FROM ${this.table('links')} WHERE ${where} AND type=$${n-4} AND from_type=$${n-3} AND from_id=$${n-2} AND to_type=$${n-1} AND to_id=$${n} LIMIT 2`,values);
      if(rows.rowCount===0)return false;await this.linkDefinition(link.type,String(this.one(rows).definition_digest));
    }return true;
  }
  async relationshipDigest(owner:string,ref:ObjectRef,budget:ReadBudget):Promise<string>{
    this.assertOpen(owner);await this.raw(ref,budget);
    const values:unknown[]=[],where=this.owned(values);values.push(ref.type,ref.id);const n=values.length;
    const rows=await this.sql(`SELECT type,to_type,to_id,definition_digest FROM ${this.table('links')} WHERE ${where} AND from_type=$${n-1} AND from_id=$${n}
      AND to_type<>'SourceReceipt' ORDER BY type COLLATE "C",to_type COLLATE "C",to_id COLLATE "C" LIMIT 201`,values);
    this.charge(budget,rows.rows.length);if(rows.rows.length>200)throw new DomainError('CONFLICT','Relationship evidence exceeds the read bound');
    const links:LinkWrite[]=[];for(const row of rows.rows){await this.linkDefinition(String(row.type),String(row.definition_digest));links.push({type:String(row.type),from:ref,to:{type:String(row.to_type),id:String(row.to_id)}});}
    return linkSnapshotDigest(ref,links);
  }
  private async revision(){const values:unknown[]=[],where=this.owned(values),rows=await this.sql(`SELECT revision FROM ${this.table('revisions')} WHERE ${where}`,values);
    const revision=rows.rowCount?Number(this.one(rows).revision):0;if(!Number.isSafeInteger(revision)||revision<0)throw new DomainError('CONFLICT','Invalid dataset revision');return revision;}
  async query(owner:string,input:ObjectQuery,budget:ReadBudget={remaining:1000},readScope?:string):Promise<OntologyQueryResult>{
    this.assertOpen(owner);const args=objectQuerySchema.parse(structuredClone(input));
    if('type' in args&&isVirtualRef({type:args.type}))throw new DomainError('FORBIDDEN','Network facts require their authorized read view');
    if('as' in args&&args.as){const ref='object' in args?args.object:args.from;if(!this.model.isInterface(args.as)||!this.model.implements(ref.type,args.as))fail('Object does not implement the requested interface');}
    const revision=await this.revision(),query=digest({...args,cursor:undefined,...(readScope?{readScope}:{})});let last:ObjectRef|undefined;
    if(args.cursor){let cursor:z.infer<typeof ontologyCursorSchema>;try{cursor=ontologyCursorSchema.parse(JSON.parse(Buffer.from(args.cursor,'base64url').toString()));}catch{return fail('Invalid ontology cursor');}
      if(cursor.owner!==digest(this.owner)||(cursor.ontologyId??'eigos.business')!==this.ontologyId||cursor.query!==query||cursor.model!==this.model.ref.digest||cursor.revision!==revision)throw new DomainError('CONFLICT','Query context changed; restart the bounded query');last=cursor.last;}
    let target:string,historical=false;const values:unknown[]=[],where:string[]=[];let from:string;
    if('object' in args){await this.raw(args.object,budget);target=args.as??args.object.type;from=this.table('objects')+' o';where.push(this.owned(values,'o'));values.push(args.object.type,args.object.id);where.push(`o.type=$${values.length-1}`,`o.id=$${values.length}`);}
    else if('from' in args){await this.raw(args.from,budget);const nav=this.model.navigation(args.from.type,args.link,args.as);
      if(networkLinkIds.has(nav.link.id))throw new DomainError('FORBIDDEN','Network facts require their authorized read view');historical=this.model.linkWritePolicy(nav.link.id)==='source';target=nav.viewType??nav.other.type;
      const side=nav.direction==='forward'?'from':'to',other=side==='from'?'to':'from';where.push(this.owned(values,'l'));values.push(nav.link.id,args.from.type,args.from.id);const n=values.length;
      where.push(`l.type=$${n-2}`,`l.${side}_type=$${n-1}`,`l.${side}_id=$${n}`);
      const definitions=await this.sql(`SELECT DISTINCT l.definition_digest FROM ${this.table('links')} l WHERE ${where.join(' AND ')} LIMIT 201`,values);
      if(definitions.rows.length>200)throw new DomainError('CONFLICT','Relationship definition read bound exceeded');for(const row of definitions.rows)await this.linkDefinition(nav.link.id,String(row.definition_digest));
      from=`${this.table('links')} l JOIN ${this.table('objects')} o ON ${this.scoped?'o.ontology_id=l.ontology_id AND ':''}o.owner=l.owner AND o.type=l.${other}_type AND o.id=l.${other}_id`;
    }else{target=args.type;const types=this.model.concreteTypes(target);from=this.table('objects')+' o';where.push(this.owned(values,'o'));values.push(types);where.push(`o.type=ANY($${values.length}::text[])`);
      if(args.currentDefinitionsOnly){const current=[];for(const type of types){values.push(type,this.model.fingerprint(type));current.push(`(o.type=$${values.length-1} AND o.definition_digest=$${values.length})`);}where.push(current.length?'('+current.join(' OR ')+')':'FALSE');}}
    if(!historical){values.push(this.ontologyId);where.push(`NOT EXISTS(SELECT 1 FROM "${this.schema}".ontology_tombstones deleted WHERE deleted.ontology_id=$${values.length} AND deleted.owner=o.owner AND deleted.type=o.type AND deleted.id=o.id)`);}
    const properties=this.model.properties(target);
    for(const name of args.select??[]){if(!Object.hasOwn(properties,name))fail('Unknown selected property');if(properties[name]!.restricted)throw new DomainError('FORBIDDEN','Restricted property cannot be selected');}
    for(const filter of args.where){const property=properties[filter.property];if(!property||property.derived||['struct','array'].includes(property.kind))fail('Filter requires a registered stored scalar property');
      if(property.restricted)throw new DomainError('FORBIDDEN','Restricted property cannot be filtered');if(!['eq','in'].includes(filter.op)&&!['integer','timestamp','decimal'].includes(property.kind))fail('Unsupported comparison for this property');
      const options=filter.op==='in'?filter.value:[filter.value];if(!Array.isArray(options)||options.some(value=>!property.schema.safeParse(value).success))fail('Filter value does not match property type');}
    if(last){values.push(last.type,last.id);where.push(`(o.type COLLATE "C">$${values.length-1} OR(o.type=$${values.length-1} AND o.id COLLATE "C">$${values.length}))`);}
    const rows=await this.sql(`SELECT o.type,o.id,o.revision,o.definition_digest,CASE WHEN octet_length(o.body)<=1048576 THEN o.body END AS body
      FROM ${from} WHERE ${where.join(' AND ')} ORDER BY o.type COLLATE "C",o.id COLLATE "C" LIMIT 201`,values);
    this.charge(budget,rows.rows.length);const items:ObjectView[]=[];let scanned=0,bytes=0,hasMore=false;
    for(const row of rows.rows){if(scanned===200||items.length===args.limit){hasMore=true;break;}scanned++;
      if(row.body===null)throw new DomainError('CONFLICT','Ontology object exceeds its safe read bound');const ref={type:String(row.type),id:String(row.id)},body=JSON.parse(String(row.body));
      const object={ref,revision:Number(row.revision),properties:body.properties,source:body.source,createdAt:body.createdAt} as ObjectView;
      if(!Number.isSafeInteger(object.revision)||object.revision<1||!object.properties||object.properties[this.model.object(ref.type).primaryKey]!==ref.id)throw new DomainError('CONFLICT','Invalid ontology object body');
      await this.objectDefinition(ref.type,String(row.definition_digest),object.properties);
      if(historical){const deleted=await this.tombstone(owner,ref);if(deleted)object.tombstone={revision:deleted.revision,deletedAt:deleted.deletedAt};}
      const matches=args.where.every(filter=>{const value=object.properties[this.model.propertyName(ref.type,target,filter.property)];if(value===undefined)return false;
        const kind=properties[filter.property]!.kind,normalize=(v:unknown)=>kind==='timestamp'?Date.parse(String(v)):kind==='decimal'?BigInt(String(v).replace('.','').padEnd(String(v).split('.')[0]!.length+6,'0')):v;
        const a=normalize(value) as string|number|bigint|boolean;if(filter.op==='in')return(filter.value as unknown[]).some(value=>a===normalize(value));const b=normalize(filter.value) as typeof a;
        return filter.op==='eq'?a===b:filter.op==='lt'?a<b:filter.op==='lte'?a<=b:filter.op==='gt'?a>b:a>=b;});
      if(matches){const view=this.project(object,target,args.select),size=Buffer.byteLength(JSON.stringify(view));if(bytes+size>60000){if(!items.length)fail('Object projection exceeds response limit');hasMore=true;break;}items.push(view);bytes+=size;}
      last=ref;
    }
    const cursor=hasMore&&last?Buffer.from(JSON.stringify({owner:digest(this.owner),ontologyId:this.ontologyId,query,model:this.model.ref.digest,revision,last})).toString('base64url'):undefined;
    if(await this.revision()!==revision)throw new DomainError('CONFLICT','Objects changed during query; retry against the current revision');
    return {model:this.model.ref,items,page:{limit:args.limit,scanned,hasMore,cursor},datasetRevision:revision,...('type'in args&&args.currentDefinitionsOnly?{definitionScope:'current_definitions_only' as const}:{})};
  }
  async related(owner:string,from:ObjectRef,link:string,budget:ReadBudget):Promise<ObjectView[]>{const result=await this.query(owner,{from,link,limit:50},budget);if(result.page.hasMore)throw new IncompleteRelationshipRead();return result.items;}
  private async persistObject(ref:ObjectRef,revision:number,definitionDigest:string,body:string,old?:RawObject){
    const versions=[...(old?[{revision:old.view.revision,definition_digest:old.definitionDigest,release_id:null,release_digest:null,body:old.body}]:[]),
      {revision,definition_digest:definitionDigest,release_id:this.releaseRef.releaseId,release_digest:this.releaseRef.digest,body}];
    const columns=(this.scoped?'ontology_id,':'')+'owner,type,id,revision,definition_digest,body',conflict=(this.scoped?'ontology_id,':'')+'owner,type,id';
    const row=this.one(await this.sql(`WITH expected AS(
        SELECT $1::text AS ontology_id,$2::text AS owner,$3::text AS type,$4::text AS id,v.*,
          "${this.schema}".eigos_try_jsonb(v.body) IS NOT NULL AS compatible
        FROM jsonb_to_recordset($9::jsonb) AS v(revision bigint,definition_digest text,release_id text,release_digest text,body text)),
      remembered AS(INSERT INTO "${this.schema}".ontology_object_versions(ontology_id,owner,type,id,revision,definition_digest,release_id,release_digest,body,deleted)
        SELECT ontology_id,owner,type,id,revision,definition_digest,release_id,release_digest,body,0 FROM expected WHERE compatible ORDER BY revision
        ON CONFLICT(ontology_id,owner,type,id,revision) DO NOTHING RETURNING revision),
      written AS(INSERT INTO ${this.table('objects')} AS dataset_row(${columns}) SELECT ${this.scoped?'$1,':''}$2,$3,$4,$5,$6,$7 WHERE(SELECT bool_and(compatible) FROM expected)
        ON CONFLICT(${conflict}) DO UPDATE SET revision=excluded.revision,definition_digest=excluded.definition_digest,body=excluded.body
        WHERE dataset_row.revision=$8 AND dataset_row.definition_digest=$10 AND dataset_row.body=$11
        RETURNING revision,body=$7 AND definition_digest=$6 AS matches)
      SELECT(SELECT bool_and(compatible) FROM expected) AS body_valid,
        (SELECT count(*) FROM written)=1 AS wrote,(SELECT min(revision) FROM written) AS revision,
        COALESCE((SELECT bool_and(matches) FROM written),false) AS matches,
        NOT EXISTS(SELECT 1 FROM expected e WHERE NOT EXISTS(SELECT 1 FROM remembered r WHERE r.revision=e.revision)
          AND NOT EXISTS(SELECT 1 FROM "${this.schema}".ontology_object_versions v WHERE v.ontology_id=e.ontology_id AND v.owner=e.owner
            AND v.type=e.type AND v.id=e.id AND v.revision=e.revision AND v.definition_digest=e.definition_digest AND v.body=e.body AND v.deleted=0)) AS versions_valid`,
      [this.ontologyId,this.owner,ref.type,ref.id,revision,definitionDigest,body,old?.view.revision??0,JSON.stringify(versions),old?.definitionDigest??null,old?.body??null]));
    if(row.body_valid!==true)fail('Ontology object JSON is not representable in PostgreSQL storage');
    if(row.versions_valid!==true)throw new DomainError('CONFLICT','An immutable object writer version already differs');
    if(row.wrote!==true||row.matches!==true||Number(row.revision)!==revision)throw new DomainError('CONFLICT','Object revision changed; explicit current revision required');
  }
  private async optionalRaw(ref:ObjectRef):Promise<RawObject|undefined>{
    try{return await this.raw(ref,{remaining:1},true);}
    catch(error){if(error instanceof DomainError&&error.code==='NOT_FOUND')return undefined;throw error;}
  }
  private async bump(){
    const values:unknown[]=this.scoped?[this.ontologyId,this.owner]:[this.owner],columns=this.scoped?'ontology_id,owner':'owner';
    const result=await this.sql(`INSERT INTO ${this.table('revisions')} AS dataset_row(${columns},revision) VALUES(${values.map((_,i)=>'$'+(i+1)).join(',')},1)
      ON CONFLICT(${columns}) DO UPDATE SET revision=dataset_row.revision+1 RETURNING revision`,values);
    if(!Number.isSafeInteger(Number(this.one(result).revision)))throw new DomainError('CONFLICT','Dataset revision exceeds its supported range');
  }
  /** One round trip for the same per-side cardinality checks. PostgreSQL
   * evaluates every touched endpoint; only a violation or tombstone returns. */
  private async cardinality(refs:ObjectRef[]):Promise<Set<string>>{
    if(!refs.length)return new Set();
    const checks=refs.flatMap(ref=>this.model.sides(ref.type).filter(({side})=>!side.many||side.required)
      .map(({link,side,direction})=>({type:ref.type,id:ref.id,link:link.id,outgoing:direction==='forward',many:!!side.many,required:!!side.required})))
      .map((check,sequence)=>({...check,sequence}));
    const encoded=JSON.stringify(checks);if(Buffer.byteLength(encoded)>8388608)throw new DomainError('CONFLICT','Relationship checks exceed their bounded batch size');
    const rows=await this.sql(`WITH touched AS(SELECT * FROM jsonb_to_recordset($3::jsonb) AS r(type text,id text)),
      deleted AS(SELECT t.type,t.id FROM "${this.schema}".ontology_tombstones t JOIN touched r ON r.type=t.type AND r.id=t.id WHERE t.owner=$1 AND t.ontology_id=$2),
      checks AS(SELECT * FROM jsonb_to_recordset($4::jsonb) AS c(type text,id text,link text,outgoing boolean,many boolean,required boolean,sequence integer)),
      violation AS(SELECT c.type,c.id FROM checks c LEFT JOIN ${this.table('links')} l ON l.owner=$1 ${this.scoped?'AND l.ontology_id=$2':''}
        AND l.type=c.link AND((c.outgoing AND l.from_type=c.type AND l.from_id=c.id) OR(NOT c.outgoing AND l.to_type=c.type AND l.to_id=c.id))
        WHERE NOT EXISTS(SELECT 1 FROM deleted d WHERE d.type=c.type AND d.id=c.id)
        GROUP BY c.sequence,c.type,c.id,c.many,c.required HAVING(NOT c.many AND count(l.type)>1) OR(c.required AND count(l.type)=0) LIMIT 1)
      SELECT 'deleted' AS kind,type,id FROM deleted UNION ALL SELECT 'violation' AS kind,type,id FROM violation`,[this.owner,this.ontologyId,JSON.stringify(refs),encoded]);
    if(rows.rows.some(row=>row.kind==='violation'))fail('Relationship cardinality violation');
    if(rows.rows.some(row=>row.kind!=='deleted'||typeof row.type!=='string'||typeof row.id!=='string'))throw new DomainError('CONFLICT','Invalid relationship check result');
    return new Set(rows.rows.map(row=>JSON.stringify([row.type,row.id])));
  }
  async ingest(owner:string,input:ObjectBatch,provenance:ObjectSource):Promise<void>{
    this.assertOpen(owner);
    if(Buffer.byteLength(JSON.stringify(input))>1000000)fail('Ontology import byte limit exceeded');
    const batch=ontologyBatchSchema.parse(structuredClone(input)),source=ontologySourceSchema.parse(structuredClone(provenance));
    if(batch.objects.some(object=>isVirtualRef(object.ref))||[...batch.links,...batch.removeLinks].some(link=>isVirtualRef(link.from)||isVirtualRef(link.to)||networkLinkIds.has(link.type)))throw new DomainError('FORBIDDEN','Network facts must remain in the authorized network read view');
    const key=(ref:ObjectRef)=>JSON.stringify([ref.type,ref.id]);
    if(new Set(batch.objects.map(object=>key(object.ref))).size!==batch.objects.length)fail('Duplicate object in import');
    const touched=new Map<string,ObjectRef>(),inserted=new Set<string>();let changed=false;
    await this.sql('SAVEPOINT eigos_projection_import');
    try {
      for(const object of batch.objects){
        await runGraphProgramAsync(this,assertIdentityAssertionWriteProgram(this,owner,object,source));
        await runGraphProgramAsync(this,assertTransactionPartyRoleWriteProgram(this,owner,object,source));
        const definition=this.model.object(object.ref.type),properties=this.model.parseProperties(object.ref.type,object.properties);
        if(object.observedFields&&(!['provider','synthetic'].includes(source.kind)||object.observedFields.some(field=>!Object.hasOwn(properties,field))
          ||![definition.primaryKey,definition.titleKey].every(field=>object.observedFields!.includes(field))))fail('A source observation must cover the exact identity and title fields');
        if(properties[definition.primaryKey]!==object.ref.id)fail('Primary key does not match object identity');
        if(object.ref.type==='SourceReceipt'&&source.kind==='synthetic'&&properties.evidenceLevel!=='synthetic')fail('Synthetic evidence cannot be promoted');
        if(object.ref.type==='SourceReceipt'&&(source.kind==='task'||source.kind==='user'&&properties.evidenceLevel!=='user_asserted'))fail('User statements cannot become provider evidence');
        if(await this.tombstone(owner,object.ref))throw new DomainError('CONFLICT','Tombstoned object identities cannot be reused');
        const old=await this.optionalRaw(object.ref),createdAt=old?old.view.createdAt:new Date(this.now()).toISOString();
        const body=JSON.stringify({properties,source,createdAt});if(Buffer.byteLength(body)>48000)fail('Ontology object byte limit exceeded');
        if(old){
          if(object.reuseIfUnchanged&&old.view.revision!==object.expectedRevision)fail('Entity reuse requires an exact source-authoritative revision');
          if(old.body===body){touched.set(key(object.ref),object.ref);continue;}
          const previous=old.view.properties;
          if(object.reuseIfUnchanged&&digest(previous)===digest(properties)){
            if(!['provider','synthetic'].includes(source.kind)||this.model.objectWritePolicy(object.ref.type)!=='source'||old.view.revision!==object.expectedRevision)fail('Entity reuse requires an exact source-authoritative revision');
            touched.set(key(object.ref),object.ref);continue;
          }
          if(object.ref.type==='OrderLine'&&(previous.sourceAgreement!==undefined||properties.sourceAgreement!==undefined))throw new DomainError('CONFLICT','An existing order line cannot acquire or replace its sealed source agreement');
          if(object.ref.type==='Shipment'&&digest(previous.expectedAllocation??null)!==digest(properties.expectedAllocation??null))throw new DomainError('CONFLICT','An existing shipment cannot acquire or replace its original expected allocation');
          if(old.view.revision!==object.expectedRevision)throw new DomainError('CONFLICT','Object revision changed; explicit current revision required');
        }else if(object.expectedRevision!==undefined)throw new DomainError('CONFLICT','Expected object revision does not exist');
        if(!old)inserted.add(key(object.ref));
        const revision=(old?.view.revision??0)+1;if(!Number.isSafeInteger(revision))throw new DomainError('CONFLICT','Object revision exceeds its supported range');
        await this.persistObject(object.ref,revision,this.model.fingerprint(object.ref.type),body,old);
        this.cacheObject(object.ref,{body,definitionDigest:this.model.fingerprint(object.ref.type),view:{ref:object.ref,revision,properties,source,createdAt}});
        changed=true;touched.set(key(object.ref),object.ref);
      }
      for(const [remove,edges] of [[true,batch.removeLinks],[false,batch.links]] as const)for(const edge of edges){
        if(!inserted.has(key(edge.from))){
          if(edge.from.type==='OrderLine'){
            const from=await this.optionalRaw(edge.from),agreed=from?.view.properties.sourceAgreement!==undefined;
            if(edge.type.startsWith('OrderLineAgreed')||edge.type==='OrderLineAgreementReceipt'||agreed&&['OrderLineVariant','OrderLineOrder'].includes(edge.type)){
              const present=await this.containsLinks(owner,[edge]);if(remove&&present||!remove&&!present)throw new DomainError('CONFLICT','Order agreement relationships are immutable');
            }
          }
          if(edge.from.type==='Shipment'){
            const from=await this.optionalRaw(edge.from),planned=from?.view.properties.expectedAllocation!==undefined;
            if(['ShipmentExpectedOrderLine','ShipmentExpectedSourceQuote'].includes(edge.type)||planned&&edge.type==='ShipmentOrder'){
              const present=await this.containsLinks(owner,[edge]);if(remove&&present||!remove&&!present)throw new DomainError('CONFLICT','Shipment expected-allocation relationships are immutable');
            }
          }
          if(['EntityIdentityAssertion','TransactionPartyRole'].includes(edge.from.type)&&await this.optionalRaw(edge.from)){
            const present=await this.containsLinks(owner,[edge]);if(remove&&present||!remove&&!present)throw new DomainError('CONFLICT','Identity and party-role relationships are immutable; append a successor');
          }
        }
        const definition=this.model.link(edge.type);
        if(!this.model.implements(edge.from.type,definition.from.type)||!this.model.implements(edge.to.type,definition.to.type))fail('Link endpoint type mismatch');
        const historical=source.kind==='task'&&this.model.linkWritePolicy(edge.type)==='source'&&await this.containsLinks(owner,[edge]);
        for(const ref of [edge.from,edge.to]){await this.raw(ref,{remaining:1},historical);touched.set(key(ref),ref);}
        const values:unknown[]=[],where=this.owned(values);values.push(edge.type,edge.from.type,edge.from.id,edge.to.type,edge.to.id);const n=values.length;
        const match=`${where} AND type=$${n-4} AND from_type=$${n-3} AND from_id=$${n-2} AND to_type=$${n-1} AND to_id=$${n}`;
        if(remove){changed=!!(await this.sql(`DELETE FROM ${this.table('links')} WHERE ${match}`,values)).rowCount||changed;}
        else{
          const prior=await this.sql(`SELECT definition_digest FROM ${this.table('links')} WHERE ${match} LIMIT 2`,values);
          if(prior.rowCount)await this.linkDefinition(edge.type,String(this.one(prior).definition_digest));
          const insert:unknown[]=[...(this.scoped?[this.ontologyId]:[]),this.owner,edge.type,edge.from.type,edge.from.id,edge.to.type,edge.to.id,digest(definition)];
          const columns=(this.scoped?'ontology_id,':'')+'owner,type,from_type,from_id,to_type,to_id,definition_digest';
          changed=!!(await this.sql(`INSERT INTO ${this.table('links')}(${columns}) VALUES(${insert.map((_,i)=>'$'+(i+1)).join(',')}) ON CONFLICT DO NOTHING`,insert)).rowCount||changed;
        }
      }
      const inspect=async(value:unknown):Promise<void>=>{
        if(!value||typeof value!=='object')return;const ref=objectRefSchema.safeParse(value);
        if(ref.success){await this.raw(ref.data,{remaining:1});return;}for(const child of Object.values(value))await inspect(child);
      };
      for(const object of batch.objects.filter(object=>object.ref.type==='ServiceRequest'))await inspect(object.properties.conditions);
      const tombstoned=await this.cardinality([...touched.values()]);
      for(const ref of touched.values()){
        if(tombstoned.has(key(ref)))continue;
        if(ref.type==='Proposal'){
          const proposal=(await this.raw(ref,{remaining:1})).view,values:unknown[]=[],where=this.owned(values);values.push(ref.id);
          if(proposal.properties.kind==='goal'){
            const contexts=await this.sql(`SELECT to_id FROM ${this.table('links')} WHERE ${where} AND type='ProposalExecutionContext' AND from_id=$${values.length}`,values);
            if(contexts.rowCount!==1)fail('A whole-goal proposal requires its original execution context');
            const context=(await this.raw({type:'ExecutionContext',id:String(this.one(contexts).to_id)},{remaining:1})).view;
            if(!context.properties.goal||context.properties.requestRevision!==proposal.properties.requestRevision)fail('Whole-goal proposal context does not carry the fixed goal revision');
          }else if(!['execution','read_scope'].includes(String(proposal.properties.kind))){
            const count=this.count(await this.sql(`SELECT count(*) AS n FROM ${this.table('links')} WHERE ${where} AND type='ProposalOffer' AND from_id=$${values.length}`,values));
            if(count!==1)fail('An offer selection requires exactly one selected offer');
          }
        }
        if(ref.type==='Payment'||ref.type==='AfterSalesCase'){
          const relations=ref.type==='Payment'?['PaymentOrder','PaymentReservation']:['CaseOrder','CaseReservation'];
          const values:unknown[]=[],where=this.owned(values);values.push(ref.type,ref.id,relations);const n=values.length;
          const count=this.count(await this.sql(`SELECT count(*) AS n FROM ${this.table('links')} WHERE ${where} AND from_type=$${n-2} AND from_id=$${n-1} AND type=ANY($${n}::text[])`,values));
          if(count!==1)fail('Business record requires exactly one original order or reservation');
        }
      }
      if(changed)await this.bump();
      await this.sql('RELEASE SAVEPOINT eigos_projection_import');
    }catch(error){
      this.objects.clear();this.deleted.clear();this.objectBytes=0;
      try{await this.sql('ROLLBACK TO SAVEPOINT eigos_projection_import');await this.sql('RELEASE SAVEPOINT eigos_projection_import');}
      catch(rollback){throw new Error('Projection rollback failed; discard the transaction',{cause:rollback});}
      throw error;
    }
  }
  async run<T>(program:(metadata:ProjectionMetadata)=>GraphProgram<T>):Promise<T>{this.assertOpen();const result=await runGraphProgramAsync(this,program(this));this.assertOpen();return result;}
}
