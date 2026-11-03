import {postgresConsentDeadline} from './consent.js';
import type {Pool} from 'pg';
import {digest} from '../core/delegation.js';
import {agentAccessGrantSchema,taskDataGrantSchema} from '../security/contracts.js';
import {SecurityError} from '../security/errors.js';
import {postgresEligibilityReferenceSchema,type PostgresEligibilityReference} from './eligibility-reference.js';
import {reservePostgresTransactionClient,type PostgresRuntimeAuthority} from './runtime-transaction.js';

type Watch={failure?:SecurityError;evict?:()=>void};
type Row=Record<string,unknown>;
const unavailable=(cause?:unknown)=>{const error=new SecurityError('AUTHORITY_UNAVAILABLE');if(cause!==undefined)error.cause=cause;return error;};
const changed=(cause?:unknown)=>{const error=new SecurityError('POLICY_CHANGED');if(cause!==undefined)error.cause=cause;return error;};
const until=(value:unknown):number=>{const result=Number(value);if(!Number.isSafeInteger(result))throw changed();return result;};
const limited=(field:string,max=2000)=>`CASE WHEN octet_length(${field})<=${max} THEN ${field} END`;

function query(schema:string){
  const q=`"${schema}"`;
  const grant=(alias:'g'|'d',prefix:'parent'|'data')=>`${alias}.id AS ${prefix}_id,${limited(`${alias}.kind`,100)} AS ${prefix}_kind,${limited(`${alias}.owner`,8000)} AS ${prefix}_owner,
    ${limited(`${alias}.member_id`,100)} AS ${prefix}_member,${limited(`${alias}.installation_id`,100)} AS ${prefix}_installation,
    ${alias}.revision AS ${prefix}_revision,${limited(`${alias}.state`,100)} AS ${prefix}_state,${alias}.expires_at AS ${prefix}_until,
    CASE WHEN octet_length(${alias}.body)<=1048576 THEN ${alias}.body END AS ${prefix}_body`;
  return `SELECT ${limited('r.id',8000)} AS runtime_id,r.revision AS runtime_revision,${limited('r.configuration_digest',64)} AS runtime_digest,
    cfg.version AS configuration_version,${limited('cfg.mode',100)} AS configuration_mode,p.revision AS policy_revision,${limited('pd.digest',64)} AS policy_digest,
    ${limited('m.token')} AS manager_token,m.expires_at AS manager_until,
    s.installation_id,${limited('s.owner',8000)} AS subject_owner,${limited('s.member_id',100)} AS subject_member,${limited('s.client_id',8000)} AS subject_client,
    s.epoch,${limited('s.state',100)} AS subject_state,s.valid_until AS subject_until,
    EXISTS(SELECT 1 FROM ${q}.security_fences f WHERE f.owner=s.owner AND f.state<>'cleared'
      AND((f.kind='member' AND f.target_id=s.member_id) OR(f.kind='connection' AND f.target_id=s.client_id) OR(f.kind='installation' AND f.target_id=s.installation_id))) AS fenced,
    ${grant('g','parent')},${grant('d','data')},${limited('d.parent_id',100)} AS data_parent_id,d.parent_revision AS data_parent_revision
    FROM(VALUES(1)) AS singleton(slot)
    LEFT JOIN ${q}.security_settings cfg ON cfg.slot=singleton.slot
    LEFT JOIN ${q}.security_policy p ON p.slot=singleton.slot
    LEFT JOIN ${q}.security_policy_definitions pd ON pd.slot=singleton.slot
    LEFT JOIN ${q}.security_manager m ON m.slot=singleton.slot
    LEFT JOIN LATERAL ${q}.eigos_current_runtime_authority() r ON TRUE
    LEFT JOIN ${q}.security_subjects s ON s.installation_id=$1
    LEFT JOIN ${q}.security_grants g ON g.id=$2
    LEFT JOIN ${q}.security_grants d ON d.id=$3::text LIMIT 2`;
}

function parse(row:Row,runtime:PostgresRuntimeAuthority,reference:PostgresEligibilityReference){
  if(row.runtime_id!==runtime.id||Number(row.runtime_revision)!==runtime.revision||row.runtime_digest!==runtime.digest
    ||Number(row.configuration_version)!==2||row.configuration_mode!=='foundation'
    ||Number(row.policy_revision)!==reference.policyRevision||row.policy_digest!==reference.policyDigest
    ||typeof row.manager_token!=='string'||!row.manager_token||digest(row.manager_token)!==reference.managerTokenDigest)throw unavailable();
  const managerUntil=Number(row.manager_until);
  if(!Number.isSafeInteger(managerUntil)||managerUntil<=Date.now())throw unavailable();
  if(row.installation_id!==reference.installationId||row.subject_state!=='active'||row.fenced!==false)throw new SecurityError('ACCESS_REVOKED');
  if(row.subject_owner!==reference.ownerKey||row.subject_member!==reference.memberId||row.subject_client!==reference.clientId||Number(row.epoch)!==reference.authEpoch)throw changed();
  const subjectUntil=until(row.subject_until);if(subjectUntil<=Date.now())throw new SecurityError('ACCESS_REVOKED');
  const parentUntil=until(row.parent_until);
  if(row.parent_id===null||row.parent_id===undefined||row.parent_state!=='active'||parentUntil<=Date.now())throw new SecurityError('ACCESS_REVOKED');
  if(row.parent_id!==reference.parentGrant.id||row.parent_kind!=='agent_access'||row.parent_owner!==reference.ownerKey||row.parent_member!==reference.memberId
    ||row.parent_installation!==reference.installationId||Number(row.parent_revision)!==reference.parentGrant.revision||typeof row.parent_body!=='string')throw changed();
  let parent:ReturnType<typeof agentAccessGrantSchema.parse>;
  try{parent=agentAccessGrantSchema.parse({...JSON.parse(row.parent_body),revision:Number(row.parent_revision),status:row.parent_state});}catch(error){throw changed(error);}
  if(parent.id!==reference.parentGrant.id||parent.ownerKey!==reference.ownerKey||parent.memberId!==reference.memberId||parent.installationId!==reference.installationId
    ||digest(parent)!==reference.parentGrant.bodyDigest)throw changed();
  let fixedUntil=Math.min(parentUntil,postgresConsentDeadline(parent.expiresAt,reference.policyDigest));
  if(reference.taskGrant){
    const pinned=reference.taskGrant,dataUntil=until(row.data_until);
    if(row.data_id===null||row.data_id===undefined||row.data_state!=='active'||dataUntil<=Date.now())throw new SecurityError('ACCESS_REVOKED');
    if(row.data_id!==pinned.id||row.data_kind!=='task_data'||row.data_owner!==reference.ownerKey||row.data_member!==reference.memberId||row.data_installation!==reference.installationId
      ||Number(row.data_revision)!==pinned.revision||row.data_parent_id!==parent.id||Number(row.data_parent_revision)!==parent.revision||typeof row.data_body!=='string')throw changed();
    let data:ReturnType<typeof taskDataGrantSchema.parse>;
    try{data=taskDataGrantSchema.parse({...JSON.parse(row.data_body),revision:Number(row.data_revision),status:row.data_state});}catch(error){throw changed(error);}
    if(data.id!==pinned.id||data.ownerKey!==reference.ownerKey||data.memberId!==reference.memberId||data.installationId!==reference.installationId
      ||data.parentGrant.id!==parent.id||data.parentGrant.revision!==parent.revision||data.taskId!==pinned.taskId||data.requestRevision!==pinned.requestRevision||digest(data)!==pinned.bodyDigest)throw changed();
    fixedUntil=Math.min(fixedUntil,dataUntil,postgresConsentDeadline(data.expiresAt,reference.policyDigest));
  }
  const validUntil=Math.min(managerUntil,subjectUntil,fixedUntil);
  const current=()=>{
    if(managerUntil<=Date.now())throw unavailable();
    if(subjectUntil<=Date.now()||fixedUntil<=Date.now())throw new SecurityError('ACCESS_REVOKED');
  };
  current();return {validUntil,current};
}

/** Inspect current renewable qualification under the SAME original manager.
 * This is not permission issuance, a Worker claim or a role/request check.
 * The caller retains its captured fixed authority/role/claim deadlines and
 * original-task checks. No database row is renewed or changed here. */
export function postgresInspectEligibility(pool:Pick<Pool,'connect'>,schema:string,runtime:PostgresRuntimeAuthority,reference:PostgresEligibilityReference):Promise<{validUntil:number}>{
  if(!/^eigos_business_[a-z0-9_]{1,40}$/.test(schema)||typeof runtime.id!=='string'||!runtime.id||runtime.id.length>2000
    ||!Number.isSafeInteger(runtime.revision)||runtime.revision<1||!/^[a-f0-9]{64}$/.test(runtime.digest))return Promise.reject(new Error('Invalid PostgreSQL eligibility configuration'));
  let captured:PostgresEligibilityReference;
  try{captured=postgresEligibilityReferenceSchema.parse(reference);}catch(error){return Promise.reject(changed(error));}
  const expected=Object.freeze(structuredClone(runtime)),watch:Watch={};let timer:ReturnType<typeof setTimeout>;
  const timeout=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{
    watch.failure=unavailable(new Error('PostgreSQL eligibility acknowledgement timed out after 10000 ms'));
    reject(watch.failure);watch.evict?.();
  },10000);timer.unref();});
  return Promise.race([inspect(pool,schema,expected,captured,watch),timeout]).catch(error=>{if(error instanceof SecurityError)throw error;throw unavailable(error);}).finally(()=>clearTimeout(timer));
}

async function inspect(pool:Pick<Pool,'connect'>,schema:string,runtime:PostgresRuntimeAuthority,reference:PostgresEligibilityReference,watch:Watch):Promise<{validUntil:number}>{
  const client=await pool.connect(),release=client.release.bind(client);let released=false,opened=false,beginning=false,committing=false,unreserve:(()=>void)|undefined;
  const releaseOnce=(error?:Error)=>{if(!released){released=true;release(error);}};
  const evict=()=>{try{releaseOnce(new Error('Eligibility inspection transaction state is uncertain'));}catch{/* already disconnected */}};
  const observing=()=>{if(watch.failure)throw watch.failure;};watch.evict=evict;
  try{
    observing();try{unreserve=reservePostgresTransactionClient(client);}catch(error){evict();throw unavailable(error);}
    beginning=true;await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');beginning=false;opened=true;observing();
    if(client.getTransactionStatus()!=='T'){evict();opened=false;throw unavailable(new Error('Eligibility read transaction did not start'));}
    await client.query(`SET LOCAL search_path TO pg_catalog, "${schema}", pg_temp; SET LOCAL statement_timeout='10000ms'; SET LOCAL lock_timeout='5000ms'; SET LOCAL idle_in_transaction_session_timeout='10000ms'`);observing();
    const rows=await client.query(query(schema),[reference.installationId,reference.parentGrant.id,reference.taskGrant?.id??null]);observing();
    if(rows.rowCount!==1)throw unavailable();const value=parse(rows.rows[0],runtime,reference);
    if(client.getTransactionStatus()!=='T'){evict();opened=false;throw unavailable(new Error('Eligibility inspection transaction boundary was lost'));}
    value.current();committing=true;await client.query('COMMIT');opened=false;committing=false;observing();value.current();
    return {validUntil:value.validUntil};
  }catch(error){
    if(watch.failure){evict();throw watch.failure;}
    if(beginning||committing){evict();throw unavailable(new Error(`Eligibility inspection ${beginning?'BEGIN':'COMMIT'} acknowledgement is uncertain; connection discarded`,{cause:error}));}
    if(opened){try{await client.query('ROLLBACK');observing();}catch{evict();if(watch.failure)throw watch.failure;throw unavailable(new Error('Eligibility inspection rollback failed',{cause:error}));}}
    if(error instanceof SecurityError)throw error;throw unavailable(error);
  }finally{watch.evict=undefined;unreserve?.();releaseOnce();}
}
