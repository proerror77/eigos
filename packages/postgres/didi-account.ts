import type {Client} from 'pg';
import {z} from 'zod';
import {digest} from '../core/delegation.js';
import {DomainError,type Job} from '../core/domain.js';
import {didiMemberConnectionSchema,didiSourceOwner,assertEquivalentDidiAccount,type DidiMemberConnection} from '../core/didi-source.js';
import type {DidiBinding} from '../capabilities/didi/contracts.js';
import {ownerIdentitySchema} from '../security/contracts.js';
import {SecurityError} from '../security/errors.js';
import {postgresBusinessSchema,postgresBusinessToken,postgresConstrainReadDeadline} from './runtime-transaction.js';
import {postgresWorkerAdmission} from './worker-admission.js';
import type {PostgresWorkReference} from './work-claim.js';

export interface PostgresDidiAccountDescriptor {
  /** Actual host-owned, currently pinned connection metadata. Never a model
   * object, private provider Key, promise for network I/O or admission boolean. */
  readCurrent:()=>DidiMemberConnection;
  expectedDigest?:string;
}
const denied=()=>new DomainError('FORBIDDEN','The current member DiDi readonly account is unavailable');

/** The unchanged unified accountAccess chain over the imported authority.
 * It never writes admissions, changes a descriptor, grants source/task access
 * or reads/moves the provider credential held by the source Agent/ECS. */
export class PostgresDidiAccount {
  readonly configurationDigest:string;readonly owner:string;readonly record:DidiMemberConnection;
  constructor(private readonly binding:DidiBinding,owner:string,private readonly descriptor:PostgresDidiAccountDescriptor){
    this.owner=ownerIdentitySchema.parse(owner);this.record=didiMemberConnectionSchema.parse(descriptor.readCurrent());
    this.configurationDigest=digest({policy:'member-didi-estimate@1',connection:this.record});
    if(descriptor.expectedDigest!==undefined&&z.string().regex(/^[a-f0-9]{64}$/).parse(descriptor.expectedDigest)!==this.configurationDigest)throw denied();
    assertEquivalentDidiAccount(binding,this.record,this.owner);
  }
  assertBinding(binding:DidiBinding,owner:string){
    if(digest(binding)!==digest(this.binding)||owner!==this.owner)throw denied();
    assertEquivalentDidiAccount(binding,this.current(owner),owner);
  }
  private current(owner:string){
    const record=didiMemberConnectionSchema.parse(this.descriptor.readCurrent());
    if(owner!==this.owner||didiSourceOwner(record)!==owner||record.state!=='active'||Date.parse(record.expiresAt)<=Date.now()
      ||digest({policy:'member-didi-estimate@1',connection:record})!==this.configurationDigest)throw denied();
    assertEquivalentDidiAccount(this.binding,record,owner);return record;
  }
  permitted(owner:string){try{this.current(owner);return true;}catch{return false;}}
  async assert(client:Client,claim:PostgresWorkReference,job:Job,policyDigest:string){
    const token=postgresBusinessToken(client),record=this.current(claim.owner),q=`"${postgresBusinessSchema(client)}"`;
    if(job.id!==claim.job.id||!job.delegation||job.delegation.request.id!==job.id)throw new SecurityError('AUTHORIZATION_REQUIRED');
    const admission=await postgresWorkerAdmission(client,claim.owner,job.id,policyDigest);
    if(admission.authority.memberId!==record.memberId||admission.authority.id!==claim.securityAuthorityId||admission.authority.authEpoch!==claim.securityEpoch||admission.policyRevision!==claim.securityPolicyRevision)throw new SecurityError('ACCESS_REVOKED');
    const rows=await client.query(`SELECT configuration_digest,connection_id,owner,member_id,state FROM ${q}.member_didi_source_admissions WHERE configuration_digest=$1 LIMIT 2`,[this.configurationDigest]);
    const row=rows.rows[0];if(rows.rowCount!==1||row.configuration_digest!==this.configurationDigest||row.connection_id!==record.connectionId||row.owner!==claim.owner||row.member_id!==record.memberId||row.state!=='active')throw denied();
    if(postgresBusinessToken(client)!==token||digest(this.current(claim.owner))!==digest(record))throw denied();
    postgresConstrainReadDeadline(client,Math.min(admission.validUntil,Date.parse(record.expiresAt)));
  }
}
