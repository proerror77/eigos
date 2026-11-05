import type {Client} from 'pg';
import {digest} from '../core/delegation.js';
import {securityEnvelopeSchema} from '../security/contracts.js';
import {SecurityError} from '../security/errors.js';
import {postgresBusinessSchema,postgresBusinessToken} from './runtime-transaction.js';

/** Retained influence for this exact original task and request revision.
 * This is evidence history only; every use must validate current permissions. */
export async function postgresTaskReadHistory(client:Client,owner:string,taskId:string,requestRevision:number){
  const schema=postgresBusinessSchema(client),token=postgresBusinessToken(client);
  const invalid=await client.query(`WITH grants AS(SELECT issued.body,"${schema}".eigos_try_jsonb(issued.body) AS parsed
    FROM "${schema}".security_grants issued WHERE issued.owner=$1 AND issued.kind='task_data'
      AND EXISTS(SELECT 1 FROM "${schema}".security_reads r WHERE r.grant_id=issued.id))
    SELECT 1 FROM grants g WHERE g.parsed IS NULL OR(
      EXISTS(SELECT 1 FROM json_each(CASE WHEN jsonb_typeof(g.parsed)='object' THEN g.body::json ELSE '{}'::json END) entry
        WHERE entry.key='taskId' AND json_typeof(entry.value)='string' AND entry.value#>>'{}'=$2)
      AND EXISTS(SELECT 1 FROM json_each(CASE WHEN jsonb_typeof(g.parsed)='object' THEN g.body::json ELSE '{}'::json END)
        WHERE key IN('taskId','requestRevision') GROUP BY key HAVING count(*)>1)) LIMIT 1`,[owner,taskId]);
  if(invalid.rowCount)throw new SecurityError('POLICY_CHANGED');
  const history=await client.query(`WITH history AS(SELECT r.digest,r.body FROM "${schema}".security_reads r
    JOIN "${schema}".security_grants issued ON issued.id=r.grant_id WHERE issued.owner=$1 AND issued.kind='task_data'
      AND "${schema}".eigos_try_jsonb(issued.body)->>'taskId'=$2
      AND CASE WHEN jsonb_typeof("${schema}".eigos_try_jsonb(issued.body)->'requestRevision')='number'
        THEN("${schema}".eigos_try_jsonb(issued.body)->>'requestRevision')::numeric END=$3 LIMIT 2001)
    SELECT digest,CASE WHEN octet_length(body)<=8388608 AND sum(octet_length(body)) OVER()<=8388608 THEN body END AS body FROM history`,[owner,taskId,requestRevision]);
  if(history.rows.length>2000||history.rows.some(item=>item.body===null))throw new SecurityError('OUTPUT_NOT_ALLOWED');
  const envelopes=history.rows.map(item=>securityEnvelopeSchema.parse(JSON.parse(String(item.body))));
  if(envelopes.some((item,index)=>item.ownerKey!==owner||digest(item)!==history.rows[index]?.digest))throw new SecurityError('OUTPUT_NOT_ALLOWED');
  if(postgresBusinessToken(client)!==token)throw new SecurityError('AUTHORIZATION_REQUIRED');
  return envelopes;
}
