import type { Client, Pool } from 'pg';
import { postgresBusinessTransaction, type PostgresRuntimeAuthority } from './runtime-transaction.js';

/** Owns the runtime's connection pool, not a second business authority. Each
 * operation gets one client and one fenced transaction. No implicit retries. */
export class PostgresDatabase {
  private readonly authority:PostgresRuntimeAuthority;
  private closing?:Promise<void>;
  constructor(private readonly pool:Pick<Pool,'connect'|'end'>,private readonly schema:string,authority:PostgresRuntimeAuthority) {
    if(!/^eigos_business_[a-z0-9_]{1,40}$/.test(schema) || typeof authority.id!=='string' || !authority.id
      || !Number.isSafeInteger(authority.revision) || authority.revision<1 || !/^[a-f0-9]{64}$/.test(authority.digest))throw new Error('Invalid PostgreSQL runtime configuration');
    this.authority=Object.freeze(structuredClone(authority));
  }
  async run<T>(action:(client:Client)=>Promise<T>):Promise<T> {
    if(this.closing)throw new Error('PostgreSQL runtime is closing');
    const client=await this.pool.connect(),release=client.release.bind(client);
    if(this.closing){release();throw new Error('PostgreSQL runtime is closing');}
    let released=false;
    // The transaction helper may evict an uncertain connection itself. The
    // request owner must not release that lease twice or return it to the pool.
    const releaseOnce=(error?:Error|boolean)=>{if(!released){released=true;release(error);}};
    client.release=releaseOnce;
    try{return await postgresBusinessTransaction(client,this.schema,this.authority,action);}
    finally{releaseOnce();}
  }
  async close():Promise<void> {
    this.closing??=this.pool.end();
    await this.closing;
  }
}
