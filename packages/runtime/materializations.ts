import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Conflict, NotFound, digest } from '../core/identity.js';
import type { ObjectData, ObjectRef } from '../ontology/schema.js';
import type { Database } from './database.js';
import type { Access } from './access.js';
import type { PublishedOntology } from './metadata.js';
import { Objects } from './objects.js';
import { viewTables } from './scenario-store.js';

export const materializationInputSchema=z.strictObject({requestId:z.string().min(1).max(128),name:z.string().min(1).max(200),types:z.array(z.string().min(1)).min(1).max(100)});
export async function initializeMaterializations(db: Database) {
  await db.query(`CREATE TABLE IF NOT EXISTS ${db.schema}.materializations (
    id uuid PRIMARY KEY, owner text NOT NULL, request_id text NOT NULL, digest text NOT NULL,
    release text NOT NULL REFERENCES ${db.schema}.releases(digest), name text NOT NULL,
    types jsonb NOT NULL, captured_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner,request_id));
    CREATE TABLE IF NOT EXISTS ${db.schema}.materialized_objects (
      materialization_id uuid NOT NULL REFERENCES ${db.schema}.materializations(id),
      type text NOT NULL,id text NOT NULL,revision bigint NOT NULL,properties jsonb NOT NULL,
      PRIMARY KEY(materialization_id,type,id));
    CREATE TABLE IF NOT EXISTS ${db.schema}.materialized_links (
      materialization_id uuid NOT NULL REFERENCES ${db.schema}.materializations(id),
      type text NOT NULL,from_type text NOT NULL,from_id text NOT NULL,to_type text NOT NULL,to_id text NOT NULL,
      PRIMARY KEY(materialization_id,type,from_type,from_id,to_type,to_id));`);
}
const referenceKey=(ref:ObjectRef)=>JSON.stringify([ref.type,ref.id]);
export class Materializations {
  constructor(private readonly db:Database) {}
  async capture(access:Access,model:PublishedOntology,raw:unknown) {
    const input=materializationInputSchema.parse(raw);
    if(model.scenario)throw new Conflict('Materialization requires live resolved objects');
    const types=[...new Set(input.types)].sort(),fingerprint=digest({name:input.name,types,release:model.release});
    types.forEach(type=>{model.object(type);access.read(model,type);});
    return this.db.transaction(async client=>{
      await this.db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',[],client);
      await access.refresh(client);
      const graph=new Objects(this.db,model,access,client),id=randomUUID();
      const inserted=await this.db.query(`INSERT INTO ${this.db.schema}.materializations(id,owner,request_id,digest,release,name,types)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(owner,request_id) DO NOTHING RETURNING id`,[id,access.principal.owner,input.requestId,fingerprint,model.release,input.name,JSON.stringify(types)],client);
      if(!inserted.rowCount){
        const previous=(await this.db.query(`SELECT id,digest FROM ${this.db.schema}.materializations WHERE owner=$1 AND request_id=$2`,[access.principal.owner,input.requestId],client)).rows[0]!;
        if(previous.digest!==fingerprint)throw new Conflict('Materialization request ID has different input');
        return {id:String(previous.id)};
      }
      const included=new Set<string>();
      for(const type of types){
        let cursor:string|undefined;
        do{
          const page=await graph.query({type,limit:100,cursor});
          for(const object of page.items){
            if(included.size>=10000)throw new Conflict('Materialization exceeds 10000 objects; narrow the selected types');
            included.add(referenceKey(object.ref));
          }
          // Retain original policy fields even when hidden. Exports evaluate the complete historical row.
          const args:unknown[]=[id,model.projection,access.principal.owner,JSON.stringify(page.items.map(item=>item.ref))];
          const tables=viewTables(this.db,model,access.principal.owner,args,[type]);
          await this.db.query(`${tables.prefix}INSERT INTO ${this.db.schema}.materialized_objects(materialization_id,type,id,revision,properties)
            SELECT $1,o.type,o.id,o.revision,o.properties FROM ${tables.objects} o
            JOIN jsonb_to_recordset($4::jsonb) AS selected(type text,id text) ON selected.type=o.type AND selected.id=o.id
            WHERE o.projection=$2 AND o.owner=$3`,args,client);
          cursor=page.cursor;
        }while(cursor);
      }
      const args:unknown[]=[model.projection,access.principal.owner,types],tables=viewTables(this.db,model,access.principal.owner,args,types);
      const links=(await this.db.query(`${tables.prefix}SELECT type,from_type,from_id,to_type,to_id FROM ${tables.links} WHERE projection=$1 AND owner=$2 AND from_type=ANY($3::text[]) AND to_type=ANY($3::text[]) LIMIT 100001`,args,client)).rows;
      if(links.length>100000)throw new Conflict('Materialization exceeds 100000 relationships; narrow the selected types');
      const allowedLinks=[];
      for(const link of links){
        if(!included.has(referenceKey({type:link.from_type,id:link.from_id}))||!included.has(referenceKey({type:link.to_type,id:link.to_id})))continue;
        access.definition(model,'link',link.type);
        allowedLinks.push(link);
      }
      for(let start=0;start<allowedLinks.length;start+=1000){
        await this.db.query(`INSERT INTO ${this.db.schema}.materialized_links(materialization_id,type,from_type,from_id,to_type,to_id)
          SELECT $1,type,from_type,from_id,to_type,to_id FROM jsonb_to_recordset($2::jsonb) AS input(type text,from_type text,from_id text,to_type text,to_id text)`,[id,JSON.stringify(allowedLinks.slice(start,start+1000))],client);
      }
      await access.refresh(client);
      return {id};
    });
  }
  async read(access:Access,model:PublishedOntology,id:string,cursor?:string) {
    z.uuid().parse(id);
    await access.refresh();
    const header=(await this.db.query(`SELECT id,release,name,types,captured_at FROM ${this.db.schema}.materializations WHERE id=$1 AND owner=$2`,[id,access.principal.owner])).rows[0];
    if(!header)throw new NotFound('Materialization is unavailable');
    if(header.release!==model.release)throw new Conflict('Materialization belongs to another publication');
    const token=cursor?z.strictObject({id:z.literal(id),type:z.string(),key:z.string()}).parse(JSON.parse(Buffer.from(cursor,'base64url').toString())):undefined;
    const args:unknown[]=[id];
    let clause='';
    if(token){args.push(token.type,token.key);clause=' AND (type COLLATE "C",id COLLATE "C")>($2,$3)';}
    const rows=(await this.db.query(`SELECT type,id,revision,properties FROM ${this.db.schema}.materialized_objects WHERE materialization_id=$1${clause} ORDER BY type COLLATE "C",id COLLATE "C" LIMIT 101`,args)).rows;
    const graph=new Objects(this.db,model,access),items:ObjectData[]=[];
    for(const row of rows.slice(0,100)){
      const ref={type:String(row.type),id:String(row.id)};
      try{await graph.read(ref);}catch(error){if(error instanceof NotFound)continue;throw error;}
      const properties=graph.maskSnapshot(ref,row.properties);
      if(!properties)continue;
      items.push({ref,revision:Number(row.revision),properties});
    }
    await access.refresh();
    const last=rows[Math.min(rows.length,100)-1];
    return {id,name:header.name,release:header.release,capturedAt:header.captured_at,items,cursor:rows.length>100?Buffer.from(JSON.stringify({id,type:last!.type,key:last!.id})).toString('base64url'):undefined};
  }
  async links(access:Access,model:PublishedOntology,id:string,after=0) {
    z.uuid().parse(id);z.number().int().min(0).parse(after);
    await this.read(access,model,id);
    const rows=(await this.db.query(`SELECT l.type,l.from_type,l.from_id,l.to_type,l.to_id,f.properties AS from_properties,t.properties AS to_properties
      FROM ${this.db.schema}.materialized_links l
      JOIN ${this.db.schema}.materialized_objects f ON f.materialization_id=l.materialization_id AND f.type=l.from_type AND f.id=l.from_id
      JOIN ${this.db.schema}.materialized_objects t ON t.materialization_id=l.materialization_id AND t.type=l.to_type AND t.id=l.to_id
      WHERE l.materialization_id=$1 ORDER BY l.type,l.from_type,l.from_id,l.to_type,l.to_id OFFSET $2 LIMIT 101`,[id,after])).rows;
    const graph=new Objects(this.db,model,access),items=[];
    for(const row of rows.slice(0,100)){
      access.definition(model,'link',row.type);
      const from={type:row.from_type as string,id:row.from_id as string},to={type:row.to_type as string,id:row.to_id as string};
      try{await graph.read(from);await graph.read(to);}catch(error){if(error instanceof NotFound)continue;throw error;}
      if(!graph.maskSnapshot(from,row.from_properties)||!graph.maskSnapshot(to,row.to_properties))continue;
      items.push({type:String(row.type),from,to});
    }
    await access.refresh();
    return {items,cursor:rows.length>100?after+100:undefined};
  }
}
