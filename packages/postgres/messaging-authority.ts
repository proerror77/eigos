import type {Client} from 'pg';
import {z} from 'zod';
import {digest} from '../core/delegation.js';
import {ownerKey,type Principal} from '../core/domain.js';
import type {MessagingIdentity} from '../agent-messaging/contracts.js';
import {messagingFail} from '../agent-messaging/contracts.js';
import type {PostgresDatabase} from './database.js';
import type {PostgresMemberStore} from './member-store.js';
import type {PostgresAuthorizationPublisher} from './authority-publisher.js';
import {postgresBusinessSchema,postgresConstrainReadDeadline} from './runtime-transaction.js';

export type MessagingPublisher=Pick<PostgresAuthorizationPublisher,'withManagement'|'publish'>;
export type MessagingSubject=Omit<MessagingIdentity,'scopes'>;

/** The exact original communication generation, including cleared fences.
 * Communication is independently approved; no Agent/source/task grant or
 * services/tasks scope is manufactured to perform this identity check. */
export async function postgresMessagingIdentityGeneration(client:Client,identity:MessagingSubject):Promise<string>{
  const q=`"${postgresBusinessSchema(client)}"`,rows=await client.query(`SELECT owner,member_id,client_id,state,valid_until FROM ${q}.security_subjects WHERE installation_id=$1 LIMIT 2`,[identity.installationId]);
  const row=rows.rows[0],until=Number(row?.valid_until);
  if(rows.rowCount!==1||row?.owner!==identity.owner||row.member_id!==identity.memberId||row.client_id!==identity.clientId||row.state!=='active'||!Number.isSafeInteger(until)||until<=Date.now())return messagingFail('MESSAGING_AUTHORIZATION_REQUIRED');
  const fences=await client.query(`SELECT kind,target_id,revision,state FROM ${q}.security_fences WHERE owner=$1 AND((kind='member' AND target_id=$2) OR(kind='connection' AND target_id=$3) OR(kind='installation' AND target_id=$4)) ORDER BY kind,target_id LIMIT 4`,[identity.owner,identity.memberId,identity.clientId,identity.installationId]);
  if(fences.rows.length>3)return messagingFail('MESSAGING_UNAVAILABLE',503);
  const values=fences.rows.map(value=>z.strictObject({kind:z.enum(['member','connection','installation']),target_id:z.string().min(1),revision:z.coerce.number().int().positive(),state:z.enum(['pending','applied','cleared'])}).parse(value));
  if(values.some(value=>value.state!=='cleared'))return messagingFail('MESSAGING_AUTHORIZATION_REQUIRED');
  postgresConstrainReadDeadline(client,until);return digest([identity.owner,identity.memberId,identity.installationId,identity.clientId,values]);
}

/** Membership is read before the business mutex. Revocation observers commit
 * their deny fence before changing membership; this avoids reversing those
 * locks while retaining fresh identity and the original manager continuity. */
export class PostgresMessagingAuthority {
  constructor(readonly database:Pick<PostgresDatabase,'run'>,readonly publisher:MessagingPublisher,readonly members:PostgresMemberStore){}
  run<T>(action:(client:Client)=>Promise<T>){return this.database.run(client=>this.publisher.withManagement(client,()=>action(client)));}
  async current(memberId:string,installationId:string):Promise<MessagingSubject>{
    const current=await this.publisher.publish(memberId,installationId);
    if(!current.active||current.memberId!==memberId||current.installationId!==installationId)return messagingFail('MESSAGING_AUTHORIZATION_REQUIRED');
    return {memberId,installationId,owner:current.ownerKey,clientId:current.clientId};
  }
  async authenticate(principal:Principal,bearer:string):Promise<MessagingIdentity>{
    const p=structuredClone(principal);await this.members.authorize(p);const installation=await this.members.agents.authorize(p,bearer);
    if(!installation.memberId)return messagingFail('MESSAGING_AUTHORIZATION_REQUIRED');
    const identity=await this.current(installation.memberId,installation.id);
    if(identity.owner!==ownerKey(p)||identity.clientId!==p.clientId)return messagingFail('MESSAGING_AUTHORIZATION_REQUIRED');
    await this.run(client=>postgresMessagingIdentityGeneration(client,identity));
    return {...identity,scopes:[...p.scopes]};
  }
  async generation(identity:MessagingSubject){const current=await this.current(identity.memberId,identity.installationId);if(current.memberId!==identity.memberId||current.installationId!==identity.installationId||current.owner!==identity.owner||current.clientId!==identity.clientId)return messagingFail('MESSAGING_AUTHORIZATION_REQUIRED');return this.run(client=>postgresMessagingIdentityGeneration(client,current));}
}
