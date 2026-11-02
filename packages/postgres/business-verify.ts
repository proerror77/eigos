import { createHash, randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { canonical } from '../core/delegation.js';
import { encodeBusinessRow, planBusinessSnapshot, type BusinessSnapshotPlan, type BusinessTable } from './business-snapshot.js';

const schemaPattern=/^eigos_business_[a-z0-9_]{1,40}$/;
const digestPattern=/^[a-f0-9]{64}$/;
const quote=(value:string)=>`"${value.replaceAll('"','""')}"`;
const batchRows=64, batchBytes=8*1024*1024;

export interface BusinessVerificationOptions {
  snapshot:string;
  schema:string;
  expectedFileDigest:string;
  expectedAuthorityDigest:string;
  expectedPolicyDigest:string;
}

/** Re-read every imported business row using an exclusively owned client under one PostgreSQL snapshot and compare
 * it with the reviewed offline SQLite snapshot. This verifies row equivalence
 * at the time of the read only: it is not a schema, ACL, runtime, writer-stop,
 * cutover, or business-completion authorization. */
export async function verifyBusinessSnapshot(client:Client,options:BusinessVerificationOptions) {
  const {snapshot,schema,expectedFileDigest,expectedAuthorityDigest,expectedPolicyDigest}=options;
  if(!schemaPattern.test(schema) || !digestPattern.test(expectedFileDigest))throw new Error('Invalid business verification options');
  const plan=planBusinessSnapshot(snapshot,expectedAuthorityDigest,expectedPolicyDigest);
  if(plan.fileDigest!==expectedFileDigest)throw new Error('Business snapshot changed after review');
  if(typeof client.getTransactionStatus!=='function' || client.getTransactionStatus()!=='I' || client.pipeline!==false)throw new Error('Business verification requires an idle, non-pipelined client');
  let open=false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');open=true;
    await client.query('SET LOCAL search_path TO pg_catalog, pg_temp');
    const nonce=randomUUID();
    const started=(await client.query(`SELECT set_config('eigos.verification_nonce',$1,true) AS nonce,
      current_setting('transaction_read_only') AS read_only,current_setting('transaction_isolation') AS isolation,
      transaction_timestamp()::text AS captured_at`,[nonce])).rows[0];
    const transactionStartedAt=typeof started?.captured_at==='string'?Date.parse(started.captured_at):NaN;
    if(client.getTransactionStatus()!=='T' || started?.nonce!==nonce || started?.read_only!=='on' || started?.isolation!=='repeatable read' || !Number.isFinite(transactionStartedAt))throw new Error('Business verification transaction could not be established');
    const receiptRows=await client.query(`SELECT CASE WHEN octet_length(body::text)<=1048576 THEN body END AS body FROM ${quote(schema)}.eigos_migration_receipt WHERE slot=1 LIMIT 2`);
    const expected={version:2,status:'imported-not-activated',sourceFileDigest:plan.fileDigest,schemaDigest:plan.schemaDigest,
      authorityDigest:plan.authority.digest,policyDigest:plan.policyDigest,tables:plan.tables.map(table=>({name:table.name,rows:table.rows,digest:table.digest}))};
    if(receiptRows.rowCount!==1 || canonical(receiptRows.rows[0]?.body)!==canonical(expected))throw new Error('Business migration receipt does not match the reviewed snapshot');
    const tables=await client.query(`SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','f') ORDER BY c.relname COLLATE "C" LIMIT 10001`,[schema]);
    const expectedNames=[...plan.tables.map(table=>table.name),'eigos_migration_receipt'].sort();
    if(expectedNames.length>10000 || tables.rows.length>10000 || canonical(tables.rows.map(row=>row.relname).sort())!==canonical(expectedNames))throw new Error('Business destination table inventory differs from the reviewed snapshot');
    for(const [index,table] of plan.tables.entries())await verifyTable(client,schema,table,index);
    const after:BusinessSnapshotPlan=planBusinessSnapshot(snapshot,expectedAuthorityDigest,expectedPolicyDigest);
    if(canonical(after)!==canonical(plan))throw new Error('Business snapshot changed during verification');
    const boundary=(await client.query(`SELECT current_setting('eigos.verification_nonce',true) AS nonce,
      current_setting('transaction_read_only') AS read_only,current_setting('transaction_isolation') AS isolation`)).rows[0];
    if(client.getTransactionStatus()!=='T' || boundary?.nonce!==nonce || boundary?.read_only!=='on' || boundary?.isolation!=='repeatable read')throw new Error('Business verification transaction boundary was lost');
    await client.query('COMMIT');open=false;
    return {version:1 as const,status:'verified-at-snapshot' as const,transactionStartedAt:new Date(transactionStartedAt).toISOString(),sourceFileDigest:plan.fileDigest,schemaDigest:plan.schemaDigest,
      authorityDigest:plan.authority.digest,policyDigest:plan.policyDigest,tables:plan.tables.map(table=>({name:table.name,rows:table.rows,digest:table.digest})),runtimeActivated:false as const};
  } catch(error) {
    if(open)await client.query('ROLLBACK');
    throw error;
  }
}

async function verifyTable(client:Client,schema:string,table:BusinessTable,index:number):Promise<void> {
  const actual=await client.query(`SELECT a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relname=$2 AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,[schema,table.name]);
  const expected=table.columns.map(column=>({name:column.name,type:column.type==='INTEGER'?'bigint':column.type==='BLOB'?'bytea':'text',notNull:column.notNull || column.primaryKey>0}));
  if(canonical(actual.rows.map(row=>({name:row.attname,type:row.type,notNull:row.attnotnull})))!==canonical(expected))throw new Error(`Business destination columns differ in ${table.name}`);
  if(table.rows===0){
    const present=(await client.query(`SELECT EXISTS(SELECT 1 FROM ${quote(schema)}.${quote(table.name)}) AS present`)).rows[0]?.present;
    if(present!==false || table.digest!==createHash('sha256').digest('hex'))throw new Error(`Business readback mismatch in ${table.name}`);
    return;
  }
  const columns=table.columns,keys=columns.filter(column=>column.primaryKey>0).sort((a,b)=>a.primaryKey-b.primaryKey);
  const order=keys.map(column=>`source.${quote(column.name)}`+(column.type==='TEXT'?' COLLATE "C"':'')).join(',');
  const rawSize=columns.map(column=>`COALESCE(octet_length(source.${quote(column.name)}${column.type==='INTEGER'?'::text':''}),0)::bigint`).join('+');
  const bound=Math.max(1,table.maxRowBytes),predicate=`(${rawSize})<=${bound}`;
  const selected=columns.map(column=>`CASE WHEN bounded.allowed THEN source.${quote(column.name)} END`).join(',');
  const cursor=quote(`eigos_verify_${index}`),page=Math.max(1,Math.min(batchRows,Math.floor(batchBytes/bound)));
  await client.query(`DECLARE ${cursor} NO SCROLL CURSOR FOR SELECT ${selected},bounded.allowed FROM ${quote(schema)}.${quote(table.name)} AS source
    CROSS JOIN LATERAL (SELECT (${predicate}) AS allowed OFFSET 0) AS bounded ORDER BY ${order}`);
  const digest=createHash('sha256');let count=0;
  try {
    for(;;){
      const rows=(await client.query({text:`FETCH FORWARD ${page} FROM ${cursor}`,rowMode:'array'})).rows as unknown[][];
      if(!rows.length)break;
      for(const values of rows){
        if(values.length!==columns.length+1 || values[columns.length]!==true)throw new Error(`Business row exceeds its reviewed bound in ${table.name}`);
        const row=Object.fromEntries(columns.map((column,i)=>[column.name,values[i]]));
        const encoded=encodeBusinessRow(row,columns,'postgres');digest.update(`${Buffer.byteLength(encoded)}:`).update(encoded);count++;
        if(count>table.rows)throw new Error(`Business readback mismatch in ${table.name}`);
      }
    }
  } finally {await client.query(`CLOSE ${cursor}`);}
  if(count!==table.rows || digest.digest('hex')!==table.digest)throw new Error(`Business readback mismatch in ${table.name}`);
}
