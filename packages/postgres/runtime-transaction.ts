import {stagedKernelComponents,type StagedKernelBuilder} from '../ontology/seed-definition.js';
import {createHash} from 'node:crypto';
import {postgresEligibilityReferenceSchema,type PostgresEligibilityReference,type PostgresEligibilityInspector,type PostgresEligibilityEgress} from './eligibility-reference.js';
import type { Client, QueryResult } from 'pg';
import { SecurityError } from '../security/errors.js';
import {postgresAuthorityWriteLockMode} from './authority-lock.js';
import {lockPostgresWriteScope,postgresWriteScope,tryPostgresOwnerWriteLock,type PostgresWriteScope} from './write-scope.js';

const schemaPattern = /^eigos_business_[a-z0-9_]{1,40}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const active = new WeakSet<object>();
const contexts = new WeakMap<object, { schema: string; authorityDigest: string; readUntil:number;token:object;readOnly:boolean;writeScope?:PostgresWriteScope;writeOwners:Set<string>;kernel?:StagedKernelBuilder;leases:Map<string,()=>Promise<{validUntil:number}|undefined>>;eligibilityInspector?:PostgresEligibilityInspector;eligibility:Map<string,Promise<void>>;eligibilityReferences:Map<string,PostgresEligibilityReference>;egressReferences:PostgresEligibilityReference[] }>();

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

/** The host-selected shared read fence for this exact active transaction.
 * Actor labels and a reused pooled connection cannot establish this mode. */
export function postgresBusinessReadOnly(client:Client,expectedToken:object):boolean{
  const context=contexts.get(client);
  if(!context||context.token!==expectedToken)throw new Error('The exact active PostgreSQL business transaction is required');
  return context.readOnly;
}

/** Owner-wide projections may not be smuggled into a task-only accounting or
 * release transaction. A lock scope never substitutes for data authorization. */
export function postgresRequireOwnerWrite(client:Client,owner:string):void{
  const context=contexts.get(client),scope=context?.writeScope;
  if(!context||context.readOnly||scope&&(scope.kind==='task'||scope.kind==='owner'&&scope.owner!==owner||scope.kind==='queue'&&!context.writeOwners.has(owner)))
    throw new SecurityError('AUTHORIZATION_REQUIRED');
}
/** Queue callers must never wait for an owner holding business projections.
 * No reservation is recorded unless the actual transaction lock was obtained. */
export async function postgresTryQueueOwner(client:Client,owner:string):Promise<boolean>{
  const context=contexts.get(client);if(!context||context.readOnly)throw new SecurityError('AUTHORIZATION_REQUIRED');
  if(!context.writeScope)return true; // Legacy globally exclusive fallback.
  if(context.writeScope.kind!=='queue')throw new SecurityError('AUTHORIZATION_REQUIRED');
  const locked=await tryPostgresOwnerWriteLock(client,context.schema,owner);
  if(contexts.get(client)!==context)throw new SecurityError('AUTHORIZATION_REQUIRED');
  if(locked)context.writeOwners.add(owner);return locked;
}
export function postgresForgetQueueOwner(client:Client,owner:string):void{
  const context=contexts.get(client);if(!context||context.readOnly||context.writeScope&&context.writeScope.kind!=='queue')throw new SecurityError('AUTHORIZATION_REQUIRED');
  context.writeOwners.delete(owner);
}

/** Host-only immutable compiler context. It grants no namespace, task, role,
 * source or output access. A captured reader must retain this exact token;
 * closed callbacks and reuse of the pooled client cannot lend a new kernel. */
export function postgresBusinessKernel(client:Client,expectedToken:object):StagedKernelBuilder|undefined{
  const context=contexts.get(client);
  if(!context||context.token!==expectedToken)throw new Error('The exact active PostgreSQL business transaction is required');
  return context.kernel;
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

export interface PostgresTransactionOptions {
  eligibilityInspector?: PostgresEligibilityInspector;
  prepareEligibilityAtEgress?: PostgresEligibilityEgress;
  eligibilityChecksRuntimeAuthority?: boolean;
  kernel?: StagedKernelBuilder;
  /** Host-selected query path. Only private cursor bookkeeping may write here. */
  access?: 'read' | 'write';
  /** Explicit audited writer, never inferred from a caller/model label. */
  writeScope?:PostgresWriteScope;
}

/** Serialize a PostgreSQL business mutation and fence it to the reviewed
 * authority. This primitive is not a Worker claim, an authorization grant or a
 * runtime adapter. Callers must check current task and permission fences inside
 * the same callback, and all business writers must use the same lock. The
 * client must be request-owned and every database operation must be awaited.
 * External side effects must not be performed inside the transaction. */
export async function postgresBusinessTransaction<T>(client: Client, schema: string, authority: PostgresRuntimeAuthority, action: (client: Client) => Promise<T>,options:PostgresTransactionOptions={}): Promise<T> {
  if (!schemaPattern.test(schema) || !authority.id || !Number.isSafeInteger(authority.revision) || authority.revision < 1 || !digestPattern.test(authority.digest)) throw new Error('Invalid PostgreSQL business authority');
  if (options.access !== undefined && options.access !== 'read' && options.access !== 'write') throw new Error('Invalid PostgreSQL transaction access');
  const reading = options.access === 'read';
  const writeScope=options.writeScope===undefined?undefined:postgresWriteScope(options.writeScope);
  if(reading&&writeScope)throw new Error('A read transaction cannot acquire a business write scope');
  const kernel=options.kernel;if(kernel!==undefined)stagedKernelComponents(kernel);
  const releaseClient=reservePostgresTransactionClient(client);
  const expected = { id: authority.id, revision: authority.revision, digest: authority.digest };
  let opened = false, beginning = false, committing = false;
  const discard = async () => {
    const pooled = client as Client & { release?: (error?: Error) => void };
    try { if (typeof pooled.release === 'function') pooled.release(new Error('Transaction state is uncertain')); else if (typeof client.end === 'function') await client.end(); } catch { /* connection is already unusable */ }
  };
  const authorityFunction = reading ? 'eigos_current_runtime_authority' : 'eigos_lock_runtime_authority';
  const authorityQuery = `SELECT id,revision,configuration_digest FROM "${schema}".${authorityFunction}()`;
  const identityQuery = 'SELECT pg_catalog.pg_current_xact_id()::text AS id';
  const readFenceQuery = `SELECT fence.*, x.transaction_id FROM (SELECT pg_catalog.pg_current_xact_id()::text AS transaction_id) x LEFT JOIN LATERAL (${authorityQuery}) fence ON TRUE`;
  const searchPath = `SET LOCAL search_path TO pg_catalog, "${schema}", pg_temp`;
  const savepoint = 'SAVEPOINT eigos_runtime_action_guard';
  const checkAuthority = (result: QueryResult) => {
    const row = result.rows[0];
    if (result.rowCount !== 1 || row?.id !== expected.id || String(row?.revision) !== String(expected.revision) || row?.configuration_digest !== expected.digest) throw new Error('PostgreSQL business authority changed');
  };
  let transactionId: unknown;
  const checkStatus = () => {
    const status = client.getTransactionStatus();
    if (status !== 'T') { committing = status !== 'E'; throw new Error('PostgreSQL business transaction boundary was lost'); }
  };
  const checkIdentity = (actual: unknown) => {
    if (actual !== transactionId) { committing = true; throw new Error('PostgreSQL business transaction identity changed'); }
  };
  const assertBoundary = async () => {
    checkStatus();
    checkIdentity((await client.query(identityQuery)).rows[0]?.id);
  };
  try {
    beginning = true;
    if (reading) {
      // The driver uses the simple protocol for this fixed, parameter-free
      // batch. LOCK still precedes the first MVCC snapshot and no callback
      // starts until PostgreSQL acknowledges the fence and the savepoint.
      const statements = ['BEGIN ISOLATION LEVEL READ COMMITTED',
        `LOCK TABLE "${schema}".eigos_business_mutex IN SHARE MODE`, searchPath, readFenceQuery, savepoint];
      const results: unknown = await client.query(statements.join('; '));
      beginning = false;
      opened = true;
      checkStatus();
      if (!Array.isArray(results) || results.length !== statements.length) {
        committing = true;
        throw new Error('PostgreSQL read transaction setup acknowledgement is incomplete');
      }
      checkAuthority(results[3] as QueryResult);
      transactionId = results[3].rows[0]?.transaction_id;
    } else {
      await client.query(writeScope ? 'BEGIN ISOLATION LEVEL READ COMMITTED' : 'BEGIN ISOLATION LEVEL SERIALIZABLE');
      beginning = false;
      opened = true;
      checkStatus();
      if (writeScope) await lockPostgresWriteScope(client, schema, writeScope);
      // Scoped writers share the table with other scoped writers, and still
      // conflict with every read and with legacy globally fenced mutations.
      await client.query(`LOCK TABLE "${schema}".eigos_business_mutex IN ${writeScope ? 'ROW EXCLUSIVE' : 'EXCLUSIVE'} MODE`);
      if (writeScope && await postgresAuthorityWriteLockMode(client, schema) !== 'share') {
        throw new Error('Concurrent write authority lock has not been installed');
      }
      transactionId = (await client.query(identityQuery)).rows[0]?.id;
      if (typeof transactionId !== 'string' || !/^\d+$/.test(transactionId)) throw new Error('PostgreSQL transaction identity unavailable');
      await client.query(searchPath);
      checkAuthority(await client.query(authorityQuery));
      await assertBoundary();
      if (writeScope?.kind === 'task') {
        await client.query(`SELECT id FROM "${schema}".jobs WHERE owner=$1 AND id=$2 FOR UPDATE`, [writeScope.owner, writeScope.taskId]);
      }
      await client.query(savepoint);
    }
    if (typeof transactionId !== 'string' || !/^\d+$/.test(transactionId)) throw new Error('PostgreSQL transaction identity unavailable');
    const context={schema,authorityDigest:expected.digest,readUntil:Infinity,token:Object.freeze({}),readOnly:reading,writeScope,writeOwners:new Set<string>(),kernel,leases:new Map<string,()=>Promise<{validUntil:number}|undefined>>(),eligibilityInspector:options.eligibilityInspector,eligibility:new Map<string,Promise<void>>(),eligibilityReferences:new Map<string,PostgresEligibilityReference>(),egressReferences:[] as PostgresEligibilityReference[]};
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
    if (reading) {
      checkStatus();
      const fence = await client.query(readFenceQuery);
      if (fence.rows.length) checkIdentity(fence.rows[0].transaction_id);
      checkAuthority(fence);
      checkStatus();
    } else {
      await assertBoundary();
      checkAuthority(await client.query(authorityQuery));
      await assertBoundary();
    }
    let leaseUntil=Infinity;
    for(const inspect of context.leases.values()){
      const lease=await inspect();if(!lease||!Number.isSafeInteger(lease.validUntil)||lease.validUntil<=Date.now())throw new SecurityError('ACCESS_REVOKED');
      leaseUntil=Math.min(leaseUntil,lease.validUntil);
    }
    if(Math.min(context.readUntil,leaseUntil)<=Date.now())throw new SecurityError('OUTPUT_NOT_ALLOWED');
    committing = true; await client.query('COMMIT'); opened = false;committing=false;
    // A query does not lock the singleton authority row. Check a fresh snapshot
    // after commit as well, including administrative changes outside the fence.
    if (reading && !(options.eligibilityChecksRuntimeAuthority && context.egressReferences.length && options.eligibilityInspector)) {
      checkAuthority(await client.query(authorityQuery));
    }
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
    if(beginning && reading && client.getTransactionStatus() === 'E') { beginning=false; opened=true; }
    if(beginning){await discard();throw new Error('PostgreSQL business transaction start outcome is unknown; connection discarded',{cause:error});}
    if (opened && !committing) { try { await client.query('ROLLBACK'); } catch { await discard(); throw new Error('PostgreSQL business transaction rollback failed; connection discarded', { cause: error }); } }
    if (committing) { await discard(); throw new Error('PostgreSQL business transaction commit outcome is unknown; inspect the operation receipt before retrying', { cause: error }); }
    throw error;
  } finally { releaseClient(); }
}
