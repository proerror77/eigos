import {createHash} from 'node:crypto';
import {postgresEligibilityReferenceSchema,type PostgresEligibilityReference,type PostgresEligibilityInspector,type PostgresEligibilityEgress} from './eligibility-reference.js';
import type { Client } from 'pg';
import { SecurityError } from '../security/errors.js';

const schemaPattern = /^eigos_business_[a-z0-9_]{1,40}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const active = new WeakSet<object>();
const contexts = new WeakMap<object, { schema: string; authorityDigest: string; readUntil:number;token:object;leases:Map<string,()=>Promise<{validUntil:number}|undefined>>;eligibilityInspector?:PostgresEligibilityInspector;eligibility:Map<string,Promise<void>>;eligibilityReferences:Map<string,PostgresEligibilityReference>;egressReferences:PostgresEligibilityReference[] }>();

/** An original-token inspector, never business/model/provider work. Lease
 * evidence is refreshed at the outer commit; fixed read deadlines stay fixed. */
export function postgresRequireLeaseAtCommit(client:Client,key:string,inspect:()=>Promise<{validUntil:number}|undefined>):void{
  const context=contexts.get(client);if(!context||!/^[a-f0-9]{64}$/.test(key))throw new Error('An original claim transaction is required');
  context.leases.set(key,inspect);
}

/** Qualification timestamps can be refreshed independently while the same
 * serializable business snapshot remains open. Fixed grants are still bounded
 * by readUntil; this path checks only server-captured original continuity. */
export function postgresCanInspectEligibility(client:Client):boolean{return !!contexts.get(client)?.eligibilityInspector;}
export async function postgresRequireCurrentEligibility(client:Client,input:PostgresEligibilityReference):Promise<void>{
  const context=contexts.get(client);if(!context?.eligibilityInspector)throw new Error('Independent eligibility inspection is required');
  const reference=postgresEligibilityReferenceSchema.parse(input),inspector=context.eligibilityInspector;
  const key=createHash('sha256').update('eligibility:'+JSON.stringify(reference)).digest('hex');
  const inspect=async()=>{const current=await inspector(structuredClone(reference));if(!Number.isSafeInteger(current.validUntil)||current.validUntil<=Date.now())throw new SecurityError('ACCESS_REVOKED');return current;};
  let checked=context.eligibility.get(key);
  if(!checked){checked=inspect().then(()=>{});context.eligibility.set(key,checked);context.eligibilityReferences.set(key,reference);context.leases.set(key,inspect);}
  await checked;
}

/** Reserve one request-owned connection before its first awaited command. */
export function reservePostgresTransactionClient(client:Client):()=>void{
  if(active.has(client))throw new Error('Nested PostgreSQL transactions are not supported');
  if(typeof client.getTransactionStatus!=='function'||client.getTransactionStatus()!=='I'||client.pipeline!==false)throw new Error('PostgreSQL transaction requires an idle, non-pipelined client');
  active.add(client);let released=false;
  return()=>{if(!released){released=true;active.delete(client);}};
}

/** Identity of this exact transaction, not just its schema or pooled client. */
export function postgresBusinessToken(client:Client):object {
  const context=contexts.get(client);
  if(!context)throw new Error('An active PostgreSQL business transaction is required');
  return context.token;
}

/** A protected read must remain authorized when the transaction returns,
 * including the network wait for COMMIT. This never extends a grant/lease. */
export function postgresConstrainReadDeadline(client:Client,validUntil:number):void {
  const context=contexts.get(client);
  if(!context)throw new Error('An active PostgreSQL business transaction is required');
  if(!Number.isSafeInteger(validUntil) || validUntil<=Date.now())throw new SecurityError('OUTPUT_NOT_ALLOWED');
  context.readUntil=Math.min(context.readUntil,validUntil);
}

/** Only valid while the caller owns the business transaction callback. */
export function postgresBusinessSchema(client: Client): string {
  const context = contexts.get(client);
  if (!context) throw new Error('An active PostgreSQL business transaction is required');
  return context.schema;
}

/** The descriptor digest captured before the transaction started. */
export function postgresBusinessAuthorityDigest(client: Client): string {
  const context = contexts.get(client);
  if (!context) throw new Error('An active PostgreSQL business transaction is required');
  return context.authorityDigest;
}

export interface PostgresRuntimeAuthority {
  id: string;
  revision: number;
  digest: string;
}

/** Serialize a PostgreSQL business mutation and fence it to the reviewed
 * authority. This primitive is not a Worker claim, an authorization grant or a
 * runtime adapter. Callers must check current task and permission fences inside
 * the same callback, and all business writers must use the same lock. The
 * client must be request-owned and every database operation must be awaited.
 * External side effects must not be performed inside the transaction. */
export async function postgresBusinessTransaction<T>(client: Client, schema: string, authority: PostgresRuntimeAuthority, action: (client: Client) => Promise<T>,options:{eligibilityInspector?:PostgresEligibilityInspector;prepareEligibilityAtEgress?:PostgresEligibilityEgress}={}): Promise<T> {
  if (!schemaPattern.test(schema) || !authority.id || !Number.isSafeInteger(authority.revision) || authority.revision < 1 || !digestPattern.test(authority.digest)) throw new Error('Invalid PostgreSQL business authority');
  const releaseClient=reservePostgresTransactionClient(client);
  const expected = { id: authority.id, revision: authority.revision, digest: authority.digest };
  let opened = false, beginning = false, committing = false;
  const discard = async () => {
    const pooled = client as Client & { release?: (error?: Error) => void };
    try { if (typeof pooled.release === 'function') pooled.release(new Error('Transaction state is uncertain')); else if (typeof client.end === 'function') await client.end(); } catch { /* connection is already unusable */ }
  };
  const assertAuthority = async () => {
    const result = await client.query(`SELECT id,revision,configuration_digest FROM "${schema}".eigos_lock_runtime_authority()`);
    const row = result.rows[0];
    if (result.rowCount !== 1 || row?.id !== expected.id || String(row?.revision) !== String(expected.revision) || row?.configuration_digest !== expected.digest) throw new Error('PostgreSQL business authority changed');
  };
  try {
    beginning=true;await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');beginning=false;opened = true;
    if (client.getTransactionStatus() !== 'T') { committing = true; throw new Error('PostgreSQL business transaction did not start'); }
    // LOCK is a utility statement: acquire serialization before the first MVCC
    // snapshot. A SELECT-based lock would retain facts from before the wait.
    await client.query(`LOCK TABLE "${schema}".eigos_business_mutex IN EXCLUSIVE MODE`);
    const transactionId = (await client.query('SELECT pg_catalog.pg_current_xact_id()::text AS id')).rows[0]?.id;
    if (typeof transactionId !== 'string' || !/^\d+$/.test(transactionId)) throw new Error('PostgreSQL transaction identity unavailable');
    const assertBoundary = async () => {
      const status = client.getTransactionStatus();
      if (status !== 'T') { committing = status !== 'E'; throw new Error('PostgreSQL business transaction boundary was lost'); }
      const current = (await client.query('SELECT pg_catalog.pg_current_xact_id()::text AS id')).rows[0]?.id;
      if (current !== transactionId) { committing = true; throw new Error('PostgreSQL business transaction identity changed'); }
    };
    await client.query(`SET LOCAL search_path TO pg_catalog, "${schema}", pg_temp`);
    await assertAuthority();
    await assertBoundary();
    await client.query('SAVEPOINT eigos_runtime_action_guard');
    const context={schema,authorityDigest:expected.digest,readUntil:Infinity,token:Object.freeze({}),leases:new Map<string,()=>Promise<{validUntil:number}|undefined>>(),eligibilityInspector:options.eligibilityInspector,eligibility:new Map<string,Promise<void>>(),eligibilityReferences:new Map<string,PostgresEligibilityReference>(),egressReferences:[] as PostgresEligibilityReference[]};
    contexts.set(client,context);
    let result: T;
    try {
      result = await action(client);
      const references=[...context.eligibilityReferences.values()];
      context.egressReferences=options.prepareEligibilityAtEgress?await options.prepareEligibilityAtEgress(client,references,context.token):references;
    }
    catch (error) {
      // Recover an aborted transaction only to verify that it is still the
      // original one. Missing savepoint or a changed transaction ID means an
      // earlier commit may have occurred, so the result is uncertain.
      try { await client.query('ROLLBACK TO SAVEPOINT eigos_runtime_action_guard'); }
      catch { committing = true; throw error; }
      await assertBoundary();
      throw error;
    } finally { contexts.delete(client); }
    await assertBoundary();
    await assertAuthority();
    await assertBoundary();
    let leaseUntil=Infinity;
    for(const inspect of context.leases.values()){
      const lease=await inspect();if(!lease||!Number.isSafeInteger(lease.validUntil)||lease.validUntil<=Date.now())throw new SecurityError('ACCESS_REVOKED');
      leaseUntil=Math.min(leaseUntil,lease.validUntil);
    }
    if(Math.min(context.readUntil,leaseUntil)<=Date.now())throw new SecurityError('OUTPUT_NOT_ALLOWED');
    committing = true; await client.query('COMMIT'); opened = false;committing=false;
    // The commit was acknowledged, so an expired response is a disclosure
    // denial, not an unknown commit. Mutation callers must retain their receipt.
    if(Math.min(context.readUntil,leaseUntil)<=Date.now())throw new SecurityError('OUTPUT_NOT_ALLOWED');
    // A reply can be held after the server commits. Recheck current continuity
    // before egress; trusted successor receipts select the actual NEW grant,
    // not the old grant intentionally revoked by this same committed command.
    let egressUntil=Infinity;
    if(options.eligibilityInspector)for(const reference of context.egressReferences){
      const current=await options.eligibilityInspector(reference);
      if(!Number.isSafeInteger(current.validUntil)||current.validUntil<=Date.now())throw new SecurityError('ACCESS_REVOKED');
      egressUntil=Math.min(egressUntil,current.validUntil);
    }
    if(Math.min(context.readUntil,leaseUntil,egressUntil)<=Date.now())throw new SecurityError('OUTPUT_NOT_ALLOWED');
    return result;
  } catch (error) {
    if(beginning){await discard();throw new Error('PostgreSQL business transaction start outcome is unknown; connection discarded',{cause:error});}
    if (opened && !committing) { try { await client.query('ROLLBACK'); } catch { await discard(); throw new Error('PostgreSQL business transaction rollback failed; connection discarded', { cause: error }); } }
    if (committing) { await discard(); throw new Error('PostgreSQL business transaction commit outcome is unknown; inspect the operation receipt before retrying', { cause: error }); }
    throw error;
  } finally { releaseClient(); }
}
