import {lstatSync,mkdirSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {ownerKey,type Principal} from '../core/domain.js';
import {digest} from '../core/delegation.js';
import type {MemberStore} from '../members/store.js';
import {RelayClient} from '../agent-transport/client.js';
import type {RelayEnrollmentIssuer} from '../agent-transport/enrollment.js';
import type {MessagingStore} from './store.js';
import {communicationGrantInputSchema,messagingFail,type CommunicationGrant,type MessagingIdentity} from './contracts.js';
import {AgentMessagingProtocol} from './protocol.js';

export interface MessagingOptions {
  relayUrl:string;nodeDirectory:string;enrollment:Pick<RelayEnrollmentIssuer,'issueCommunication'>;
  available?:()=>boolean;fetch?:typeof fetch;
  checkIdentity?:(facts:ReturnType<MemberStore['authorizationFacts']>)=>string;
  permissionsUrl?:string;
}

/** Legacy SQLite admission and private-file transport entry. Synchronous
 * controller APIs remain synchronous; both backends share the real protocol. */
export class AgentMessagingService {
  private readonly protocol:AgentMessagingProtocol;private closed=false;
  get permissionsUrl(){return this.options.permissionsUrl;}
  constructor(readonly store:MessagingStore,private readonly members:MemberStore,private readonly options:MessagingOptions){
    if(!isAbsolute(options.nodeDirectory))throw new Error('Messaging nodes require an absolute private directory');
    mkdirSync(options.nodeDirectory,{recursive:true,mode:0o700});const info=lstatSync(options.nodeDirectory);
    if(!info.isDirectory()||info.isSymbolicLink()||info.mode&0o077||process.getuid&&info.uid!==process.getuid())throw new Error('Messaging nodes require an owned private directory (0700)');
    this.protocol=new AgentMessagingProtocol(store,members,{relayUrl:options.relayUrl,enrollment:options.enrollment,openNode:(grant,assertCurrent)=>RelayClient.open({baseUrl:options.relayUrl,credentialPath:join(options.nodeDirectory,grant.id+'.json'),displayName:grant.displayName,fetch:options.fetch,assertCurrent})},
      {available:()=>this.available(),live:id=>this.live(id),authorized:(identity,scope)=>this.authorized(identity,scope)});
  }
  identity(p:Principal,bearer:string):MessagingIdentity{
    this.available();this.members.authorize(p);const installation=this.members.agents.authorize(p,bearer),facts=this.members.authorizationFacts(installation.memberId!,installation.id);this.options.checkIdentity?.(facts);
    if(!facts.active||facts.ownerKey!==ownerKey(p)||facts.clientId!==p.clientId)return messagingFail('MESSAGING_AUTHORIZATION_REQUIRED');
    return {memberId:facts.memberId,installationId:facts.installationId,owner:facts.ownerKey,clientId:facts.clientId,scopes:[...p.scopes]};
  }
  readiness(installationId:string){const grant=this.store.installation(installationId);if(!grant)return {state:'authorization_required' as const};try{this.live(grant.id);return {state:'ready' as const,endpointId:grant.id,scopes:grant.scopes,expiresAt:grant.expiresAt};}catch{return {state:'authorization_required' as const};}}
  approve(memberId:string,input:unknown){const args=communicationGrantInputSchema.parse(input),facts=this.members.authorizationFacts(memberId,args.installationId);this.available();const generation=this.options.checkIdentity?.(facts)??digest(facts);if(!facts.active)return messagingFail('MESSAGING_AUTHORIZATION_REQUIRED');return this.live(this.store.approve({memberId,installationId:facts.installationId,owner:facts.ownerKey,clientId:facts.clientId},args,generation).id);}
  revoke(memberId:string,id:string,revision:number){this.store.revoke(memberId,id,revision);this.protocol.retire(id);}
  private available(){if(this.closed||this.options.available&&!this.options.available())return messagingFail('MESSAGING_UNAVAILABLE',503);}
  private live(id:string):CommunicationGrant{
    this.available();const grant=this.store.grant(id),facts=this.members.authorizationFacts(grant.memberId,grant.installationId),generation=this.options.checkIdentity?.(facts)??digest(facts);
    if(!facts.active||facts.ownerKey!==grant.owner||facts.clientId!==grant.clientId||grant.revoked||grant.expiresAt<=this.store.now()||generation!==grant.identityGeneration)return messagingFail('MESSAGING_AUTHORIZATION_REQUIRED');return grant;
  }
  private authorized(identity:MessagingIdentity,scope:string){if(!identity.scopes.includes(scope))return messagingFail('MESSAGING_AUTHORIZATION_REQUIRED');const grant=this.store.installation(identity.installationId);if(!grant)return messagingFail('MESSAGING_AUTHORIZATION_REQUIRED');const current=this.live(grant.id);if(current.memberId!==identity.memberId||current.owner!==identity.owner||current.clientId!==identity.clientId||!current.scopes.includes(scope))return messagingFail('MESSAGING_AUTHORIZATION_REQUIRED');return current;}
  execute(identity:MessagingIdentity,input:unknown):Promise<unknown>{return this.protocol.execute(identity,input);}
  prepareEndpoint(id:string){return this.protocol.prepareEndpoint(id);}
  close():Promise<void>{this.closed=true;return this.protocol.close();}
}
