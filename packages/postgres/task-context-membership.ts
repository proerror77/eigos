import type { Client } from 'pg';
import { ownerKey, type Principal } from '../core/domain.js';
import { taskContextFields } from '../security/task-context-contract.js';
import { TASK_CONTEXT_EDGES, collectTaskContextMembers } from '../security/task-context-membership.js';
import { SecurityError } from '../security/errors.js';
import { postgresBusinessSchema } from './runtime-transaction.js';
import { withPostgresTaskReadGrant } from './task-read-access.js';
import { postgresOntologyReadContext } from './ontology-release.js';
import type { StagedKernelBuilder } from '../ontology/seed-definition.js';

/** Internal task-metadata membership only. Resource roles, field access,
 * provenance, lineage and recipient/output checks are still required. */
export async function postgresTaskContextMembers(client:Client,principal:Principal,taskId:string,policyDigest:string,builder?:StagedKernelBuilder) {
 const captured=structuredClone(principal),owner=ownerKey(captured);
 return withPostgresTaskReadGrant(client,captured,taskId,policyDigest,async admission=>{
  await postgresOntologyReadContext(client,owner,{taskId},captured.scopes.includes('ontology:admin'),builder);
  const q=`"${postgresBusinessSchema(client)}"`,types=Object.keys(taskContextFields).filter(type=>type!=='RegisteredCapability'),edges=[...TASK_CONTEXT_EDGES];
  // SQLite refuses malformed metadata and malformed objects touching reviewed
  // edges; never interpret such records as simply absent in PostgreSQL.
  const invalid=await client.query(`SELECT 1 FROM ${q}.ontology_objects o WHERE o.owner=$1 AND ${q}.eigos_try_jsonb(o.body) IS NULL
   AND (o.type=ANY($2::text[]) OR o.type='RegisteredCapability' AND EXISTS(SELECT 1 FROM ${q}.ontology_links l WHERE l.owner=o.owner AND l.type='CapabilityRequest' AND l.from_type=o.type AND l.from_id=o.id AND l.to_type='ServiceRequest' AND l.to_id=$3)
   OR EXISTS(SELECT 1 FROM ${q}.ontology_links l WHERE l.owner=o.owner AND l.type=ANY($4::text[]) AND (l.from_type=o.type AND l.from_id=o.id OR l.to_type=o.type AND l.to_id=o.id))) LIMIT 1`,[owner,types,taskId,edges]);
  if(invalid.rowCount)throw new SecurityError('POLICY_CHANGED');
  // SQLite json_extract and JSON.parse disagree on duplicate keys. Reject
  // ambiguous relevant records before jsonb can select a different membership.
  const ambiguous=await client.query(`WITH relevant AS MATERIALIZED (SELECT o.body FROM ${q}.ontology_objects o WHERE o.owner=$1 AND ${q}.eigos_try_jsonb(o.body) IS NOT NULL
   AND (${q}.eigos_try_jsonb(o.body)#>>'{source,id}'=$2 OR o.type='RegisteredCapability' AND EXISTS(SELECT 1 FROM ${q}.ontology_links l WHERE l.owner=o.owner AND l.type='CapabilityRequest' AND l.from_type=o.type AND l.from_id=o.id AND l.to_type='ServiceRequest' AND l.to_id=$2)))
   SELECT 1 FROM relevant r CROSS JOIN LATERAL (SELECT r.body::json AS value OFFSET 0) j WHERE
   EXISTS(SELECT 1 FROM json_each(CASE WHEN json_typeof(j.value)='object' THEN j.value ELSE '{}'::json END) WHERE key IN ('source','properties') GROUP BY key HAVING count(*)>1)
   OR EXISTS(SELECT 1 FROM json_each(CASE WHEN json_typeof(j.value->'source')='object' THEN j.value->'source' ELSE '{}'::json END) WHERE key IN ('id','kind') GROUP BY key HAVING count(*)>1)
   OR EXISTS(SELECT 1 FROM json_each(CASE WHEN json_typeof(j.value->'properties')='object' THEN j.value->'properties' ELSE '{}'::json END) WHERE key IN ('requestRevision','introducedRevision','definitionDigest') GROUP BY key HAVING count(*)>1) LIMIT 1`,[owner,taskId]);
  if(ambiguous.rowCount)throw new SecurityError('POLICY_CHANGED');
  const rows=await client.query(`WITH candidates AS MATERIALIZED (
   SELECT type,id,body FROM ${q}.ontology_objects WHERE owner=$1 AND type=ANY($2::text[]) AND ${q}.eigos_try_jsonb(body)#>>'{source,id}'=$3 AND ${q}.eigos_try_jsonb(body)#>>'{source,kind}'='task'
   UNION ALL SELECT o.type,o.id,o.body FROM ${q}.ontology_links l JOIN ${q}.ontology_objects o ON o.owner=l.owner AND o.type=l.from_type AND o.id=l.from_id
   WHERE l.owner=$1 AND l.type='CapabilityRequest' AND l.from_type='RegisteredCapability' AND l.to_type='ServiceRequest' AND l.to_id=$3 ORDER BY type,id LIMIT 2001)
   SELECT CASE WHEN octet_length(type)<=80 THEN type END AS type,CASE WHEN octet_length(id)<=800 THEN id END AS id,
    CASE WHEN octet_length(body)<=1048576 AND sum(octet_length(body)) OVER ()<=8388608 THEN body END AS body FROM candidates`,[owner,types,taskId]);
  if(rows.rows.length>2000)throw new SecurityError('INSUFFICIENT_ACCESS');
  if(rows.rows.some(row=>row.type===null || row.id===null || row.body===null))throw new SecurityError('INSUFFICIENT_ACCESS');
  const links=await client.query(`WITH task_objects AS MATERIALIZED (SELECT type,id FROM ${q}.ontology_objects WHERE owner=$1 AND ${q}.eigos_try_jsonb(body)#>>'{source,id}'=$2), selected_links AS MATERIALIZED (
   SELECT l.type,l.from_type,l.from_id,l.to_type,l.to_id FROM task_objects o JOIN ${q}.ontology_links l ON l.owner=$1 AND l.from_type=o.type AND l.from_id=o.id WHERE l.type=ANY($3::text[])
   UNION SELECT l.type,l.from_type,l.from_id,l.to_type,l.to_id FROM task_objects o JOIN ${q}.ontology_links l ON l.owner=$1 AND l.to_type=o.type AND l.to_id=o.id WHERE l.type=ANY($3::text[])
   ORDER BY 1,2,3,4,5 LIMIT 4001)
   SELECT type,CASE WHEN octet_length(from_type)<=80 THEN from_type END AS from_type,CASE WHEN octet_length(from_id)<=800 THEN from_id END AS from_id,
    CASE WHEN octet_length(to_type)<=80 THEN to_type END AS to_type,CASE WHEN octet_length(to_id)<=800 THEN to_id END AS to_id FROM selected_links`,[owner,taskId,edges]);
  if(links.rows.length>4000 || links.rows.some(row=>row.from_type===null || row.from_id===null || row.to_type===null || row.to_id===null))throw new SecurityError('INSUFFICIENT_ACCESS');
  try {return [...collectTaskContextMembers(rows.rows,links.rows,taskId,admission.grant.requestRevision).values()];}
  catch(error) {if(error instanceof SecurityError)throw error;throw new SecurityError('POLICY_CHANGED');}
 });
}
