import type {Client} from 'pg';
import {z} from 'zod';
import {digest} from '../core/delegation.js';
import {DomainError,ownerKey,TASK_SCOPES,type Principal} from '../core/domain.js';
import {agentIdSchema} from '../relay/contracts.js';
import {accessContextSchema} from '../security/contracts.js';
import {SecurityError} from '../security/errors.js';
import {postgresConsentIndex} from './consent.js';
import type {PostgresDatabase} from './database.js';
import {postgresBusinessSchema,postgresConstrainReadDeadline} from './runtime-transaction.js';
import {withPostgresAgentScope,withPostgresAgentIdentity} from './task-read-access.js';

const boundPrincipalSchema=z.strictObject({issuer:z.string(),tenant:z.string(),subject:z.string(),clientId:z.string(),scopes:z.array(z.enum(TASK_SCOPES)),access:accessContextSchema});
export interface PostgresTaskRelayAuthorityOptions {database:Pick<PostgresDatabase,'run'>;policyDigest:string;authorityId:string;gatewayOrigin:string}
export interface RelayProof {jti:string;expiresAt:number}
/** Business-side transport identities only. OAuth tokens, source credentials
 * and encrypted node storage do not enter these existing authority tables. */
export class PostgresTaskRelayAuthority {
  readonly authorityId:string;readonly gatewayOrigin:string;
  constructor(private readonly options:PostgresTaskRelayAuthorityOptions){
    this.authorityId=z.uuid().parse(options.authorityId);const u=new URL(options.gatewayOrigin);if(u.protocol!=='https:'||u.origin!==options.gatewayOrigin||! /^[a-f0-9]{64}$/.test(options.policyDigest))throw new Error('Explicit primary PostgreSQL Relay authority is required');this.gatewayOrigin=options.gatewayOrigin;
  }
  readonly now=Date.now;
  async assertCurrent(client:Client,authorityId=this.authorityId){
    const q=`"${postgresBusinessSchema(client)}"`,row=(await client.query(`SELECT id,canonical_origin FROM ${q}.runtime_authority WHERE slot=1`)).rows[0];
    if(!row||row.id!==this.authorityId||authorityId!==this.authorityId||row.canonical_origin!==this.gatewayOrigin)throw new SecurityError('AUTHORITY_UNAVAILABLE');
  }
  async authorityCurrent(){await this.options.database.run(client=>this.assertCurrent(client));return true;}
  private async proof(client:Client,input:RelayProof){
    const proof=z.strictObject({jti:z.uuid(),expiresAt:z.number().int().positive().safe()}).parse(input),now=Date.now(),q=`"${postgresBusinessSchema(client)}"`;
    if(proof.expiresAt<=now)throw new SecurityError('ACCESS_REVOKED');
    await client.query(`DELETE FROM ${q}.security_relay_proofs WHERE expires_at<=$1`,[now]);
    if((await client.query(`INSERT INTO ${q}.security_relay_proofs(id,expires_at) VALUES($1,$2) ON CONFLICT(id) DO NOTHING RETURNING id`,[proof.jti,proof.expiresAt])).rowCount!==1)throw new SecurityError('ACCESS_REVOKED');
    postgresConstrainReadDeadline(client,proof.expiresAt);
  }
  async consumeProofInTransaction(client:Client,input:RelayProof){await this.assertCurrent(client);await this.proof(client,input);}
  async consumeProof(input:RelayProof){await this.options.database.run(client=>this.consumeProofInTransaction(client,input));}
  async withEnrollmentAdmission<T>(principal:Principal,action:(admission:{ownerKey:string;installationId:string;expiresAt:number})=>Promise<T>):Promise<T>{
    const p=structuredClone(principal);
    return this.options.database.run(client=>withPostgresAgentScope(client,p,this.options.policyDigest,'services:read',async admission=>{
      await this.assertCurrent(client);const result=await action({ownerKey:admission.actor.ownerKey,installationId:admission.actor.installationId,expiresAt:Math.min(admission.validUntil,postgresConsentIndex(admission.parent.expiresAt,this.options.policyDigest))});await this.assertCurrent(client);return result;
    }));
  }
  async bind(principal:Principal,agentId:string,expiresAt:number,proof:RelayProof){
    const p=structuredClone(principal),id=agentIdSchema.parse(agentId);
    return this.options.database.run(client=>withPostgresAgentScope(client,p,this.options.policyDigest,'services:read',async admission=>{
      await this.assertCurrent(client);const now=Date.now(),q=`"${postgresBusinessSchema(client)}"`;
      if(!Number.isSafeInteger(expiresAt)||expiresAt<=now||expiresAt>now+900000||expiresAt>postgresConsentIndex(admission.parent.expiresAt,this.options.policyDigest))throw new SecurityError('AUTHORIZATION_REQUIRED');
      const old=await client.query(`SELECT installation_id,owner,state FROM ${q}.security_relay_identities WHERE agent_id=$1 LIMIT 2`,[id]);
      if(old.rows.length>1||old.rows.length&&(old.rows[0].installation_id!==admission.actor.installationId||old.rows[0].owner!==admission.actor.ownerKey))throw new SecurityError('AUTHORIZATION_REQUIRED');
      if(old.rows[0]?.state==='revoked')throw new SecurityError('ACCESS_REVOKED');
      const scopes=TASK_SCOPES.filter(scope=>p.scopes.includes(scope));if(!scopes.includes('services:read')||!scopes.some(scope=>scope==='tasks:read'||scope==='tasks:write'))throw new SecurityError('AUTHORIZATION_REQUIRED');
      const bound=boundPrincipalSchema.parse({...p,scopes,access:{...admission.actor,tokenScopes:scopes}});await this.proof(client,proof);
      const written=await client.query(`INSERT INTO ${q}.security_relay_identities AS current(agent_id,installation_id,owner,principal,expires_at,state) VALUES($1,$2,$3,$4,$5,'active')
        ON CONFLICT(agent_id) DO UPDATE SET principal=excluded.principal,expires_at=excluded.expires_at,state='active' WHERE current.installation_id=excluded.installation_id AND current.owner=excluded.owner AND current.state<>'revoked' RETURNING agent_id`,[id,admission.actor.installationId,admission.actor.ownerKey,JSON.stringify(bound),expiresAt]);
      if(written.rowCount!==1)throw new SecurityError('ACCESS_REVOKED');postgresConstrainReadDeadline(client,expiresAt);
      return {agentId:id,installationId:admission.actor.installationId,expiresAt};
    }));
  }
  private async bound(client:Client,input:string){
    await this.assertCurrent(client);const id=agentIdSchema.parse(input),q=`"${postgresBusinessSchema(client)}"`,rows=await client.query(`SELECT installation_id,owner,expires_at,CASE WHEN octet_length(principal)<=65536 THEN principal END AS principal FROM ${q}.security_relay_identities WHERE agent_id=$1 AND state='active' AND expires_at>$2 LIMIT 2`,[id,Date.now()]);
    if(rows.rowCount!==1||typeof rows.rows[0]?.principal!=='string')throw new SecurityError('AUTHORIZATION_REQUIRED');
    const row=rows.rows[0],p=boundPrincipalSchema.parse(JSON.parse(row.principal));
    if(p.access.actorKind!=='agent'||p.access.installationId!==row.installation_id||ownerKey(p)!==row.owner)throw new SecurityError('AUTHORIZATION_REQUIRED');
    postgresConstrainReadDeadline(client,Number(row.expires_at));return p;
  }
  async principal(agentId:string):Promise<Principal>{return this.options.database.run(async client=>{
    const p=await this.bound(client,agentId);return withPostgresAgentScope(client,p,this.options.policyDigest,'services:read',async()=>structuredClone(p));
  });}
  async command(agentId:string,requestId:string,inputDigest:string):Promise<string>{
    const uuid=z.uuid().parse(requestId),hash=z.string().regex(/^[a-f0-9]{64}$/).parse(inputDigest);
    return this.options.database.run(async client=>{
      const p=await this.bound(client,agentId);return withPostgresAgentScope(client,p,this.options.policyDigest,'services:read',async admission=>{
        const id=`relay:${digest([admission.actor.installationId,uuid])}`,q=`"${postgresBusinessSchema(client)}"`;
        const rows=await client.query(`INSERT INTO ${q}.security_relay_requests AS current(id,input_digest) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET input_digest=current.input_digest WHERE current.input_digest=excluded.input_digest RETURNING id`,[id,hash]);
        if(rows.rowCount!==1)throw new DomainError('CONFLICT','Relay request ID is already bound to another command');return id;
      });
    });
  }
  async revoke(principal:Principal,agentId:string){
    const p=structuredClone(principal),id=agentIdSchema.parse(agentId);
    await this.options.database.run(client=>withPostgresAgentIdentity(client,p,this.options.policyDigest,async admission=>{
      await this.assertCurrent(client);const q=`"${postgresBusinessSchema(client)}"`,changed=await client.query(`UPDATE ${q}.security_relay_identities SET state='revoked' WHERE agent_id=$1 AND installation_id=$2 AND owner=$3 RETURNING agent_id`,[id,admission.actor.installationId,admission.actor.ownerKey]);if(changed.rowCount!==1)throw new SecurityError('AUTHORIZATION_REQUIRED');
    }));
  }
}
