import {z} from 'zod';
import type {PropertyDefinition} from '../ontology/model.js';
import {didiDataSchema,didiPlaceSchema} from '../capabilities/didi/contracts.js';

/** Explicit reviewed views over mixed internal snapshots. The original stored
 * snapshot stays internal_only. No open record or source receipt is exported. */
export const didiBusinessViewSchema=z.strictObject({data:didiDataSchema,route:z.strictObject({origin:didiPlaceSchema,destination:didiPlaceSchema}).optional(),
  observedAt:z.iso.datetime(),expiresAt:z.iso.datetime(),evidenceKind:z.enum(['live_readonly','provider_mock','fixture']),noBusinessWrites:z.literal(true)});
const types=new Set(['DidiPlaceObservation','RideEstimateObservation']);
const paths=['data','route','observedAt','expiresAt','evidenceKind','noBusinessWrites'] as const;
export const projectionContract={version:'eigos.authorized-projections.v1',types:[...types],field:'observedData',source:'snapshot',paths:[...paths],schema:z.toJSONSchema(didiBusinessViewSchema)};
export function projectionFields(type:string):Record<string,PropertyDefinition> {
  return types.has(type)?{observedData:{kind:'struct',schema:didiBusinessViewSchema,description:'Task-authorized place or estimated fare facts, without account bindings, transport receipts, model history, or private trace IDs',source:'eigos.authorized-projections.v1',required:true}}:{};
}
export const projectionInputs=(type:string,field:string)=>types.has(type) && field==='observedData'?['snapshot']:[];
export function projectedValue(type:string,field:string,properties:Record<string,unknown>):unknown {
  if(field!=='observedData' || !types.has(type)) return properties[field];
  if(Object.hasOwn(properties,'observedData')) return didiBusinessViewSchema.parse(properties.observedData);
  const snapshot=properties.snapshot as Record<string,unknown>|undefined;
  if(!snapshot) return undefined;
  return didiBusinessViewSchema.parse(Object.fromEntries(paths.filter(key=>snapshot[key]!==undefined).map(key=>[key,snapshot[key]])));
}
export function integrityField(type:string,field:string,allowed:string[]):boolean {
  if(field==='configurationDigest' || field==='allowedActions') return true;
  if(type==='SourceReceipt') return ['sourceIdentity','sourceEventId','contentDigest','subjects'].includes(field);
  return field==='snapshot' && types.has(type) && allowed.includes('observedData');
}
export const integrityFunctions=new Set(['rideEstimateStatus','selectDidiPlace']);
