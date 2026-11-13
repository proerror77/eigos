import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Conflict, NotFound, digest } from '../core/identity.js';
import { objectRefSchema, ontologyName, type ObjectRef } from '../ontology/schema.js';
import { Access, type Permission } from './access.js';
import type { Database, Sql } from './database.js';
import { Metadata, type PublishedOntology } from './metadata.js';
import { Objects } from './objects.js';

export const migrateOntologyDataSchema = z.strictObject({
  sourceOntology: ontologyName, targetOntology: ontologyName, requestId: z.string().min(1).max(128),
  types: z.record(ontologyName, ontologyName), links: z.record(ontologyName, ontologyName).default({}),
  objects: z.array(objectRefSchema).min(1).max(10000).optional(),
});
export const readDataMigrationSchema = z.strictObject({ id:z.uuid(), kind:z.enum(['objects','links']).default('objects'), after:z.number().int().min(0).default(0), limit:z.number().int().min(1).max(100).default(50) });
export async function initializeOntologyDataMigrations(db: Database) {
  await db.query(`CREATE TABLE IF NOT EXISTS ${db.schema}.ontology_data_migrations (
    id uuid PRIMARY KEY, owner text NOT NULL, request_id text NOT NULL, input_digest text NOT NULL, input jsonb NOT NULL,
    source_ontology text NOT NULL, target_ontology text NOT NULL, source_release text NOT NULL REFERENCES ${db.schema}.releases(digest),
    target_release text NOT NULL REFERENCES ${db.schema}.releases(digest), object_count integer NOT NULL, link_count integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner,request_id));
    CREATE TABLE IF NOT EXISTS ${db.schema}.ontology_migration_objects (
      migration_id uuid NOT NULL REFERENCES ${db.schema}.ontology_data_migrations(id), ordinal integer NOT NULL,
      source_type text NOT NULL, source_id text NOT NULL, source_revision bigint NOT NULL, source_digest text NOT NULL,
      target_type text NOT NULL, target_id text NOT NULL, target_digest text NOT NULL,
      PRIMARY KEY(migration_id,ordinal), UNIQUE(migration_id,source_type,source_id));
    CREATE TABLE IF NOT EXISTS ${db.schema}.ontology_migration_links (
      migration_id uuid NOT NULL REFERENCES ${db.schema}.ontology_data_migrations(id), ordinal integer NOT NULL,
      source_link jsonb NOT NULL, target_link jsonb NOT NULL, PRIMARY KEY(migration_id,ordinal));`);
}

type Input = z.output<typeof migrateOntologyDataSchema>;
type SourceRow = { type:string; id:string; revision:string; properties:Record<string,unknown> };
const key = (ref:ObjectRef) => JSON.stringify([ref.type,ref.id]);
const reserved = (model:PublishedOntology,type:string) => type==='OntologyScenario' || model.object(type).typeClasses?.some(item=>item.kind==='ontology'&&item.name==='scenario');
function authorize(access:Access,source:PublishedOntology,target:PublishedOntology,input:Input) {
  access.require(source.document.id,'view_definition',source.document.id);
  access.require(target.document.id,'view_definition',target.document.id);
  for(const [from,to] of Object.entries(input.types)) {
    source.object(from);target.object(to);
    if(reserved(source,from)||reserved(target,to))throw new Conflict('Scenario lifecycle objects cannot be copied between Ontologies');
    access.read(source,from);access.read(target,to);
    access.require(target.document.id,'migrate_objects' as Permission,`${target.document.id}/object/${to}`);
  }
  for(const [from,to] of Object.entries(input.links)) {
    const old=source.links.get(from),next=target.links.get(to);
    if(!old||!next||input.types[old.from.type]!==next.from.type||input.types[old.to.type]!==next.to.type)throw new Conflict('Link mappings require compatible explicitly mapped endpoint types');
    access.definition(source,'link',from);access.definition(target,'link',to);
  }
}
const summary = (row:Record<string,any>) => ({id:String(row.id),requestId:String(row.request_id),sourceOntology:String(row.source_ontology),targetOntology:String(row.target_ontology),sourceRelease:String(row.source_release),targetRelease:String(row.target_release),objects:Number(row.object_count),links:Number(row.link_count),createdAt:row.created_at,provenance:'copied_ontology_objects' as const});

export class OntologyDataMigrations {
  constructor(private readonly db:Database,private readonly metadata:Metadata){}
  async copy(access:Access,raw:unknown) {
    const input=migrateOntologyDataSchema.parse(raw);
    if(input.sourceOntology===input.targetOntology)throw new Conflict('Data migration requires two distinct Ontologies');
    const types=Object.keys(input.types);if(!types.length)throw new Conflict('Data migration requires an explicit type mapping');
    if(input.objects?.some(ref=>!input.types[ref.type]))throw new Conflict('Every selected object requires a type mapping');
    if(input.objects&&new Set(input.objects.map(key)).size!==input.objects.length)throw new Conflict('Selected objects must be unique');
    if(input.objects)input.objects.sort((a,b)=>key(a).localeCompare(key(b),'en'));
    const fingerprint=digest(input);
    return this.db.transaction(async client=>{
      // Source reads and target writes share deterministic publication and owner locks.
      const models=new Map<string,PublishedOntology>();
      for(const name of [input.sourceOntology,input.targetOntology].sort())models.set(name,await this.metadata.active(name,client,true));
      const source=models.get(input.sourceOntology)!,target=models.get(input.targetOntology)!;
      authorize(access,source,target,input);
      const graphs=new Map([...models].map(([name,model])=>[name,new Objects(this.db,model,access,client)]));
      for(const graph of graphs.values())await graph.lockWrites();
      await this.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['data-migration',access.principal.owner,input.requestId])],client);
      const previous=(await this.db.query(`SELECT * FROM ${this.db.schema}.ontology_data_migrations WHERE owner=$1 AND request_id=$2`,[access.principal.owner,input.requestId],client)).rows[0];
      if(previous) {
        if(previous.input_digest!==fingerprint)throw new Conflict('Migration request ID already contains different input');
        await this.authorizeReceipt(access,source,target,previous.id,client);
        await access.refresh(client);
        if(!await access.canReturn(access.dataRequirements(),client))throw new Error('Migration permissions changed');
        return summary(previous);
      }
      const rows=(await this.db.query<SourceRow>(`SELECT type,id,revision::text,properties FROM ${this.db.schema}.objects object
        WHERE projection=$1 AND owner=$2 AND type=ANY($3::text[])
        AND ($4::jsonb IS NULL OR EXISTS(SELECT 1 FROM jsonb_to_recordset($4::jsonb) AS selection(type text,id text) WHERE selection.type=object.type AND selection.id=object.id))
        ORDER BY type,id LIMIT 10001`,[source.projection,access.principal.owner,types,input.objects?JSON.stringify(input.objects):null],client)).rows;
      if(rows.length>10000)throw new Conflict('Data migration exceeds 10000 objects');
      if(input.objects&&rows.length!==input.objects.length)throw new NotFound('A selected source object is unavailable');
      const sourceRefs=new Set(rows.map(row=>key(row))),targetRefs=new Set<string>();
      const prepared=rows.map(row=>{
        const sourceDefinition=source.object(row.type),targetType=input.types[row.type]!,targetDefinition=target.object(targetType);
        access.readRow(source,row.type,row.properties);
        for(const field of Object.keys(row.properties))if(!sourceDefinition.properties[field]?.derived&&!access.cell(source,row.type,field,row.properties))throw new Conflict('Data migration cannot copy hidden source fields');
        const ref={type:targetType,id:row.id};
        if(targetRefs.has(key(ref)))throw new Conflict('Several source objects map to one target identity');
        targetRefs.add(key(ref));
        const properties=Object.fromEntries(Object.entries(row.properties).filter(([name])=>!sourceDefinition.properties[name]?.derived&&!targetDefinition.properties[name]?.derived));
        if(sourceDefinition.primaryKey!==targetDefinition.primaryKey&&!targetDefinition.properties[sourceDefinition.primaryKey])delete properties[sourceDefinition.primaryKey];
        properties[targetDefinition.primaryKey]=row.id;
        return {source:row,ref,properties:target.parseObject(ref,properties)};
      });
      if(prepared.length) {
        const collisions=await this.db.query(`SELECT 1 FROM ${this.db.schema}.objects object JOIN jsonb_to_recordset($3::jsonb) AS target(type text,id text)
          ON target.type=object.type AND target.id=object.id WHERE object.projection=$1 AND object.owner=$2 LIMIT 1`,[target.projection,access.principal.owner,JSON.stringify(prepared.map(item=>item.ref))],client);
        if(collisions.rowCount)throw new Conflict('A target object identity already exists');
      }
      const sourceLinks=(await this.db.query(`WITH selected AS(SELECT * FROM jsonb_to_recordset($4::jsonb) AS item(type text,id text))
        SELECT type,from_type,from_id,to_type,to_id FROM ${this.db.schema}.links link WHERE projection=$1 AND owner=$2 AND type=ANY($3::text[])
        AND EXISTS(SELECT 1 FROM selected WHERE (selected.type=link.from_type AND selected.id=link.from_id) OR (selected.type=link.to_type AND selected.id=link.to_id))
        ORDER BY type,from_type,from_id,to_type,to_id LIMIT 100001`,[source.projection,access.principal.owner,Object.keys(input.links),JSON.stringify(rows.map(row=>({type:row.type,id:row.id})))],client)).rows;
      if(sourceLinks.length>100000)throw new Conflict('Data migration exceeds 100000 relationships');
      const edges=sourceLinks.map(row=>{
        const from={type:String(row.from_type),id:String(row.from_id)},to={type:String(row.to_type),id:String(row.to_id)};
        if(!sourceRefs.has(key(from))||!sourceRefs.has(key(to)))throw new Conflict('Include both endpoints of every selected relationship');
        return {original:{type:String(row.type),from,to},target:{type:input.links[row.type]!,from:{...from,type:input.types[from.type]!},to:{...to,type:input.types[to.type]!}}};
      });
      const destination=graphs.get(input.targetOntology)!;
      for(const item of prepared) {
        // Each copied object depends on its own source values. Preserve that object's markings
        // without combining unrelated classifications from other rows in the same atomic batch.
        const objectAccess=await Access.load(this.db,access.principal,client);
        objectAccess.readRow(source,item.source.type,item.source.properties);
        await new Objects(this.db,target,objectAccess,client).create(item.ref,item.properties);
        if(!await objectAccess.canReturn(objectAccess.dataRequirements(),client))throw new Error('Copied object permissions changed');
      }
      await destination.linkBatch(edges.map(edge=>edge.target));
      const id=randomUUID();
      const receipt=(await this.db.query(`INSERT INTO ${this.db.schema}.ontology_data_migrations(id,owner,request_id,input_digest,input,source_ontology,target_ontology,source_release,target_release,object_count,link_count)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[id,access.principal.owner,input.requestId,fingerprint,input,source.document.id,target.document.id,source.release,target.release,prepared.length,edges.length],client)).rows[0]!;
      for(let ordinal=0;ordinal<prepared.length;ordinal++) {
        const item=prepared[ordinal]!;
        await this.db.query(`INSERT INTO ${this.db.schema}.ontology_migration_objects(migration_id,ordinal,source_type,source_id,source_revision,source_digest,target_type,target_id,target_digest)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,ordinal,item.source.type,item.source.id,item.source.revision,digest(item.source.properties),item.ref.type,item.ref.id,digest(item.properties)],client);
      }
      for(let ordinal=0;ordinal<edges.length;ordinal++)await this.db.query(`INSERT INTO ${this.db.schema}.ontology_migration_links(migration_id,ordinal,source_link,target_link) VALUES($1,$2,$3,$4)`,[id,ordinal,edges[ordinal]!.original,edges[ordinal]!.target],client);
      await access.refresh(client);
      if(!await access.canReturn(access.dataRequirements(),client))throw new Error('Migration permissions changed');
      return summary(receipt);
    });
  }
  private async authorizeReceipt(access:Access,source:PublishedOntology,target:PublishedOntology,id:string,client:Sql) {
    const objects=(await this.db.query(`SELECT source_type,source_id,target_type,target_id FROM ${this.db.schema}.ontology_migration_objects WHERE migration_id=$1`,[id],client)).rows;
    for(const row of objects) {
      access.require(target.document.id,'migrate_objects' as Permission,`${target.document.id}/object/${row.target_type}`);
      for(const [model,type,id] of [[source,row.source_type,row.source_id],[target,row.target_type,row.target_id]] as const) {
        const current=(await this.db.query(`SELECT properties FROM ${this.db.schema}.objects WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4`,[model.projection,access.principal.owner,type,id],client)).rows[0];
        if(!current)throw new NotFound('A migration object is currently unavailable');
        access.readRow(model,type,current.properties);
        for(const field of Object.keys(current.properties))if(!model.object(type).properties[field]?.derived&&!access.cell(model,type,field,current.properties))throw new Conflict('Migration provenance contains currently hidden fields');
      }
    }
  }

  async read(access:Access,raw:unknown) {
    const input=readDataMigrationSchema.parse(raw);
    return this.db.transaction(async client=>{
      const row=(await this.db.query(`SELECT * FROM ${this.db.schema}.ontology_data_migrations WHERE id=$1 AND owner=$2`,[input.id,access.principal.owner],client)).rows[0];
      if(!row)throw new NotFound('Data migration is unavailable');
      const models=new Map<string,PublishedOntology>();
      for(const name of [row.source_ontology,row.target_ontology].sort())models.set(name,await this.metadata.active(name,client,true));
      const source=models.get(row.source_ontology)!,target=models.get(row.target_ontology)!;
      authorize(access,source,target,migrateOntologyDataSchema.parse(row.input));
      await this.authorizeReceipt(access,source,target,input.id,client);
      const columns=input.kind==='objects'?'ordinal,source_type,source_id,source_revision::text,source_digest,target_type,target_id,target_digest':'ordinal,source_link,target_link';
      const table=input.kind==='objects'?'ontology_migration_objects':'ontology_migration_links';
      const objects=(await this.db.query(`SELECT ${columns} FROM ${this.db.schema}.${table} WHERE migration_id=$1 AND ordinal>=$2 ORDER BY ordinal LIMIT $3`,[input.id,input.after,input.limit+1],client)).rows;
      const items=objects.slice(0,input.limit);
      await access.refresh(client);
      if(!await access.canReturn(access.dataRequirements(),client))throw new Error('Migration receipt permissions changed');
      return {...summary(row),items,cursor:objects.length>input.limit?Number(items.at(-1)!.ordinal)+1:undefined};
    });
  }
}
