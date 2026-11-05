import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Client } from 'pg';
import { canonical } from '../core/delegation.js';
import { planBusinessSnapshot, type BusinessSnapshotPlan, type BusinessTable } from './business-snapshot.js';
import { compileBusinessSchema } from './business-schema.js';
import {postgresBusinessMutexValid} from './authority-lock.js';

const schemaPattern=/^eigos_business_[a-z0-9_]{1,40}$/;
const digestPattern=/^[a-f0-9]{64}$/;
const quote=(value:string)=>`"${value.replaceAll('"','""')}"`;

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
  const sqlite=new DatabaseSync(snapshot,{readOnly:true});
  let identities:ReturnType<typeof compileBusinessSchema>['identities'];
  try {sqlite.exec('PRAGMA query_only=ON; BEGIN');identities=compileBusinessSchema(sqlite).identities;}
  finally {sqlite.close();}
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
    const expectedNames=[...plan.tables.map(table=>table.name),'eigos_migration_receipt','eigos_business_mutex'].sort();
    if(expectedNames.length>10000 || tables.rows.length>10000 || canonical(tables.rows.map(row=>row.relname).sort())!==canonical(expectedNames))throw new Error('Business destination table inventory differs from the reviewed snapshot');
    if(!await postgresBusinessMutexValid(client,schema))throw new Error('Business destination serialization relation differs from the reviewed contract');
    for(const table of plan.tables)await verifyTable(client,schema,table);
    const sequences=await verifySequences(client,schema,plan,identities);
    const after:BusinessSnapshotPlan=planBusinessSnapshot(snapshot,expectedAuthorityDigest,expectedPolicyDigest);
    if(canonical(after)!==canonical(plan))throw new Error('Business snapshot changed during verification');
    const boundary=(await client.query(`SELECT current_setting('eigos.verification_nonce',true) AS nonce,
      current_setting('transaction_read_only') AS read_only,current_setting('transaction_isolation') AS isolation`)).rows[0];
    if(client.getTransactionStatus()!=='T' || boundary?.nonce!==nonce || boundary?.read_only!=='on' || boundary?.isolation!=='repeatable read')throw new Error('Business verification transaction boundary was lost');
    await client.query('COMMIT');open=false;
    return {version:1 as const,status:'verified-at-snapshot' as const,transactionStartedAt:new Date(transactionStartedAt).toISOString(),sourceFileDigest:plan.fileDigest,schemaDigest:plan.schemaDigest,
      authorityDigest:plan.authority.digest,policyDigest:plan.policyDigest,tables:plan.tables.map(table=>({name:table.name,rows:table.rows,digest:table.digest})),
      sequenceObservation:sequences,writerFenceVerified:false as const,runtimeActivated:false as const};
  } catch(error) {
    if(open)await client.query('ROLLBACK');
    throw error;
  }
}

/** Sequence values are not governed by the row snapshot and can change at any
 * time. An operator must separately fence all writers before using this result. */
export async function verifySequences(client:Client,schema:string,plan:BusinessSnapshotPlan,identities:ReturnType<typeof compileBusinessSchema>['identities']) {
  const byTable=new Map(plan.tables.map(table=>[table.name,table])),sourceSequence=new Map(plan.sequences.map(sequence=>[sequence.table,BigInt(sequence.lastValue)]));
  const expected=plan.tables.map(table=>({table:table.name,column:'__eigos_rowid',identity:'a',minimum:[BigInt(table.maxRowid??'0'),sourceSequence.get(table.name)??0n].reduce((a,b)=>a>b?a:b)}));
  for(const identity of identities){
    const table=byTable.get(identity.table);if(!table || table.maxIntegerPrimaryKey===undefined)throw new Error('Business sequence source is unavailable');
    const high=identity.usesSqliteSequence?sourceSequence.get(identity.table)??0n:0n;
    expected.push({table:identity.table,column:identity.column,identity:'d',minimum:[BigInt(table.maxIntegerPrimaryKey??'0'),high].reduce((a,b)=>a>b?a:b)});
  }
  if(expected.length>20000)throw new Error('Business sequence inventory exceeds its bound');
  const rows=await client.query(`WITH input AS (SELECT table_name,column_name,ord FROM unnest($2::text[],$3::text[]) WITH ORDINALITY AS x(table_name,column_name,ord)),
    resolved AS (SELECT *,pg_catalog.pg_get_serial_sequence(pg_catalog.format('%I.%I',$1::text,table_name),column_name)::regclass AS sequence_oid FROM input)
    SELECT r.ord,a.attidentity,c.relkind,c.relpersistence,s.seqincrement::text AS increment,s.seqmin::text AS minimum,
      s.seqmax::text AS maximum,s.seqcache::text AS cache,s.seqcycle,pg_catalog.has_sequence_privilege(c.oid,'SELECT') AS readable,
      v.last_value::text AS last_value,pg_catalog.pg_is_in_recovery() AS standby
    FROM resolved r LEFT JOIN pg_catalog.pg_class t ON t.relname=r.table_name AND t.relnamespace=($1::text)::regnamespace
    LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attname=r.column_name AND NOT a.attisdropped
    LEFT JOIN pg_catalog.pg_class c ON c.oid=r.sequence_oid LEFT JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_catalog.pg_sequence s ON s.seqrelid=c.oid LEFT JOIN pg_catalog.pg_sequences v ON v.schemaname=n.nspname AND v.sequencename=c.relname
    ORDER BY r.ord`,[schema,expected.map(x=>x.table),expected.map(x=>x.column)]);
  if(rows.rows.length!==expected.length)throw new Error('Business sequence inventory differs from the reviewed snapshot');
  for(const [i,row] of rows.rows.entries()){
    const item=expected[i]!;
    if(row.attidentity!==item.identity || row.relkind!=='S' || row.relpersistence!=='p' || row.increment!=='1' || row.minimum!=='1'
      || row.maximum!=='9223372036854775807' || row.cache!=='1' || row.seqcycle!==false || row.readable!==true || row.standby!==false)
      throw new Error(`Business sequence configuration or read privilege differs in ${item.table}`);
    const last=row.last_value===null?null:typeof row.last_value==='string' && /^\d+$/.test(row.last_value)?BigInt(row.last_value):undefined;
    if(last===undefined || last===null && item.minimum>0n || last!==null && (last<item.minimum || last>=9223372036854775807n))
      throw new Error(`Business sequence high-water mark differs in ${item.table}`);
  }
  return {checked:expected.length,atomicWithRows:false as const};
}

export async function verifyTable(client:Client,schema:string,table:BusinessTable):Promise<void> {
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
  const fields=columns.map(column=>{
    const value=`source.${quote(column.name)}`;
    const raw=column.type==='BLOB'?value:`pg_catalog.convert_to(${value}::text,'UTF8')`;
    return `(CASE WHEN ${value} IS NULL THEN '0'::bytea ELSE '1'::bytea || pg_catalog.sha256(${raw}) END)`;
  }).join(' || ');
  // Recompute the proof from the actual target rows. Only the table checksum
  // crosses the network, including for historical rows larger than a batch.
  const result=await client.query(`WITH checked AS (
    SELECT pg_catalog.row_number() OVER (ORDER BY ${order}) AS ordinal,
      CASE WHEN (${rawSize})<=$2 THEN pg_catalog.sha256(${fields}) END AS row_hash
    FROM ${quote(schema)}.${quote(table.name)} AS source ORDER BY ${order} LIMIT $1
  )
  SELECT count(*)::text AS rows, coalesce(bool_and(row_hash IS NOT NULL),true) AS bounded,
    pg_catalog.encode(pg_catalog.sha256(coalesce(pg_catalog.string_agg(row_hash,''::bytea ORDER BY ordinal),''::bytea)),'hex') AS digest
  FROM checked`,[table.rows+1,Math.max(1,table.maxRowBytes)]);
  const proof=result.rows[0];
  if(proof?.bounded!==true)throw new Error(`Business row exceeds its reviewed bound in ${table.name}`);
  if(proof.rows!==String(table.rows)||proof.digest!==table.contentDigest)throw new Error(`Business readback mismatch in ${table.name}`);
}
