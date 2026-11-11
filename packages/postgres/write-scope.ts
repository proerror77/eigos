import {createHash} from 'node:crypto';
import type {Client} from 'pg';
import {z} from 'zod';
import {ownerIdentitySchema} from '../security/contracts.js';

/** Scheduling/serialization only. Callers still own every authority, source,
 * lease and output check. Task scope is reserved for claim/accounting changes;
 * shared owner projections must use owner scope. */
export type PostgresWriteScope={kind:'owner';owner:string}|{kind:'task';owner:string;taskId:string}|{kind:'queue'};
const scopeSchema=z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('owner'),owner:ownerIdentitySchema}),
  z.strictObject({kind:z.literal('task'),owner:ownerIdentitySchema,taskId:z.string().min(1).max(128)}),
  z.strictObject({kind:z.literal('queue')}),
]);
export const postgresWriteScope=(scope:PostgresWriteScope):PostgresWriteScope=>scopeSchema.parse(scope);
const key=(schema:string,...parts:string[])=>createHash('sha256').update(JSON.stringify(['eigos-write-scope-v1',schema,...parts])).digest().readBigInt64BE().toString();

/** Locks precede the table fence and all business reads. READ COMMITTED opens
 * a fresh snapshot after waiting; no session-level locks can escape rollback.
 * Fixed hierarchy: owner partition, then task. The queue only tries owners. */
export async function lockPostgresWriteScope(client:Client,schema:string,scope:PostgresWriteScope){
  if(scope.kind==='queue'){
    await client.query('SELECT pg_catalog.pg_advisory_xact_lock($1::bigint)',[key(schema,'worker-capacity')]);return;
  }
  const fn=scope.kind==='owner'?'pg_advisory_xact_lock':'pg_advisory_xact_lock_shared';
  await client.query(`SELECT pg_catalog.${fn}($1::bigint)`,[key(schema,'owner',scope.owner)]);
  if(scope.kind==='task')await client.query('SELECT pg_catalog.pg_advisory_xact_lock($1::bigint)',[key(schema,'task',scope.owner,scope.taskId)]);
}
export async function tryPostgresOwnerWriteLock(client:Client,schema:string,owner:string){
  ownerIdentitySchema.parse(owner);
  const result=await client.query('SELECT pg_catalog.pg_try_advisory_xact_lock($1::bigint) AS locked',[key(schema,'owner',owner)]);
  return result.rowCount===1&&result.rows[0]?.locked===true;
}
