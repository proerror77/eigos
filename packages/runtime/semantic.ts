import { z } from 'zod';
import { Conflict, digest, NotFound } from '../core/identity.js';
import { objectRefSchema, type ObjectData } from '../ontology/schema.js';
import { Access } from './access.js';
import type { Database } from './database.js';
import type { PublishedOntology } from './metadata.js';
import { Functions } from './functions.js';
import { Objects } from './objects.js';
import { nestedValue, propertyPathSchema } from './query-filter.js';

const indexName=z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/).max(80);
export const semanticConfigureSchema=z.strictObject({name:indexName,type:z.string().min(1),property:propertyPathSchema,embeddingFunction:z.string().min(1),dimensions:z.number().int().min(1).max(4096)});
export const semanticIndexSchema=z.strictObject({name:indexName,objects:z.array(objectRefSchema).min(1).max(100)});
export const semanticSearchSchema=z.strictObject({name:indexName,text:z.string().min(1).max(32000),limit:z.number().int().min(1).max(100).default(10)});
export const semanticStatusSchema=z.strictObject({name:indexName});
type Configuration=z.output<typeof semanticConfigureSchema>&{release:string;binding:string;modelVersion:string};
export async function initializeSemantic(db:Database) {
  await db.query(`CREATE TABLE IF NOT EXISTS ${db.schema}.semantic_indexes (
    ontology text NOT NULL,release text NOT NULL REFERENCES ${db.schema}.releases(digest),name text NOT NULL,
    type text NOT NULL,property text NOT NULL,embedding_function text NOT NULL,embedding_version text NOT NULL,binding text NOT NULL,dimensions integer NOT NULL,
    PRIMARY KEY(ontology,release,name));
    ALTER TABLE ${db.schema}.semantic_indexes ADD COLUMN IF NOT EXISTS embedding_version text;
    CREATE TABLE IF NOT EXISTS ${db.schema}.semantic_vectors (
      ontology text NOT NULL,release text NOT NULL,name text NOT NULL,owner text NOT NULL,type text NOT NULL,id text NOT NULL,
      revision bigint NOT NULL,text_digest text NOT NULL,binding text NOT NULL,dimensions integer NOT NULL,vector jsonb NOT NULL,
      indexed_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(ontology,release,name,owner,type,id),
      FOREIGN KEY(ontology,release,name) REFERENCES ${db.schema}.semantic_indexes(ontology,release,name));`);
}
const normalized=(raw:unknown,dimensions:number):number[]=>{
  const vector=z.array(z.number().finite()).length(dimensions).parse(raw),norm=Math.hypot(...vector);
  if(!Number.isFinite(norm)||norm===0)throw new Conflict('Embedding must have a finite nonzero norm');
  return vector.map(value=>value/norm);
};
export class SemanticSearch {
  constructor(private readonly db:Database,private readonly functions:Functions) {}
  async configure(access:Access,model:PublishedOntology,raw:unknown) {
    const input=semanticConfigureSchema.parse(raw);
    if(model.scenario)throw new Conflict('Configure semantic indexes on a published live Ontology');
    await access.refresh();access.require(model.document.id,'manage_definition',model.document.id);
    const property=model.object(input.type).properties[input.property.split('.')[0]!];
    if(!property||property.derived)throw new Conflict('Semantic indexes require a stored text property');
    let valueSchema=property.schema;
    for(const field of input.property.split('.').slice(1)) {
      const next=valueSchema.type==='array'&&/^\d+$/.test(field)?valueSchema.items:(valueSchema.properties as Record<string,unknown>|undefined)?.[field];
      if(!next||typeof next!=='object')throw new Conflict('Unknown nested embedding property');
      valueSchema=next as Record<string,unknown>;
    }
    if(valueSchema.type!=='string'&&!(Array.isArray(valueSchema.type)&&valueSchema.type.includes('string')))throw new Conflict('Embedding property schema must contain text');
    const definition=model.functions.get(input.embeddingFunction);
    if(!definition||!definition.version||definition.edits||!model.bindings.functions[input.embeddingFunction])throw new Conflict('Register and publish a versioned read-only embedding Function first');
    const parameters=definition.parameters.properties as Record<string,{type?:string}>|undefined;
    if(parameters?.text?.type!=='string'||definition.returns.type!=='array'||(definition.returns.items as {type?:string}|undefined)?.type!=='number')throw new Conflict('Embedding Function must accept text:string and return number[]');
    const binding=model.bindings.functions[input.embeddingFunction]!;
    return this.db.transaction(async client=>{
      await new Objects(this.db,model,access,client).lockWrites();
      const existing=(await this.db.query(`SELECT * FROM ${this.db.schema}.semantic_indexes WHERE ontology=$1 AND release=$2 AND name=$3`,[model.document.id,model.release,input.name],client)).rows[0];
      if(existing&&(existing.type!==input.type||existing.property!==input.property||existing.embedding_function!==input.embeddingFunction||existing.dimensions!==input.dimensions||existing.binding!==binding||existing.embedding_version!==definition.version))throw new Conflict('A semantic index configuration is immutable; use another name or publication');
      await this.db.query(`INSERT INTO ${this.db.schema}.semantic_indexes(ontology,release,name,type,property,embedding_function,binding,dimensions,embedding_version)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,[model.document.id,model.release,input.name,input.type,input.property,input.embeddingFunction,binding,input.dimensions,definition.version],client);
      const configured=(await this.db.query(`SELECT type,property,embedding_function,embedding_version,dimensions,binding FROM ${this.db.schema}.semantic_indexes WHERE ontology=$1 AND release=$2 AND name=$3`,[model.document.id,model.release,input.name],client)).rows[0]!;
      if(configured.type!==input.type||configured.property!==input.property||configured.embedding_function!==input.embeddingFunction||Number(configured.dimensions)!==input.dimensions||configured.binding!==binding||configured.embedding_version!==definition.version)throw new Conflict('Concurrent semantic configuration differs');
      await access.refresh(client);return {...input,release:model.release,binding,modelVersion:definition.version};
    });
  }
  private async configuration(access:Access,model:PublishedOntology,name:string):Promise<Configuration> {
    indexName.parse(name);await access.refresh();
    const row=(await this.db.query(`SELECT * FROM ${this.db.schema}.semantic_indexes WHERE ontology=$1 AND release=$2 AND name=$3`,[model.document.id,model.release,name])).rows[0];
    if(!row)throw new NotFound('Semantic index is unavailable for this publication');
    access.read(model,row.type);access.function(model,row.embedding_function);
    if(row.binding!==model.bindings.functions[row.embedding_function]||row.embedding_version!==model.functions.get(row.embedding_function)?.version)throw new Conflict('Semantic index model binding changed');
    return {name,type:row.type,property:row.property,embeddingFunction:row.embedding_function,dimensions:Number(row.dimensions),release:row.release,binding:row.binding,modelVersion:row.embedding_version};
  }
  private async embed(access:Access,model:PublishedOntology,configuration:Configuration,text:string) {
    const result=await this.functions.invoke(model,configuration.embeddingFunction,{text},{principal:access.principal,objects:new Objects(this.db,model,access),signal:AbortSignal.timeout(30000)});
    return normalized(result,configuration.dimensions);
  }
  async index(access:Access,model:PublishedOntology,raw:unknown) {
    const input=semanticIndexSchema.parse(raw),configuration=await this.configuration(access,model,input.name);
    if(model.scenario)throw new Conflict('Index live objects before opening a Scenario');
    const refs=[...new Map(input.objects.map(ref=>[digest(ref),ref])).values()];
    let indexed=0;
    for(const ref of refs) {
      if(ref.type!==configuration.type)throw new Conflict('Object type differs from the semantic index');
      const graph=new Objects(this.db,model,access),object=await graph.readStored(ref);
      const text=nestedValue(object.properties,configuration.property);
      if(typeof text!=='string'||!text.length||text.length>32000)throw new Conflict('Embedding input must be an authorized string of 1 to 32000 characters');
      const textDigest=digest(text),vector=await this.embed(access,model,configuration,text);
      await this.db.transaction(async client=>{
        const currentGraph=new Objects(this.db,model,access,client);await currentGraph.lockWrites();
        const current=await currentGraph.readStored(ref);
        if(current.revision!==object.revision||digest(nestedValue(current.properties,configuration.property))!==textDigest)throw new Conflict('Object changed while its embedding was generated; retry indexing');
        if(!await access.canReturn(access.dataRequirements(),client))throw new Conflict('Embedding input permissions changed');
        await this.db.query(`INSERT INTO ${this.db.schema}.semantic_vectors(ontology,release,name,owner,type,id,revision,text_digest,binding,dimensions,vector)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(ontology,release,name,owner,type,id)
          DO UPDATE SET revision=excluded.revision,text_digest=excluded.text_digest,binding=excluded.binding,dimensions=excluded.dimensions,vector=excluded.vector,indexed_at=now()`,
          [model.document.id,model.release,input.name,access.principal.owner,ref.type,ref.id,current.revision,textDigest,configuration.binding,configuration.dimensions,JSON.stringify(vector)],client);
      });
      indexed++;
    }
    return {name:input.name,indexed,release:model.release,dimensions:configuration.dimensions,binding:configuration.binding,modelVersion:configuration.modelVersion};
  }
  private async candidates(access:Access,model:PublishedOntology,configuration:Configuration) {
    return this.db.transaction(async client=>{
      await this.db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',[],client);
      await access.refresh(client);
      const graph=new Objects(this.db,model,access,client),objects:ObjectData[]=[];
      let cursor:string|undefined;
      do {
        const page=await graph.queryStored({type:configuration.type,limit:100,cursor});objects.push(...page.items);cursor=page.cursor;
        if(objects.length>10000)throw new Conflict('Exact semantic search exceeds 10000 authorized objects');
      }while(cursor);
      const vectors=(await this.db.query(`SELECT vector.type,vector.id,vector.revision,vector.text_digest,vector.binding,vector.dimensions,vector.vector FROM ${this.db.schema}.semantic_vectors vector JOIN jsonb_to_recordset($5::jsonb) AS selected(type text,id text) ON selected.type=vector.type AND selected.id=vector.id WHERE ontology=$1 AND release=$2 AND name=$3 AND owner=$4`,[model.document.id,model.release,configuration.name,access.principal.owner,JSON.stringify(objects.map(object=>object.ref))],client)).rows;
      const byRef=new Map(vectors.map(row=>[digest({type:row.type,id:row.id}),row]));
      return objects.flatMap(object=>{
        const text=nestedValue(object.properties,configuration.property),row=byRef.get(digest(object.ref));
        if(typeof text!=='string'||!row||Number(row.revision)!==object.revision||row.text_digest!==digest(text)||row.binding!==configuration.binding||Number(row.dimensions)!==configuration.dimensions)return [];
        return [{object,vector:normalized(row.vector,configuration.dimensions)}];
      });
    });
  }
  async search(access:Access,model:PublishedOntology,raw:unknown) {
    const input=semanticSearchSchema.parse(raw),configuration=await this.configuration(access,model,input.name);
    const query=await this.embed(access,model,configuration,input.text),candidates=await this.candidates(access,model,configuration);
    const items=candidates.map(({object,vector})=>({object,score:vector.reduce((sum,value,index)=>sum+value*query[index]!,0)}))
      .sort((left,right)=>right.score-left.score||Buffer.compare(Buffer.from(digest(left.object.ref)),Buffer.from(digest(right.object.ref)))).slice(0,input.limit);
    if(!await access.canReturn(access.dataRequirements()))throw new Conflict('Semantic result permissions changed');
    return {name:input.name,items,dimensions:configuration.dimensions,binding:configuration.binding,modelVersion:configuration.modelVersion,search:'exact_cosine'};
  }
  async status(access:Access,model:PublishedOntology,name:string) {
    const configuration=await this.configuration(access,model,name),candidates=await this.candidates(access,model,configuration);
    if(!await access.canReturn(access.dataRequirements()))throw new Conflict('Semantic status permissions changed');
    return {...configuration,currentAuthorizedObjects:candidates.length,search:'exact_cosine'};
  }
}
