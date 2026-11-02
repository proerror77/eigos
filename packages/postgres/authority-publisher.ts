import {randomUUID} from 'node:crypto';
import type {Client,Pool} from 'pg';
import {z} from 'zod';
import {digest} from '../core/delegation.js';
import {ownerKey,type Principal} from '../core/domain.js';
import {accessContextSchema,agentAccessGrantSchema,ownerIdentitySchema,POLICY_VERSION,SECURITY_CONTRACT,securityDefaults,type AccessContext} from '../security/contracts.js';
import {SecurityError} from '../security/errors.js';
import type {Fence,Subject,SubjectFacts} from '../security/store.js';
import type {PostgresDatabase} from './database.js';
import {postgresBusinessSchema,postgresBusinessAuthorityDigest,postgresConstrainReadDeadline,reservePostgresTransactionClient,type PostgresRuntimeAuthority} from './runtime-transaction.js';

type Awaitable<T>=T|Promise<T>;
type ControlWatch={cause?:Error;evict?:()=>void};
/** Trusted, current membership authority, never facts supplied by request JSON.
 * Every membership/connection/installation revocation must first await a
 * committed deny fence. The provider must read current persisted facts, and
 * authorize the already verified principal and its actual bearer credential. */
export interface PostgresEligibilityMembers {
  authorize(principal:Principal):Awaitable<unknown>;
  agents:{authorize(principal:Principal,bearer:string):Awaitable<{id:string;memberId?:string}>};
  authorizationFacts(memberId:string,installationId:string):Awaitable<SubjectFacts>;
}
export interface PostgresPublisherFailure {operation:string;cause:unknown;at:number;lastRenewedAt?:number}
const leaseMs=securityDefaults.authorityProjectionLeaseSeconds*1000;
const refreshMs=securityDefaults.authorityProjectionRefreshSeconds*1000;
const factsSchema=z.strictObject({ownerKey:ownerIdentitySchema,memberId:z.uuid(),installationId:z.uuid(),clientId:z.string().min(1).max(2000),active:z.boolean()});
const targetSchema=factsSchema.pick({ownerKey:true}).extend({kind:z.enum(['member','connection','installation']),targetId:z.string().min(1).max(2000)});
const subjectColumns=['installation_id','owner','member_id','client_id','state'].map(name=>`CASE WHEN octet_length(${name})<=${name==='owner'||name==='client_id'?2000:100} THEN ${name} END AS ${name}`).join(',')+',epoch,valid_until';
const rowSubject=(r:Record<string,unknown>):Subject=>({...factsSchema.parse({ownerKey:r.owner,memberId:r.member_id,installationId:r.installation_id,clientId:r.client_id,active:r.state==='active'}),epoch:z.coerce.number().int().positive().parse(r.epoch),validUntil:z.coerce.number().int().nonnegative().parse(r.valid_until)});
const matches=(s:Subject,t:Pick<Fence,'ownerKey'|'kind'|'targetId'>)=>s.ownerKey===t.ownerKey&&(t.kind==='member'?s.memberId===t.targetId:t.kind==='connection'?s.clientId===t.targetId:s.installationId===t.targetId);
const fenceId=(f:Pick<Fence,'ownerKey'|'kind'|'targetId'>)=>digest([f.ownerKey,f.kind,f.targetId]);

/** PostgreSQL eligibility projection, not a grant issuer or membership store.
 * The dedicated control pool must have independent connection capacity from
 * the business database (including Worker heartbeat capacity). It is supplied
 * by the runtime and remains runtime-owned. No process silently reacquires an
 * expired manager lease: restart/recovery is an explicit lifecycle decision.
 *
 * Membership calls run before opening a business transaction. State/epoch
 * changes and deny/restore transitions use the same business mutex as tasks.
 * Manager heartbeats and unchanged ACTIVE timestamp refreshes use separate
 * connections and never wait for that mutex. A 10-second client watchdog
 * bounds connection acquisition and control acknowledgements independently
 * of server statement timeouts and pool configuration.
 */
export class PostgresAuthorizationPublisher {
  private readonly schema:string;
  private readonly runtime:PostgresRuntimeAuthority;
  private readonly policy:string;
  private readonly limit:number;
  private state:'new'|'starting'|'running'|'stopped'|'failed'='new';
  private token?:string;
  private until=0;
  private lastRenewedAt?:number;
  private timer?:ReturnType<typeof setInterval>;
  private refreshing?:Promise<void>;
  private renewing?:Promise<void>;
  private releasing?:Promise<void>;
  private stopped?:PostgresPublisherFailure;
  private unavailable?:(failure:PostgresPublisherFailure)=>void;
  private readonly inflight=new Set<Promise<unknown>>();
  private track<T>(work:Promise<T>):Promise<T>{this.inflight.add(work);void work.then(()=>this.inflight.delete(work),()=>this.inflight.delete(work));return work;}
  constructor(private readonly options:{database:Pick<PostgresDatabase,'run'>;controlPool:Pick<Pool,'connect'>;schema:string;runtime:PostgresRuntimeAuthority;policyDigest:string;members:PostgresEligibilityMembers;maxSubjects?:number}) {
    const {schema,runtime,policyDigest}=options;
    if(!/^eigos_business_[a-z0-9_]{1,40}$/.test(schema)||!runtime.id||!Number.isSafeInteger(runtime.revision)||runtime.revision<1
      ||!/^[a-f0-9]{64}$/.test(runtime.digest)||!/^[a-f0-9]{64}$/.test(policyDigest))throw new Error('Invalid PostgreSQL publisher configuration');
    this.schema=schema;this.runtime=Object.freeze(structuredClone(runtime));this.policy=policyDigest;this.limit=options.maxSubjects??1000;
    if(!Number.isSafeInteger(this.limit)||this.limit<1||this.limit>10000)throw new Error('Invalid PostgreSQL publisher subject bound');
  }
  get failure():PostgresPublisherFailure|undefined{return this.stopped?{...this.stopped}:undefined;}
  onUnavailable(handler:(failure:PostgresPublisherFailure)=>void):void{this.unavailable=handler;}
  private currentToken():string {
    if(this.state!=='running'||!this.token||this.until<=Date.now())throw new SecurityError('AUTHORITY_UNAVAILABLE');
    return this.token;
  }
  private stillCurrent(token:string):void {if(this.currentToken()!==token)throw new SecurityError('AUTHORITY_UNAVAILABLE');}
  private stop(operation:string,cause:unknown):void {
    if(this.state==='failed'||this.state==='stopped')return;
    const token=this.token;this.state='failed';this.token=undefined;this.until=0;clearInterval(this.timer);
    this.stopped={operation,cause,at:Date.now(),lastRenewedAt:this.lastRenewedAt};
    // Keep the first failure, including its original database/network error.
    // Cleanup cannot grant rights and never resets a different manager token.
    this.releasing=Promise.allSettled([...this.inflight,this.renewing,this.refreshing]).then(async()=>{if(token)await this.release(token);});
    try{this.unavailable?.({...this.stopped});}catch{/* observer failures cannot restore authority */}
  }
  private async release(token:string):Promise<void>{
    try{await this.control(async client=>{await client.query(`UPDATE "${this.schema}".security_manager SET expires_at=0 WHERE slot=1 AND token=$1`,[token]);});}
    catch{/* uncertain/unavailable storage stays fail-closed; the original lease expires */}
  }
  async start():Promise<void> {
    if(this.state!=='new')throw new Error('An eligibility publisher can only start once');
    this.state='starting';const token=randomUUID();this.token=token;
    try{
      const until=Date.now()+leaseMs;
      await this.control(async client=>{
        const q=`"${this.schema}"`;
        await client.query(`LOCK TABLE ${q}.security_manager IN SHARE ROW EXCLUSIVE MODE`);
        const result=await client.query(`INSERT INTO ${q}.security_manager(slot,token,expires_at) VALUES(1,$1,$2)
          ON CONFLICT(slot) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at
          WHERE ${q}.security_manager.expires_at<=GREATEST($3,floor(extract(epoch FROM clock_timestamp())*1000)::bigint)
          RETURNING expires_at`,[token,until,Date.now()]);
        if(result.rowCount!==1)throw new SecurityError('AUTHORITY_UNAVAILABLE','Another authorization Gateway is active');
      },until);
      if(this.state!=='starting')throw new SecurityError('AUTHORITY_UNAVAILABLE');
      this.until=until;this.lastRenewedAt=Date.now();this.state='running';
      this.timer=setInterval(()=>{
        // Projection work can wait on a task writer without consuming the
        // independent manager heartbeat's connection or renewal opportunity.
        void this.renew().catch(()=>{});void this.refresh().catch(()=>{});
      },refreshMs);this.timer.unref();
      await this.refresh();
    }catch(error){this.stop('start',error);const failure=new SecurityError('AUTHORITY_UNAVAILABLE','Eligibility publisher could not start');failure.cause=error;throw failure;}
  }
  async close():Promise<void> {
    if(this.state==='failed'){await this.releasing;return;}
    const token=this.token;this.state='stopped';this.token=undefined;this.until=0;clearInterval(this.timer);
    await Promise.allSettled([...this.inflight,this.renewing,this.refreshing]);if(token)await this.release(token);
  }
  renew():Promise<void> {
    if(this.renewing)return this.renewing;
    const work=(async()=>{
      const token=this.currentToken(),until=Date.now()+leaseMs;
      await this.control(async client=>{
        const result=await client.query(`UPDATE "${this.schema}".security_manager SET expires_at=$1 WHERE slot=1 AND token=$2
          AND expires_at>GREATEST($3,floor(extract(epoch FROM clock_timestamp())*1000)::bigint) RETURNING expires_at`,[until,token,Date.now()]);
        if(result.rowCount!==1)throw new SecurityError('AUTHORITY_UNAVAILABLE');
      },until);
      if(this.state!=='running'||this.token!==token)throw new SecurityError('AUTHORITY_UNAVAILABLE');
      this.until=until;this.lastRenewedAt=Date.now();
    })();
    this.renewing=work.catch(error=>{this.stop('renew',error);throw error;}).finally(()=>{this.renewing=undefined;});return this.renewing;
  }
  refresh():Promise<void> {
    if(this.refreshing)return this.refreshing;
    const work=(async()=>{
      const token=this.currentToken();
      const subjects=await this.control(async client=>{
        await this.requireControlManager(client,token);return this.subjects(client);
      },this.until);
      for(const subject of subjects){this.stillCurrent(token);await this.publish(subject.memberId,subject.installationId);}
    })();
    this.refreshing=work.catch(error=>{this.stop('refresh',error);throw error;}).finally(()=>{this.refreshing=undefined;});return this.refreshing;
  }
  /** Resolve facts internally; callers cannot submit an active=true projection. */
  async publish(memberId:string,installationId:string):Promise<Subject> {
    const token=this.currentToken(),observedAt=Date.now();
    const facts=await this.facts(memberId,installationId);this.stillCurrent(token);
    const subject=await this.project(facts,token,observedAt);
    this.stillCurrent(token);return subject;
  }
  async authenticate(principal:Principal,bearer:string):Promise<AccessContext> {
    const token=this.currentToken(),observedAt=Date.now(),verified=structuredClone(principal);
    const registration=await this.options.members.agents.authorize(verified,bearer);
    await this.options.members.authorize(verified);
    if(!registration.memberId)throw new SecurityError('ACCESS_REVOKED');
    const facts=await this.facts(registration.memberId,registration.id);
    if(facts.ownerKey!==ownerKey(verified)||facts.clientId!==verified.clientId)throw new SecurityError('ACCESS_REVOKED');
    this.stillCurrent(token);
    const published=await this.project(facts,token,observedAt);
    if(!published.active)throw new SecurityError('ACCESS_REVOKED');
    const access=await this.business(async client=>{
      await this.requireManager(client,token);
      const q=`"${this.schema}"`;
      const current=(await client.query(`SELECT ${subjectColumns} FROM ${q}.security_subjects WHERE installation_id=$1`,[facts.installationId])).rows[0],subject=current?rowSubject(current):undefined;
      if(!subject?.active||subject.epoch!==published.epoch||subject.ownerKey!==facts.ownerKey||subject.memberId!==facts.memberId||subject.clientId!==facts.clientId||await this.fenced(client,facts))throw new SecurityError('ACCESS_REVOKED');
      postgresConstrainReadDeadline(client,Math.min(subject.validUntil,observedAt+refreshMs));
      const rows=await client.query(`SELECT id,revision,state,expires_at,CASE WHEN octet_length(body)<=1048576 THEN body END AS body FROM ${q}.security_grants
        WHERE installation_id=$1 AND kind='agent_access' AND state='active' AND expires_at>$2 LIMIT 2`,[subject.installationId,Date.now()]);
      if(rows.rowCount!==1||typeof rows.rows[0].body!=='string')throw new SecurityError('AUTHORIZATION_REQUIRED');
      const row=rows.rows[0],grant=agentAccessGrantSchema.parse({...JSON.parse(row.body),revision:Number(row.revision),status:row.state});
      if(grant.id!==row.id||grant.ownerKey!==subject.ownerKey||grant.memberId!==subject.memberId||grant.installationId!==subject.installationId)throw new SecurityError('ACCESS_REVOKED');
      postgresConstrainReadDeadline(client,Math.min(Number(row.expires_at),Date.parse(grant.expiresAt)));
      return accessContextSchema.parse({version:SECURITY_CONTRACT,actorKind:'agent',ownerKey:subject.ownerKey,memberId:subject.memberId,installationId:subject.installationId,
        clientId:subject.clientId,tokenScopes:[...new Set(verified.scopes)],agentGrant:{id:grant.id,revision:grant.revision},authEpoch:subject.epoch,policyVersion:POLICY_VERSION,checkedAt:new Date().toISOString()});
    });
    this.stillCurrent(token);return access;
  }
  private async requireControlManager(client:Client,token:string):Promise<number>{
    this.stillCurrent(token);
    const result=await client.query(`SELECT expires_at FROM "${this.schema}".security_manager WHERE slot=1 AND token=$1
      AND expires_at>GREATEST($2,floor(extract(epoch FROM clock_timestamp())*1000)::bigint)`,[token,Date.now()]),until=Number(result.rows[0]?.expires_at);
    if(result.rowCount!==1||!Number.isSafeInteger(until)||until<=Date.now())throw new SecurityError('AUTHORITY_UNAVAILABLE');return until;
  }
  /** Only an unchanged ACTIVE identity can use this path. It changes one
   * timestamp, never state/epoch/identity/grants or a task authority. Fresh
   * membership evidence and the original live manager are required even when
   * the old subject timestamp has expired. A denied subject cannot match. */
  private async project(facts:SubjectFacts,token:string,observedAt:number):Promise<Subject>{
    try{return await this.projectCurrent(facts,token,observedAt);}
    catch(error){if(!(error instanceof SecurityError)||error.reason==='AUTHORITY_UNAVAILABLE')this.stop('publish',error);throw error;}
  }
  private async projectCurrent(facts:SubjectFacts,token:string,observedAt:number):Promise<Subject>{
    const q=`"${this.schema}"`,deadline=Math.min(this.until,observedAt+refreshMs);
    if(facts.active){
      const renewed=await this.control(async client=>{
        await this.requireControlManager(client,token);
        const rows=await client.query(`SELECT ${subjectColumns} FROM ${q}.security_subjects WHERE installation_id=$1`,[facts.installationId]);
        const old=rows.rowCount===1?rowSubject(rows.rows[0]):undefined;
        if(old&&(old.ownerKey!==facts.ownerKey||old.memberId!==facts.memberId||old.clientId!==facts.clientId))throw new SecurityError('POLICY_CHANGED');
        if(!old?.active)return undefined;
        const result=await client.query(`UPDATE ${q}.security_subjects s SET valid_until=GREATEST(s.valid_until,$6)
          WHERE s.installation_id=$1 AND s.owner=$2 AND s.member_id=$3 AND s.client_id=$4 AND s.epoch=$5 AND s.state='active'
            AND EXISTS(SELECT 1 FROM ${q}.security_manager m WHERE m.slot=1 AND m.token=$7
              AND m.expires_at>GREATEST($8,floor(extract(epoch FROM clock_timestamp())*1000)::bigint))
            AND NOT EXISTS(SELECT 1 FROM ${q}.security_fences f WHERE f.owner=s.owner AND f.state<>'cleared'
              AND((f.kind='member' AND f.target_id=s.member_id) OR(f.kind='connection' AND f.target_id=s.client_id) OR(f.kind='installation' AND f.target_id=s.installation_id)))
          RETURNING s.valid_until`,[facts.installationId,facts.ownerKey,facts.memberId,facts.clientId,old.epoch,observedAt+leaseMs,token,Date.now()]);
        await this.requireControlManager(client,token);
        return result.rowCount===1?{...old,validUntil:z.coerce.number().int().positive().parse(result.rows[0].valid_until)}:undefined;
      },deadline);
      this.stillCurrent(token);if(renewed)return renewed;
    }
    return this.business(client=>this.publishFacts(client,facts,token,observedAt));
  }
  private async facts(memberId:string,installationId:string):Promise<SubjectFacts>{
    z.uuid().parse(memberId);z.uuid().parse(installationId);
    const facts=factsSchema.parse(await this.options.members.authorizationFacts(memberId,installationId));
    if(facts.memberId!==memberId||facts.installationId!==installationId)throw new SecurityError('POLICY_CHANGED');return facts;
  }
  private business<T>(action:(client:Client)=>Promise<T>):Promise<T>{
    return this.track(this.options.database.run(async client=>{
      if(postgresBusinessSchema(client)!==this.schema||postgresBusinessAuthorityDigest(client)!==this.runtime.digest)throw new SecurityError('AUTHORITY_UNAVAILABLE');
      const row=(await client.query(`SELECT id,revision,configuration_digest FROM "${this.schema}".eigos_lock_runtime_authority()`)).rows[0];
      if(!row||row.id!==this.runtime.id||Number(row.revision)!==this.runtime.revision||row.configuration_digest!==this.runtime.digest)throw new SecurityError('AUTHORITY_UNAVAILABLE');
      await this.requirePolicy(client);return action(client);
    }));
  }
  private async requirePolicy(client:Client):Promise<void>{
    const result=await client.query(`SELECT p.revision,d.digest FROM "${this.schema}".security_policy p
      JOIN "${this.schema}".security_policy_definitions d ON d.slot=p.slot JOIN "${this.schema}".security_settings c ON c.slot=p.slot
      WHERE p.slot=1 AND c.version=2 AND c.mode='foundation'`),row=result.rows[0];
    if(result.rowCount!==1||row?.digest!==this.policy||!Number.isSafeInteger(Number(row?.revision))||Number(row.revision)<1)throw new SecurityError('AUTHORITY_UNAVAILABLE');
  }
  private async requireManager(client:Client,token:string):Promise<number>{
    this.stillCurrent(token);
    const row=(await client.query(`SELECT expires_at FROM "${this.schema}".security_manager WHERE slot=1 AND token=$1
      AND expires_at>GREATEST($2,floor(extract(epoch FROM clock_timestamp())*1000)::bigint)`,[token,Date.now()])).rows[0],until=Number(row?.expires_at);
    if(!Number.isSafeInteger(until)||until<=Date.now())throw new SecurityError('AUTHORITY_UNAVAILABLE');
    postgresConstrainReadDeadline(client,until);return until;
  }
  private async subjects(client:Client):Promise<Subject[]>{
    const rows=await client.query(`SELECT ${subjectColumns} FROM "${this.schema}".security_subjects ORDER BY installation_id LIMIT $1`,[this.limit+1]);
    if(rows.rows.length>this.limit)throw new SecurityError('AUTHORITY_UNAVAILABLE','Eligibility projection exceeds its reviewed subject bound');return rows.rows.map(rowSubject);
  }
  private async fenced(client:Client,facts:SubjectFacts):Promise<boolean>{
    return (await client.query(`SELECT 1 FROM "${this.schema}".security_fences WHERE owner=$1 AND state<>'cleared'
      AND ((kind='member' AND target_id=$2) OR(kind='connection' AND target_id=$3) OR(kind='installation' AND target_id=$4)) LIMIT 1`,[facts.ownerKey,facts.memberId,facts.clientId,facts.installationId])).rowCount!==0;
  }
  private async invalidate(client:Client,id:string):Promise<void>{
    const q=`"${this.schema}"`;
    await client.query(`UPDATE ${q}.security_grants SET state='revoked',revision=revision+1 WHERE installation_id=$1 AND state='active'`,[id]);
    await client.query(`UPDATE ${q}.security_task_authorities SET state='revoked' WHERE installation_id=$1 AND state='active'`,[id]);
  }
  private async publishFacts(client:Client,facts:SubjectFacts,token:string,observedAt:number):Promise<Subject>{
    const until=observedAt+leaseMs,freshUntil=observedAt+refreshMs;
    if(freshUntil<=Date.now())throw new SecurityError('AUTHORITY_UNAVAILABLE','Membership facts expired before publication');
    const managerUntil=await this.requireManager(client,token),q=`"${this.schema}"`;
    const row=(await client.query(`SELECT ${subjectColumns} FROM ${q}.security_subjects WHERE installation_id=$1`,[facts.installationId])).rows[0],old=row?rowSubject(row):undefined;
    if(old&&(old.ownerKey!==facts.ownerKey||old.memberId!==facts.memberId||old.clientId!==facts.clientId))throw new SecurityError('POLICY_CHANGED');
    const active=facts.active&&!await this.fenced(client,facts)&&(!old||old.active),epoch=(old?.epoch??1)+(old?.active&&!active?1:0);
    await client.query(`INSERT INTO ${q}.security_subjects(installation_id,owner,member_id,client_id,epoch,state,valid_until) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(installation_id) DO UPDATE SET epoch=excluded.epoch,state=excluded.state,valid_until=excluded.valid_until`,[facts.installationId,facts.ownerKey,facts.memberId,facts.clientId,epoch,active?'active':'denied',active?until:0]);
    if(old?.active&&!active)await this.invalidate(client,facts.installationId);
    postgresConstrainReadDeadline(client,Math.min(freshUntil,until,managerUntil));
    return {...facts,active,epoch,validUntil:active?until:0};
  }
  async deny(input:Pick<Fence,'ownerKey'|'kind'|'targetId'>):Promise<Fence>{
    const target=targetSchema.parse(input);
    return this.business(async client=>{
      const q=`"${this.schema}"`,id=fenceId(target);
      const row=(await client.query(`INSERT INTO ${q}.security_fences(id,owner,kind,target_id,revision,state) VALUES($1,$2,$3,$4,1,'pending')
        ON CONFLICT(id) DO UPDATE SET revision=${q}.security_fences.revision+1,state='pending' RETURNING revision`,[id,target.ownerKey,target.kind,target.targetId])).rows[0];
      const revision=z.coerce.number().int().positive().parse(row.revision);
      const selector=`owner=$1 AND ($2='member' AND member_id=$3 OR $2='connection' AND client_id=$3 OR $2='installation' AND installation_id=$3)`,values=[target.ownerKey,target.kind,target.targetId];
      // A deny fence must cover every matching installation even if the
      // publisher's bounded enumeration would refuse a projection refresh.
      // These mutations return no unbounded row data to the application.
      await client.query(`UPDATE ${q}.security_subjects SET state='denied',epoch=epoch+1,valid_until=0 WHERE state='active' AND ${selector}`,values);
      await client.query(`UPDATE ${q}.security_grants SET state='revoked',revision=revision+1 WHERE state='active' AND installation_id IN(SELECT installation_id FROM ${q}.security_subjects WHERE ${selector})`,values);
      await client.query(`UPDATE ${q}.security_task_authorities SET state='revoked' WHERE state='active' AND installation_id IN(SELECT installation_id FROM ${q}.security_subjects WHERE ${selector})`,values);
      await this.event(client,'deny',id,revision);return {...target,revision,state:'pending'};
    });
  }
  async settleFence(fence:Fence,state:'applied'|'cleared'):Promise<void>{
    const target=targetSchema.parse({ownerKey:fence.ownerKey,kind:fence.kind,targetId:fence.targetId});z.number().int().positive().parse(fence.revision);z.enum(['applied','cleared']).parse(state);
    await this.business(async client=>{
      const q=`"${this.schema}"`,id=fenceId(target);
      const updated=await client.query(`UPDATE ${q}.security_fences SET state=$1 WHERE id=$2 AND revision=$3 AND state<>'cleared'`,[state,id,fence.revision]);
      if(updated.rowCount!==1)throw new SecurityError('POLICY_CHANGED');
      if(state==='cleared')for(const subject of (await this.subjects(client)).filter(s=>matches(s,target)))if(!await this.fenced(client,subject)){
        // Explicit restoration recovers eligibility only. Old grants and task
        // authorities remain revoked; fresh trusted facts must be published.
        await client.query(`UPDATE ${q}.security_subjects SET state='active',epoch=epoch+1,valid_until=0 WHERE installation_id=$1`,[subject.installationId]);
      }
      await this.event(client,state,id,fence.revision);
    });
  }
  async coordinate(target:Pick<Fence,'ownerKey'|'kind'|'targetId'>,changeMembership:()=>Promise<void>,restore=false):Promise<void>{
    const fence=await this.deny(target);
    try{await changeMembership();await this.settleFence(fence,restore?'cleared':'applied');}
    catch(error){const failure=new SecurityError('REVOCATION_PENDING','Access remains denied; membership reconciliation is required');failure.cause=error;throw failure;}
  }
  private async event(client:Client,kind:string,ref:unknown,revision:number):Promise<void>{
    await client.query(`INSERT INTO "${this.schema}".security_events(id,at,kind,subject_digest,revision) VALUES($1,$2,$3,$4,$5)`,[randomUUID(),Date.now(),kind,digest(ref),revision]);
  }
  /** Each control operation owns one connection and a short, runtime-bound
   * transaction. A lost COMMIT acknowledgement evicts it and stops publishing. */
  private control<T>(action:(client:Client)=>Promise<T>,deadline=Infinity):Promise<T>{
    const watch:ControlWatch={};let timer:ReturnType<typeof setTimeout>;
    const timeout=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{
      const failure=new Error('Eligibility control acknowledgement timed out after 10000 ms; publisher must stop');
      watch.cause=failure;reject(failure);watch.evict?.();
    },10000);timer.unref();});
    // Bound connection acquisition and the entire acknowledgement, including
    // COMMIT. The losing operation has no adoption path: a late connection is
    // evicted on arrival, and a late reply cannot resolve this raced result.
    return this.track(Promise.race([this.controlTransaction(action,deadline,watch),timeout]).finally(()=>clearTimeout(timer)));
  }
  private async controlTransaction<T>(action:(client:Client)=>Promise<T>,deadline:number,watch:ControlWatch):Promise<T>{
    const client=await this.options.controlPool.connect(),release=client.release.bind(client);let discarded=false,opened=false,beginning=false,committing=false;
    let free:(()=>void)|undefined;const q=`"${this.schema}"`;
    const discard=()=>{if(!discarded){discarded=true;try{release(new Error('Eligibility control transaction state is uncertain'));}catch{/* already disconnected */}}};
    const observing=()=>{if(watch.cause)throw watch.cause;};
    watch.evict=discard;
    try{
      observing();
      try{free=reservePostgresTransactionClient(client);}catch(error){discard();throw error;}
      if(deadline<=Date.now())throw new SecurityError('AUTHORITY_UNAVAILABLE');
      beginning=true;await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');beginning=false;opened=true;
      if(client.getTransactionStatus()!=='T'){discard();opened=false;throw new Error('Eligibility control transaction did not start');}
      await client.query("SET LOCAL statement_timeout='10000ms'; SET LOCAL lock_timeout='5000ms'; SET LOCAL idle_in_transaction_session_timeout='10000ms'");
      const requireConfiguration=async()=>{
        // A business transaction holds the locking authority function until
        // commit. Heartbeats must use the nonlocking current descriptor, as
        // Worker lease inspection does; no business rights are issued here.
        const runtime=await client.query(`SELECT id,revision,configuration_digest FROM ${q}.eigos_current_runtime_authority()`),row=runtime.rows[0];
        if(runtime.rowCount!==1||row?.id!==this.runtime.id||Number(row?.revision)!==this.runtime.revision||row.configuration_digest!==this.runtime.digest)throw new SecurityError('AUTHORITY_UNAVAILABLE');
        await this.requirePolicy(client);
      };
      await requireConfiguration();observing();
      const result=await action(client);observing();await requireConfiguration();observing();
      if(client.getTransactionStatus()!=='T'){discard();opened=false;throw new Error('Eligibility control transaction boundary was lost');}
      if(deadline<=Date.now())throw new SecurityError('AUTHORITY_UNAVAILABLE');
      committing=true;await client.query('COMMIT');opened=false;committing=false;observing();
      if(deadline<=Date.now())throw new SecurityError('AUTHORITY_UNAVAILABLE','Eligibility lease expired before acknowledgement');return result;
    }catch(error){
      if(watch.cause){discard();throw watch.cause;}
      if(beginning){discard();throw new Error('Eligibility control transaction start outcome is unknown; connection discarded',{cause:error});}
      if(opened&&!committing){try{await client.query('ROLLBACK');}catch{discard();}}
      if(committing){discard();throw new Error('Eligibility control commit outcome is unknown; publisher must stop',{cause:error});}throw error;
    }finally{watch.evict=undefined;free?.();if(!discarded)release();}
  }
}
