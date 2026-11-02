import {postgresCaptureClaim,type PostgresWorkReference} from './work-claim.js';
import type { Client, Pool } from 'pg';
import { postgresBusinessTransaction, type PostgresRuntimeAuthority } from './runtime-transaction.js';
import {postgresRenewWorkerLease,postgresInspectWorkerLease} from './lease-renewal.js';
import type {WorkClaim} from '../core/store.js';
import {postgresCleanupReleasedClaims} from './claim-release.js';

/** Owns the runtime's connection pool, not a second business authority. Each
 * operation gets one client and one fenced transaction. No implicit retries. */
export class PostgresDatabase {
  private readonly authority:PostgresRuntimeAuthority;
  private closing?:Promise<void>;
  private readonly leasePool:Pick<Pool,'connect'|'end'>|undefined;
  constructor(private readonly pool:Pick<Pool,'connect'|'end'>,private readonly schema:string,authority:PostgresRuntimeAuthority,options:{leasePool?:Pick<Pool,'connect'|'end'>}={}) {
    if(!/^eigos_business_[a-z0-9_]{1,40}$/.test(schema) || typeof authority.id!=='string' || !authority.id
      || !Number.isSafeInteger(authority.revision) || authority.revision<1 || !/^[a-f0-9]{64}$/.test(authority.digest))throw new Error('Invalid PostgreSQL runtime configuration');
    this.authority=Object.freeze(structuredClone(authority));
    if(options.leasePool===pool)throw new Error('Worker heartbeats require a separate connection pool');
    this.leasePool=options.leasePool;
  }
  private async use<T>(pool:Pick<Pool,'connect'|'end'>,action:(client:Client)=>Promise<T>):Promise<T>{
    if(this.closing)throw new Error('PostgreSQL runtime is closing');
    const client=await pool.connect(),release=client.release.bind(client);
    if(this.closing){release();throw new Error('PostgreSQL runtime is closing');}
    let released=false;
    // The transaction helper may evict an uncertain connection itself. The
    // request owner must not release that lease twice or return it to the pool.
    const releaseOnce=(error?:Error|boolean)=>{if(!released){released=true;release(error);}};
    client.release=releaseOnce;
    try{return await action(client);}
    finally{releaseOnce();}
  }
  run<T>(action:(client:Client)=>Promise<T>):Promise<T>{return this.use(this.pool,client=>postgresBusinessTransaction(client,this.schema,this.authority,action));}
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
  async close():Promise<void> {
    this.closing??=Promise.all([this.pool.end(),...(this.leasePool?[this.leasePool.end()]:[])]).then(()=>{});
    await this.closing;
  }
}
