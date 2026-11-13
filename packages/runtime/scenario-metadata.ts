import { z } from 'zod';
import { Conflict, NotFound, digest } from '../core/identity.js';
import type { ObjectData, ObjectRef } from '../ontology/schema.js';
import type { Objects, Query } from './objects.js';

export const scenarioMetadataType = 'OntologyScenario';

function asObject(row: Record<string, any>): ObjectData {
  return { ref: { type: scenarioMetadataType, id: String(row.id) }, revision: Number(row.revision), properties: {
    id: String(row.id), name: String(row.name), owner: String(row.owner), state: String(row.state),
    release: String(row.release), revision: Number(row.revision), expiresAt: new Date(row.expires_at).toISOString(),
    kind: String(row.kind), description: String(row.description),
  } };
}
export async function scenarioMetadataRead(graph: Objects, ref: ObjectRef): Promise<ObjectData> {
  z.uuid().parse(ref.id); graph.access.read(graph.model,scenarioMetadataType);
  const row=(await graph.db.query(`SELECT * FROM ${graph.db.schema}.scenarios WHERE id=$1 AND release=$2 AND kind='persisted'
    AND expires_at>now() AND (owner=$3 OR readers ? $3)`,[ref.id,graph.model.release,graph.owner],graph.client)).rows[0];
  if(!row)throw new NotFound('Scenario metadata is unavailable');
  const object=asObject(row),properties=graph.maskSnapshot(object.ref,object.properties);
  if(!properties)throw new NotFound('Scenario metadata is unavailable');
  return {...object,properties};
}
export async function scenarioMetadataQuery(graph: Objects, input: Query) {
  if(input.from)throw new Conflict('Scenario metadata has no published relationships');
  graph.access.read(graph.model,scenarioMetadataType);
  const limit=z.number().int().min(1).max(100).parse(input.limit??50);
  const fingerprint=digest({owner:graph.owner,release:graph.model.release,where:input.where??{},select:input.select});
  const cursor=input.cursor?z.strictObject({query:z.literal(fingerprint),id:z.uuid()}).parse(JSON.parse(Buffer.from(input.cursor,'base64url').toString())).id:null;
  const values:unknown[]=[graph.model.release,graph.owner,cursor];
  const clauses=[`release=$1`,`kind='persisted'`,`expires_at>now()`,`(owner=$2 OR readers ? $2)`,`($3::uuid IS NULL OR id>$3)`];
  const items:ObjectData[]=[];
  let after=cursor;
  let more=false;
  do {
    values[2]=after;
    const rows=(await graph.db.query(`SELECT * FROM ${graph.db.schema}.scenarios WHERE ${clauses.join(' AND ')} ORDER BY id LIMIT 101`,values,graph.client)).rows;
    more=rows.length>100;
    for(const row of rows.slice(0,100)) {
      after=String(row.id);
      const object=asObject(row),visible=graph.maskSnapshot(object.ref,object.properties);
      if(!visible)continue;
      for(const field of Object.keys(input.where??{}))graph.model.propertyName(scenarioMetadataType,scenarioMetadataType,field);
      if(!Object.entries(input.where??{}).every(([key,value])=>digest(visible[key]??null)===digest(value)))continue;
      const properties=input.select?Object.fromEntries(input.select.map(field=>{
        graph.model.propertyName(scenarioMetadataType,scenarioMetadataType,field);return [field,visible[field]];
      })):visible;
      items.push({...object,properties});
      if(items.length===limit) {
        const hasRemaining=rows.some(item=>String(item.id)>after!)||more;
        return {items,cursor:hasRemaining?Buffer.from(JSON.stringify({query:fingerprint,id:after})).toString('base64url'):undefined};
      }
    }
  }while(more);
  return {items,cursor:undefined};
}
