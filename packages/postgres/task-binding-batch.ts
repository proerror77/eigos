import type {Client,QueryResult} from 'pg';
import {SecurityError} from '../security/errors.js';
import {digest} from '../core/delegation.js';
import type {ObjectRef} from '../ontology/model.js';
import type {TaskDataGrant} from '../security/store.js';
import {postgresBusinessToken} from './runtime-transaction.js';

type Rows={rowCount:number|null;rows:Record<string,unknown>[]};
type ReadKind='raw'|'previous'|'links'|'labels';
export const POSTGRES_TASK_BINDING_CHUNK_REFS=32;
const key=(ref:ObjectRef)=>JSON.stringify([ref.type,ref.id]);
export interface PostgresBindingWrite {grant_id:string;owner:string;task_id:string;request_revision:number;type:string;object_id:string;object_revision:number;body:string}
/** Raw rows for one private binding-only chunk. This is neither a permission
 * cache nor a generic transaction cache. The owner closes it before returning
 * to any graph/source writer; source permits and public bind never enter it. */
export class PostgresTaskBindingBatch {
  private readonly token:object;
  private readonly identity:string;
  private open=true;
  private readonly data=new Map<ReadKind,Map<string,Rows|undefined>>();
  private readonly writes:PostgresBindingWrite[]=[];
  private bytes=0;
  constructor(private readonly client:Client,grant:TaskDataGrant,private readonly refs:readonly ObjectRef[]){
    if(refs.length>POSTGRES_TASK_BINDING_CHUNK_REFS||new Set(refs.map(key)).size!==refs.length)throw new Error('Invalid task binding chunk');
    this.token=postgresBusinessToken(client);this.identity=this.grantKey(grant);
  }
  private grantKey(grant:TaskDataGrant){return digest([grant.ownerKey,grant.id,grant.revision,grant.taskId,grant.requestRevision]);}
  private active(grant:TaskDataGrant){if(!this.open||postgresBusinessToken(this.client)!==this.token||this.grantKey(grant)!==this.identity)throw new SecurityError('AUTHORIZATION_REQUIRED');}
  close(){this.open=false;this.data.clear();this.writes.length=0;this.bytes=0;}
  get(kind:ReadKind,grant:TaskDataGrant,ref:ObjectRef):Rows|undefined{
    this.active(grant);const rows=this.data.get(kind),name=key(ref);if(!rows?.has(name))throw new SecurityError('POLICY_CHANGED');
    const value=rows.get(name);return value===undefined?undefined:structuredClone(value);
  }
  add(grant:TaskDataGrant,write:PostgresBindingWrite){this.active(grant);this.writes.push(write);this.bytes+=Buffer.byteLength(write.body)+1024;return this.bytes>=8388608;}
  take(grant:TaskDataGrant){this.active(grant);const rows=this.writes.splice(0);this.bytes=0;return rows;}
  /** Queries return bounded data and overflow markers. Semantic validation and
   * failures still occur in the original per-reference order in the writer. */
  async load(grant:TaskDataGrant,schema:string,query:(text:string,values:unknown[])=>Promise<QueryResult>,context=true){
    this.active(grant);if(!/^eigos_business_[a-z0-9_]{1,40}$/.test(schema))throw new Error('Invalid task binding schema');const q=`"${schema}"`,requested=JSON.stringify(this.refs.map((ref,n)=>({n,...ref}))),args=[requested,grant.ownerKey,grant.id,grant.taskId,grant.requestRevision,grant.installationId];
    const run=async(kind:ReadKind,sql:string,decode:(row:Record<string,unknown>)=>Rows|undefined)=>{
      const result=await query(sql,args);this.active(grant);
      if(result.rowCount!==this.refs.length)throw new SecurityError('POLICY_CHANGED');const map=new Map<string,Rows|undefined>();
      for(const [index,row]of result.rows.entries()){
        if(row.n!==index)throw new SecurityError('POLICY_CHANGED');map.set(key(this.refs[index]!),decode(row));
      }this.data.set(kind,map);
    };
    const input=`WITH scope AS(SELECT $2::text AS owner,$3::text AS grant_id,$4::text AS task_id,$5::bigint AS request_revision,$6::text AS installation_id),requested AS(SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(n integer,type text,id text))`;
    await run('raw',`${input}, selected AS(SELECT r.n,o.id IS NOT NULL AS found,o.revision,o.definition_digest,o.body,octet_length(o.body) AS bytes
      FROM requested r LEFT JOIN ${q}.ontology_objects o ON o.owner=$2 AND o.type=r.type AND o.id=r.id)
      SELECT n,found,revision,definition_digest,bytes,coalesce(sum(bytes) OVER(),0)>8388608 AS overflow,
        CASE WHEN bytes<=1048576 AND coalesce(sum(bytes) OVER(),0)<=8388608 THEN body END AS body FROM selected ORDER BY n`,row=>{
        if(row.found===false)return {rowCount:0,rows:[]};if(row.overflow===true&&Number(row.bytes)<=1048576)return undefined;
        return {rowCount:1,rows:[{revision:row.revision,definition_digest:row.definition_digest,body:row.body}]};
      });
    if(context)await run('previous',`${input}, selected AS(SELECT r.n,d.grant_id IS NOT NULL AS direct,b.grant_id IS NOT NULL AS retained,
        CASE WHEN d.grant_id IS NOT NULL THEN d.body ELSE b.body END AS body
      FROM requested r LEFT JOIN ${q}.security_bindings d ON d.grant_id=$3 AND d.owner=$2 AND d.task_id=$4 AND d.request_revision=$5 AND d.type=r.type AND d.object_id=r.id
      LEFT JOIN LATERAL(SELECT old.grant_id,old.body FROM ${q}.security_bindings old JOIN ${q}.security_grants issued ON issued.id=old.grant_id
        WHERE d.grant_id IS NULL AND old.owner=$2 AND old.task_id=$4 AND old.request_revision=$5 AND issued.installation_id=$6 AND issued.kind='task_data'
          AND old.type=r.type AND old.object_id=r.id ORDER BY issued.__eigos_rowid DESC LIMIT 1) b ON true)
      SELECT n,direct,retained,octet_length(body) AS bytes,coalesce(sum(octet_length(body)) OVER(),0)>8388608 AS overflow,
        CASE WHEN octet_length(body)<=1048576 AND coalesce(sum(octet_length(body)) OVER(),0)<=8388608 THEN body END AS body FROM selected ORDER BY n`,row=>{
        if(row.direct===false&&row.retained===false)return {rowCount:0,rows:[]};if(row.overflow===true&&Number(row.bytes)<=1048576)return undefined;
        return {rowCount:1,rows:[{body:row.body}]};
      });
    const grouped=async(kind:'links'|'labels',rowsSql:string,bytesSql:string,payloadSql:string)=>run(kind,`${input}, selected AS(
      SELECT r.n,data.oversized,data.payload::text AS payload FROM requested r LEFT JOIN LATERAL(
        SELECT stats.bytes>1048576 AS oversized,CASE WHEN stats.bytes<=1048576 THEN(
          SELECT ${payloadSql} FROM(${rowsSql}) items) END AS payload
        FROM(SELECT coalesce(sum(${bytesSql}),0) AS bytes FROM(${rowsSql}) items) stats
      ) data ON true)
      SELECT n,oversized OR coalesce(sum(octet_length(payload)) OVER(),0)>8388608 AS overflow,
        CASE WHEN coalesce(sum(octet_length(payload)) OVER(),0)<=8388608 THEN payload END AS payload FROM selected ORDER BY n`,row=>{
        if(row.overflow===true)return undefined;
        if(typeof row.payload!=='string')throw new SecurityError('POLICY_CHANGED');const value:unknown=JSON.parse(row.payload);
        if(!Array.isArray(value)||value.some(item=>!item||typeof item!=='object'||Array.isArray(item)))throw new SecurityError('POLICY_CHANGED');
        return {rowCount:value.length,rows:value};
      });
    // Bound server-side JSON aggregation too. Large-but-valid individual rows
    // fall back to the original single-reference reader; no value becomes [].
    if(context)await grouped('links',`SELECT type,to_type,to_id,definition_digest FROM ${q}.ontology_links WHERE owner=$2 AND from_type=r.type AND from_id=r.id
        AND(type<>'CapabilityRequest' OR(to_type='ServiceRequest' AND to_id=$4)) ORDER BY type COLLATE "C",to_type COLLATE "C",to_id COLLATE "C" LIMIT 4001`,
      `octet_length(type)+octet_length(to_type)+octet_length(to_id)+octet_length(definition_digest)+64`,
      `coalesce(jsonb_agg(to_jsonb(items) ORDER BY items.type COLLATE "C",items.to_type COLLATE "C",items.to_id COLLATE "C"),'[]'::jsonb)`);
    await grouped('labels',`SELECT field,body FROM ${q}.security_labels WHERE owner=$2 AND type=r.type AND object_id=r.id ORDER BY field COLLATE "C" LIMIT 257`,
      `octet_length(field)+CASE WHEN octet_length(body)<=65536 THEN octet_length(body) ELSE 0 END+64`,
      `coalesce(jsonb_agg(jsonb_build_object('field',items.field,'body',CASE WHEN octet_length(items.body)<=65536 THEN items.body END) ORDER BY items.field COLLATE "C"),'[]'::jsonb)`);
  }
}
