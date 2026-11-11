import {observePostgresClient} from './client-errors.js';
import {postgresEligibilityAtEgress} from './task-grants.js';
import {postgresInspectEligibility} from './eligibility-inspection.js';
import type {PostgresEligibilityReference} from './eligibility-reference.js';
import {postgresCaptureClaim,type PostgresWorkReference} from './work-claim.js';
import type { Client, Pool } from 'pg';
import { postgresBusinessTransaction, type PostgresRuntimeAuthority } from './runtime-transaction.js';
import {postgresRenewWorkerLease,postgresInspectWorkerLease} from './lease-renewal.js';
import type {WorkClaim} from '../core/store.js';
import {postgresCleanupReleasedClaims} from './claim-release.js';
import {stagedKernelComponents,type StagedKernelBuilder} from '../ontology/seed-definition.js';
import {postgresWorkAvailable} from './work-availability.js';
import {registerPostgresConsentKernel} from './consent.js';
import {withPostgresVectorFeature} from './embedding-index.js';
import {postgresVectorFeatureSchema,type PostgresVectorFeature} from './embedding-schema.js';
import {postgresAuthorityWriteLockMode} from './authority-lock.js';
import {postgresWriteScope,type PostgresWriteScope} from './write-scope.js';

/** Owns the runtime's connection pool, not a second business authority. Each
 * operation gets one client and one fenced transaction. No implicit retries. */
export class PostgresDatabase {
  private readonly authority:PostgresRuntimeAuthority;
  private readonly kernel:StagedKernelBuilder|undefined;
  private readonly vectorFeature:PostgresVectorFeature|undefined;
  private closing?:Promise<void>;
  get taskVectorFeature(){return this.vectorFeature?structuredClone(this.vectorFeature):undefined;}
  private readonly leasePool:Pick<Pool,'connect'|'end'>|undefined;
  private readonly eligibilityPool:Pick<Pool,'connect'|'end'>|undefined;
  constructor(private readonly pool:Pick<Pool,'connect'|'end'>,private readonly schema:string,authority:PostgresRuntimeAuthority,options:{leasePool?:Pick<Pool,'connect'|'end'>;eligibilityPool?:Pick<Pool,'connect'|'end'>;kernel?:StagedKernelBuilder;vectorFeature?:PostgresVectorFeature}={}) {
    if(!/^eigos_business_[a-z0-9_]{1,40}$/.test(schema) || typeof authority.id!=='string' || !authority.id
      || !Number.isSafeInteger(authority.revision) || authority.revision<1 || !/^[a-f0-9]{64}$/.test(authority.digest))throw new Error('Invalid PostgreSQL runtime configuration');
    if(options.kernel!==undefined){stagedKernelComponents(options.kernel);registerPostgresConsentKernel(options.kernel);}this.kernel=options.kernel;
    this.authority=Object.freeze(structuredClone(authority));
    if(options.vectorFeature){const feature=postgresVectorFeatureSchema.parse(options.vectorFeature);if(feature.businessSchema!==schema||feature.authority.id!==authority.id||feature.authority.revision!==authority.revision||feature.authority.digest!==authority.digest)throw new Error('Vector feature belongs to a different business authority');this.vectorFeature=feature;}
    if(options.leasePool===pool)throw new Error('Worker heartbeats require a separate connection pool');
    this.leasePool=options.leasePool;this.eligibilityPool=options.eligibilityPool??options.leasePool;
    if(this.eligibilityPool===pool)throw new Error('Current eligibility requires independent connection capacity');
  }
  private async use<T>(pool:Pick<Pool,'connect'|'end'>,action:(client:Client)=>Promise<T>):Promise<T>{
    if(this.closing)throw new Error('PostgreSQL runtime is closing');
    const client=await pool.connect(),release=client.release.bind(client);
    if(this.closing){release();throw new Error('PostgreSQL runtime is closing');}
    let connection:ReturnType<typeof observePostgresClient>|undefined;let released=false;
    // The transaction helper may evict an uncertain connection itself. The
    // request owner must not release that lease twice or return it to the pool.
    const releaseOnce=(error?:Error|boolean)=>{if(!released){released=true;release(error);}};
    client.release=releaseOnce;
    try{
      // This class owns the pool lease. Lower-level transaction helpers must
      // preserve a direct caller's already-owned/manual transaction on reject.
      if(typeof client.getTransactionStatus!=='function'||client.getTransactionStatus()!=='I'||client.pipeline!==false){releaseOnce(new Error('Pool returned a non-idle PostgreSQL client'));throw new Error('PostgreSQL pool lease requires an idle non-pipelined client');}
      try{connection=observePostgresClient(client);}catch(error){releaseOnce(new Error('Pool client cannot observe PostgreSQL connection errors'));throw error;}
      const result=await action(client);connection.check();return result;
    }
    catch(error){throw connection?.annotate(error)??error;}
    finally{try{releaseOnce(connection?.failure);}finally{connection?.close();}}
  }
  run<T>(action:(client:Client)=>Promise<T>):Promise<T>{
    return this.transaction(action, 'write');
  }
  /** Audited owner-owned business state, including shared projections. */
  runOwner<T>(owner:string,action:(client:Client)=>Promise<T>):Promise<T>{return this.scopedWrite({kind:'owner',owner},action);}
  /** Only original-task accounting/claim changes; graph writes are prohibited. */
  runTask<T>(owner:string,taskId:string,action:(client:Client)=>Promise<T>):Promise<T>{return this.scopedWrite({kind:'task',owner,taskId},action);}
  /** Queue capacity allocation. Candidates must try-lock their owner and row. */
  runQueue<T>(action:(client:Client)=>Promise<T>):Promise<T>{return this.scopedWrite({kind:'queue'},action);}
  private scopedWrite<T>(input:PostgresWriteScope,action:(client:Client)=>Promise<T>):Promise<T>{
    const scope=postgresWriteScope(input),eligibilityInspector=this.eligibilityPool?(reference:PostgresEligibilityReference)=>postgresInspectEligibility(this.eligibilityPool!,this.schema,this.authority,reference):undefined;
    return this.use(this.pool,async client=>{
      // Choosing the compatible legacy path happens before the callback or any
      // business transaction. Unknown commits/errors are never retried.
      const shared=await postgresAuthorityWriteLockMode(client,this.schema)==='share';
      return postgresBusinessTransaction(client,this.schema,this.authority,c=>this.vectorFeature?withPostgresVectorFeature(c,this.vectorFeature,()=>action(c)):action(c),
        {eligibilityInspector,prepareEligibilityAtEgress:eligibilityInspector?postgresEligibilityAtEgress:undefined,kernel:this.kernel,access:'write',...(shared?{writeScope:scope}:{})});
    });
  }
  /** Concurrent object/Function reads with the existing per-request fences.
   * Callbacks may persist their own pagination cursors, but no business edits. */
  read<T>(action:(client:Client)=>Promise<T>):Promise<T>{
    return this.transaction(action, 'read');
  }
  private transaction<T>(action:(client:Client)=>Promise<T>,access:'read'|'write'):Promise<T>{
    const eligibilityInspector=this.eligibilityPool?(reference:PostgresEligibilityReference)=>postgresInspectEligibility(this.eligibilityPool!,this.schema,this.authority,reference,{batch:access==='read'}):undefined;
    return this.use(this.pool,client=>postgresBusinessTransaction(client,this.schema,this.authority,c=>this.vectorFeature?withPostgresVectorFeature(c,this.vectorFeature,()=>action(c)):action(c),{eligibilityInspector,prepareEligibilityAtEgress:eligibilityInspector?postgresEligibilityAtEgress:undefined,kernel:this.kernel,access,eligibilityChecksRuntimeAuthority:access==='read'}));
  }
  renewClaim(claim:WorkClaim,leaseMs:number,policy:string):Promise<boolean>{
    if(!this.leasePool)throw new Error('PostgreSQL Worker requires a dedicated heartbeat pool');
    const fence=postgresCaptureClaim(claim);if(!fence)return Promise.resolve(false);
    return this.use(this.leasePool,client=>postgresRenewWorkerLease(client,this.schema,this.authority,fence,leaseMs,policy));
  }
  inspectClaim(claim:PostgresWorkReference,policy:string):Promise<{validUntil:number}|undefined>{
    if(!this.leasePool)throw new Error('PostgreSQL Worker requires a dedicated heartbeat pool');
    const fence=postgresCaptureClaim(claim);if(!fence)return Promise.resolve(undefined);
    return this.use(this.leasePool,client=>postgresInspectWorkerLease(client,this.schema,this.authority,fence,policy));
  }
  cleanupReleasedClaims():Promise<void>{return this.use(this.pool,client=>postgresCleanupReleasedClaims(client,this.schema,this.authority.digest));}
  /** A false result skips one empty poll; true grants no claim or authority. */
  workAvailable():Promise<boolean>{return this.use(this.pool,client=>postgresWorkAvailable(client,this.schema,this.authority));}
  async close():Promise<void> {
    this.closing??=Promise.all([...new Set([this.pool,...(this.leasePool?[this.leasePool]:[]),...(this.eligibilityPool?[this.eligibilityPool]:[])])].map(pool=>pool.end())).then(()=>{});
    await this.closing;
  }
}
