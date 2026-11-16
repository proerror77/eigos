import { z } from 'zod';
import { Conflict, digest } from '../core/identity.js';
import { processLogTarget } from '../ontology/process-definition.js';
import { objectRefSchema, ontologyName } from '../ontology/schema.js';
import type { Access } from './access.js';
import type { Database } from './database.js';
import type { PublishedOntology } from './metadata.js';
import { Objects } from './objects.js';
import { lockEdits } from './scenario-store.js';

const state = z.string().min(1).max(200).nullable();
export const machineryHistorySchema = z.strictObject({
  type: ontologyName, source: ontologyName,
  events: z.array(z.strictObject({
    id:z.string().min(1).max(200), object:objectRefSchema,
    from:state, to:state, observedAt:z.iso.datetime({offset:true}),
  })).min(1).max(1000),
}).refine(input=>new Set(input.events.map(item=>item.id)).size===input.events.length,'External event IDs must be distinct');

export async function initializeMachineryHistory(db:Database){
  await db.query(`CREATE TABLE IF NOT EXISTS ${db.schema}.machinery_history (
    ontology text NOT NULL, owner text NOT NULL, type text NOT NULL, source text NOT NULL, id text NOT NULL,
    object_type text NOT NULL, object_id text NOT NULL, property text NOT NULL, observed_at timestamptz NOT NULL,
    previous_state text, next_state text, fingerprint text NOT NULL,
    PRIMARY KEY(ontology,owner,type,source,id),
    UNIQUE(ontology,owner,type,source,object_id,observed_at));
    CREATE INDEX IF NOT EXISTS machinery_history_window ON ${db.schema}.machinery_history(ontology,owner,type,source,observed_at)`);
}

export async function ingestMachineryHistory(db:Database, access:Access, model:PublishedOntology, raw:unknown){
  const input=machineryHistorySchema.parse(raw), owner=access.principal.owner;
  const target=processLogTarget(model,input.type);
  if(!target)throw new Conflict('Select a published concrete ProcessLog type');
  const states=new Set(model.object(target.objectType).properties[target.property]!.schema.enum as string[]);
  return db.withOwner(owner,()=>db.transaction(async client=>{
    await lockEdits(db,model,owner,client);
    await access.refresh(client);
    access.require(model.document.id,'ingest_source',`${model.document.id}/source/${input.source}`);
    access.source(model,input.source);
    access.read(model,target.type);
    const graph=new Objects(db,model,access,client);
    const checked=new Set<string>();
    let inserted=0;
    for(const event of input.events){
      if(event.object.type!==target.objectType||event.from===event.to||
        [event.from,event.to].some(value=>value!==null&&!states.has(value))||Date.parse(event.observedAt)>Date.now())
        throw new Conflict('External event does not satisfy the process state and observation contract');
      if(!checked.has(event.object.id)){
        await graph.read(event.object);
        if(!await graph.propertyVisible(event.object,target.property))throw new Conflict('Process state is unavailable');
        checked.add(event.object.id);
      }
      const fingerprint=digest({...event,observedAt:new Date(event.observedAt).toISOString()});
      const result=await db.query(`INSERT INTO ${db.schema}.machinery_history
        (ontology,owner,type,source,id,object_type,object_id,property,observed_at,previous_state,next_state,fingerprint)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
        [model.document.id,owner,target.type,input.source,event.id,target.objectType,event.object.id,target.property,event.observedAt,event.from,event.to,fingerprint],client);
      if(result.rowCount){inserted++;continue;}
      const prior=(await db.query(`SELECT fingerprint FROM ${db.schema}.machinery_history
        WHERE ontology=$1 AND owner=$2 AND type=$3 AND source=$4 AND id=$5`,
        [model.document.id,owner,target.type,input.source,event.id],client)).rows[0];
      if(prior?.fingerprint!==fingerprint)throw new Conflict('External event ID or observation time conflicts with existing history');
    }
    await access.refresh(client);
    return {inserted,replayed:input.events.length-inserted,source:input.source};
  }));
}
