import {createHash} from 'node:crypto';
import {z} from 'zod';
import {Conflict,NotFound} from '../core/identity.js';
import {objectRefSchema,type ObjectRef} from '../ontology/schema.js';
import type {FunctionHandler} from './functions.js';
import {Access} from './access.js';
import {Database} from './database.js';
import {Objects,querySchema} from './objects.js';
import type {PublishedOntology} from './metadata.js';
import type {Actions} from './actions.js';

const name=z.string().min(1).max(200);
export const objectViewSchema=z.strictObject({type:z.string(),title:name,properties:z.array(z.string()).max(30),links:z.array(z.string()).max(20),actions:z.array(z.string()).max(20),revision:z.number().int().min(0)});
export const graphSchema=z.strictObject({object:objectRefSchema,depth:z.number().int().min(1).max(3).default(1),limit:z.number().int().min(1).max(150).default(60)});
export const mapSchema=z.strictObject({query:querySchema,property:z.string().default('coordinates')});
export async function initializeApplications(db:Database){
  await db.query(`CREATE TABLE IF NOT EXISTS ${db.schema}.object_views(owner text NOT NULL,ontology text NOT NULL,type text NOT NULL,title text NOT NULL,body jsonb NOT NULL,revision integer NOT NULL,PRIMARY KEY(owner,ontology,type));
  CREATE TABLE IF NOT EXISTS ${db.schema}.geometry_blobs(ontology text NOT NULL,owner text NOT NULL,digest text NOT NULL,format text NOT NULL,bytes bytea NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(ontology,owner,digest));
    ALTER TABLE ${db.schema}.geometry_blobs ADD COLUMN IF NOT EXISTS ontology text NOT NULL DEFAULT 'Eigos';
    ALTER TABLE ${db.schema}.geometry_blobs DROP CONSTRAINT IF EXISTS geometry_blobs_pkey;
    ALTER TABLE ${db.schema}.geometry_blobs ADD PRIMARY KEY(ontology,owner,digest);`);
}
function validateGeometry(bytes:Buffer,format:string){
  const text=()=>bytes.toString('utf8');
  if(format==='glb'){
    if(bytes.length<20||bytes.readUInt32LE(0)!==0x46546c67||bytes.readUInt32LE(4)!==2||bytes.readUInt32LE(8)!==bytes.length)throw new Conflict('Invalid GLB container');
  }else if(format==='gltf'){
    let data:Record<string,unknown>;try{data=JSON.parse(text());}catch{throw new Conflict('Invalid GLTF JSON');}
    if((data.asset as {version?:unknown}|undefined)?.version!=='2.0')throw new Conflict('GLTF 2.0 is required');
  }else if(format==='obj'){
    if(!/^v\s+[-+.\d]/m.test(text())||!/^f\s+\d/m.test(text()))throw new Conflict('OBJ requires vertices and faces');
  }else if(format==='stl'){
    const binary=bytes.length>=84&&84+bytes.readUInt32LE(80)*50===bytes.length;
    if(!binary&&(!/^\s*solid\b/.test(text())||!text().includes('facet normal')||!text().includes('endfacet')))throw new Conflict('Invalid STL model');
  }else if(format==='ply'&&(!text().startsWith('ply')||!text().slice(0,10000).includes('end_header')))throw new Conflict('Invalid PLY model');
}
export class Applications{
  constructor(private readonly db:Database){}
  async saveView(access:Access,model:PublishedOntology,raw:unknown){
    const input=objectViewSchema.parse(raw);access.read(model,input.type);
    for(const field of input.properties)model.propertyName(input.type,input.type,field);
    for(const link of input.links)model.navigation(input.type,link);
    for(const action of input.actions){model.action(action);access.definition(model,'action',action);}
    return this.db.transaction(async client=>{
      const result=await this.db.query(`INSERT INTO ${this.db.schema}.object_views(owner,ontology,type,title,body,revision) SELECT $1,$2,$3,$4,$5,1 WHERE $6=0
      ON CONFLICT(owner,ontology,type) DO UPDATE SET title=excluded.title,body=excluded.body,revision=object_views.revision+1 WHERE object_views.revision=$6 RETURNING revision`,[access.principal.owner,model.document.id,input.type,input.title,input,input.revision],client);
      if(!result.rowCount&&input.revision>0){
        const updated=await this.db.query(`UPDATE ${this.db.schema}.object_views SET title=$4,body=$5,revision=revision+1 WHERE owner=$1 AND ontology=$2 AND type=$3 AND revision=$6 RETURNING revision`,[access.principal.owner,model.document.id,input.type,input.title,input,input.revision],client);
        if(!updated.rowCount)throw new Conflict('Object view changed');
        await access.refresh(client);return {...input,revision:updated.rows[0]!.revision};
      }
      if(!result.rowCount)throw new Conflict('Object view already exists');
      await access.refresh(client);return {...input,revision:result.rows[0]!.revision};
    });
  }
  async view(access:Access,model:PublishedOntology,type:string){
    access.read(model,type);
    const row=(await this.db.query(`SELECT body,revision FROM ${this.db.schema}.object_views WHERE owner=$1 AND ontology=$2 AND type=$3`,[access.principal.owner,model.document.id,type])).rows[0];
    const visible=(view:{type:string;title:string;properties:string[];links:string[];actions:string[];revision:number})=>({...view,properties:view.properties.filter(field=>model.object(type).properties[field]),links:view.links.filter(name=>{try{const navigation=model.navigation(type,name);return access.canDefine(model,'link',navigation.link)&&access.canRead(model,navigation.target);}catch{return false;}}),actions:view.actions.filter(name=>model.actions.has(name)&&access.canDefine(model,'action',name))});
    if(row)return visible({...row.body,revision:row.revision});
    return visible({type,title:model.object(type).displayName,properties:Object.keys(model.object(type).properties),links:[...model.links.values()].flatMap(link=>[link.from,link.to].filter(side=>side.type===type).map(side=>side.name)),actions:[],revision:0});
  }
  async graph(access:Access,model:PublishedOntology,raw:unknown){
    const input=graphSchema.parse(raw),objects=new Objects(this.db,model,access);
    const root=await objects.read(input.object),nodes=new Map([[JSON.stringify(root.ref),root]]),edges:unknown[]=[];
    let frontier=[root.ref];
    for(let depth=0;depth<input.depth;depth++){
      const next:ObjectRef[]=[];
      for(const ref of frontier){
        const links=[...model.links.values()].flatMap(link=>[link.from,link.to].filter(side=>side.type===ref.type).map(side=>({type:link.apiName,name:side.name})));
        for(const link of links){
          if(!access.canDefine(model,'link',link.type))continue;
          const target=model.navigation(ref.type,link.name).target;
          if(!access.canRead(model,target))continue;
          for(const neighbor of await objects.follow(ref,link.name)){
            const key=JSON.stringify(neighbor.ref);
            if(!nodes.has(key)){
              if(nodes.size===input.limit)throw new Conflict('Graph exceeds the selected node limit; reduce depth');
              nodes.set(key,neighbor);next.push(neighbor.ref);
            }
            edges.push({type:link.type,name:link.name,from:ref,to:neighbor.ref});
          }
        }
      }
      frontier=next;
    }
    return {nodes:[...nodes.values()],edges};
  }
  async map(access:Access,model:PublishedOntology,raw:unknown){
    const input=mapSchema.parse(raw),page=await new Objects(this.db,model,access).query(input.query);
    return {...page,items:page.items.flatMap(object=>{
      const coordinates=object.properties[input.property] as {lat?:unknown;lng?:unknown}|undefined;
      if(!coordinates||typeof coordinates.lat!=='number'||typeof coordinates.lng!=='number'||!Number.isFinite(coordinates.lat)||!Number.isFinite(coordinates.lng))return [];
      return [{...object,latitude:coordinates.lat,longitude:coordinates.lng,coordinateSystem:object.properties.coordinateSystem??'unspecified'}];
    })};
  }
  async upload(access:Access,model:PublishedOntology,actions:Actions,bytes:Buffer,raw:unknown){
    const input=z.strictObject({name,format:z.enum(['glb','gltf','obj','stl','ply']),units:z.string().min(1).max(30).default('file units')}).parse(raw);
    if(!bytes.length||bytes.length>20*1024*1024)throw new Conflict('Model must be between 1 byte and 20 MiB');
    validateGeometry(bytes,input.format);
    access.action(model,'RegisterGeometry');
    const hash=createHash('sha256').update(bytes).digest('hex');
    await this.db.query(`INSERT INTO ${this.db.schema}.geometry_blobs(ontology,owner,digest,format,bytes) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[model.document.id,access.principal.owner,hash,input.format,bytes]);
    return actions.apply(access,model,'RegisterGeometry',{id:hash,name:input.name,format:input.format,contentHash:hash,byteLength:bytes.length,units:input.units},'geometry:'+model.document.id+':'+hash);
  }
  async download(access:Access,model:PublishedOntology,id:string){
    const object=await new Objects(this.db,model,access).read({type:'GeometryAsset',id});
    const row=(await this.db.query(`SELECT bytes,format FROM ${this.db.schema}.geometry_blobs WHERE owner=$1 AND digest=$2 AND ontology=$3`,[access.principal.owner,object.properties.contentHash,model.document.id])).rows[0];
    if(!row)throw new NotFound('Model file is unavailable');
    await access.refresh();return row;
  }
}
export function applicationFunctions(db:Database):ReadonlyMap<string,FunctionHandler>{
  return new Map<string,FunctionHandler>([
    ['registerGeometry',async(input,context)=>{
      if(!context.edit)throw new Conflict('Model registration requires an Action');
      const row=(await db.query(`SELECT format,octet_length(bytes) AS size FROM ${db.schema}.geometry_blobs WHERE owner=$1 AND digest=$2 AND ontology=$3`,[context.principal.owner,input.contentHash,context.objects.model.document.id])).rows[0];
      if(!row||row.format!==input.format||row.size!==input.byteLength||input.id!==input.contentHash)throw new Conflict('Uploaded model does not match its metadata');
      const ref={type:'GeometryAsset',id:String(input.id)};
      return context.edit(ref,async graph=>{await graph.create(ref,input);});
    }],
    ['annotateGeometry',async(input,context)=>{
      if(!context.edit)throw new Conflict('Model annotations require an Action');
      const asset=objectRefSchema.parse(input.asset);if(asset.type!=='GeometryAsset')throw new Conflict('Select a geometry asset');
      await context.objects.read(asset);
      const points=z.array(z.tuple([z.number().finite(),z.number().finite(),z.number().finite()])).min(1).max(2).parse(input.points);
      if(input.kind==='measurement'&&points.length!==2)throw new Conflict('A measurement requires two positions');
      if(input.kind==='section'&&(points.length!==2||Math.hypot(...points[1]!)===0))throw new Conflict('A section requires a position and nonzero normal');
      const distance=input.kind==='measurement'&&points.length===2?Math.hypot(...points[0]!.map((value,index)=>value-points[1]![index]!)):0;
      const ref={type:'GeometryAnnotation',id:String(input.id)};
      return context.edit(ref,async graph=>{
        await graph.create(ref,{id:ref.id,name:input.name,note:input.note,kind:input.kind,points,distance,createdAt:new Date().toISOString()});
        await graph.link({type:'GeometryAnnotationAsset',from:ref,to:asset});
      });
    }],
  ]);
}
