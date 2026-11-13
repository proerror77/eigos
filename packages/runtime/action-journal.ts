import { Conflict, NotFound, digest } from '../core/identity.js';
import type { LinkData, ObjectRef } from '../ontology/schema.js';
import type { Database } from './database.js';
import { Objects } from './objects.js';
import { objectLinks } from './scenario-store.js';

type Snapshot={revision:number;properties:Record<string,unknown>}|null;
export interface ObjectChange {ref:ObjectRef;before:Snapshot;after:Snapshot;afterLinks:unknown[]}
export interface LinkChange {edge:LinkData;before:boolean;after:boolean}

export async function initializeActionUndo(db:Database){
  await db.query(`CREATE TABLE IF NOT EXISTS ${db.schema}.action_changes(
    owner text NOT NULL,request_id text NOT NULL,release text NOT NULL,action text NOT NULL,result jsonb NOT NULL,
    objects jsonb NOT NULL,links jsonb NOT NULL,undone_by text,PRIMARY KEY(owner,request_id));
    CREATE TABLE IF NOT EXISTS ${db.schema}.action_undo_requests(
    owner text NOT NULL,request_id text NOT NULL,original_request_id text NOT NULL,result jsonb NOT NULL,
    PRIMARY KEY(owner,request_id));`);
}

/** Records only touched objects and links on the Action's existing transaction. */
export class JournalObjects extends Objects {
  private readonly beforeObjects=new Map<string,{ref:ObjectRef;before:Snapshot}>();
  private readonly beforeLinks=new Map<string,{edge:LinkData;before:boolean}>();
  private async snapshot(ref:ObjectRef):Promise<Snapshot>{
    const row=(await this.db.query(`SELECT revision,properties FROM ${this.db.schema}.objects WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4`,[this.model.projection,this.owner,ref.type,ref.id],this.client)).rows[0];
    return row?{revision:Number(row.revision),properties:row.properties}:null;
  }
  private async remember(ref:ObjectRef){
    const key=digest(ref);
    if(!this.beforeObjects.has(key))this.beforeObjects.set(key,{ref,before:await this.snapshot(ref)});
  }
  private async linkPresent(edge:LinkData){
    return (await this.db.query(`SELECT 1 FROM ${this.db.schema}.links WHERE projection=$1 AND owner=$2 AND type=$3 AND from_type=$4 AND from_id=$5 AND to_type=$6 AND to_id=$7`,[this.model.projection,this.owner,edge.type,edge.from.type,edge.from.id,edge.to.type,edge.to.id],this.client)).rowCount!>0;
  }
  private async rememberLink(edge:LinkData){
    const key=digest(edge);
    if(!this.beforeLinks.has(key))this.beforeLinks.set(key,{edge,before:await this.linkPresent(edge)});
  }
  override async create(ref:ObjectRef,properties:Record<string,unknown>){await this.remember(ref);return super.create(ref,properties);}
  override async edit(ref:ObjectRef,revision:number,fields:Record<string,unknown>){await this.remember(ref);return super.edit(ref,revision,fields);}
  override async remove(ref:ObjectRef,revision:number){await this.remember(ref);return super.remove(ref,revision);}
  override async ingestBatch(rows:readonly {ref:ObjectRef;properties:Record<string,unknown>|null}[],source='default',observedAt?:string){
    for(const row of rows){
      await this.remember(row.ref);
      for(const link of await objectLinks(this.db,this.model,this.owner,row.ref,this.client)){
        await this.rememberLink({type:link.type,from:{type:link.from_type,id:link.from_id},to:{type:link.to_type,id:link.to_id}});
      }
    }
    return super.ingestBatch(rows,source,observedAt);
  }
  override async linkBatch(edges:readonly LinkData[]){for(const edge of edges)await this.rememberLink(edge);return super.linkBatch(edges);}
  override async unlink(edge:LinkData){await this.rememberLink(edge);return super.unlink(edge);}
  async changes(){
    const objects:ObjectChange[]=[],links:LinkChange[]=[];
    for(const item of this.beforeObjects.values()){
      const after=await this.snapshot(item.ref);
      if(digest(item.before)!==digest(after))objects.push({...item,after,afterLinks:await objectLinks(this.db,this.model,this.owner,item.ref,this.client)});
    }
    for(const item of this.beforeLinks.values()){
      const after=await this.linkPresent(item.edge);
      if(item.before!==after)links.push({...item,after});
    }
    return {objects,links};
  }
}

export async function compensate(graph:Objects,objects:ObjectChange[],links:LinkChange[]){
  const equal=(left:unknown,right:unknown)=>digest({value:left})===digest({value:right});
  for(const change of objects){
    const row=(await graph.db.query(`SELECT revision,properties FROM ${graph.db.schema}.objects WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4`,[graph.model.projection,graph.owner,change.ref.type,change.ref.id],graph.client)).rows[0];
    const live=row?{revision:Number(row.revision),properties:row.properties}:undefined;
    if(live)await graph.read(change.ref);
    if(change.after){
      if(!live||live.revision!==change.after.revision||digest(live.properties)!==digest(change.after.properties))throw new Conflict('An edited object changed after this Action');
      if(digest(await objectLinks(graph.db,graph.model,graph.owner,change.ref,graph.client))!==digest(change.afterLinks))throw new Conflict('An edited object has newer relationships');
    }else if(live)throw new Conflict('A deleted object has been recreated');
    if(change.before){
      graph.access.readRow(graph.model,change.ref.type,change.before.properties);
      const changed=[...new Set([...Object.keys(change.before.properties),...Object.keys(change.after?.properties??{})])].filter(field=>!change.after||!equal(change.before!.properties[field],change.after.properties[field]));
      if(changed.some(field=>!graph.access.cell(graph.model,change.ref.type,field,change.before!.properties)))throw new Conflict('Undo would restore a hidden property');
    }
  }
  for(const change of links){
    graph.access.definition(graph.model,'link',change.edge.type);
    const present=(await graph.db.query(`SELECT 1 FROM ${graph.db.schema}.links WHERE projection=$1 AND owner=$2 AND type=$3 AND from_type=$4 AND from_id=$5 AND to_type=$6 AND to_id=$7`,[graph.model.projection,graph.owner,change.edge.type,change.edge.from.type,change.edge.from.id,change.edge.to.type,change.edge.to.id],graph.client)).rowCount!>0;
    if(present!==change.after)throw new Conflict('A relationship changed after this Action');
  }
  for(const change of links)if(!change.before)await graph.unlink(change.edge);
  for(const change of objects){
    if(!change.before)continue;
    if(!change.after)await graph.create(change.ref,change.before.properties);
    else {
      const fields=Object.fromEntries([...new Set([...Object.keys(change.before.properties),...Object.keys(change.after.properties)])]
        .filter(field=>!equal(change.before!.properties[field],change.after!.properties[field])).map(field=>[field,change.before!.properties[field]]));
      await graph.edit(change.ref,change.after.revision,fields);
    }
  }
  for(const change of objects)if(!change.before&&change.after)await graph.remove(change.ref,change.after.revision);
  for(const change of links)if(change.before)await graph.link(change.edge);
}
