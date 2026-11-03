import {AsyncLocalStorage} from 'node:async_hooks';
import {digest} from '../core/delegation.js';
import type {Principal} from '../core/domain.js';
import type {RelayEnrollmentIssuer} from '../agent-transport/enrollment.js';
import {communicationGrantInputSchema,MessagingError,messagingFail,type CommunicationGrant,type MessagingIdentity} from '../agent-messaging/contracts.js';
import type {AgentMessagingGatewayPort} from '../agent-messaging/ports.js';
import {AgentMessagingProtocol} from '../agent-messaging/protocol.js';
import type {PostgresDatabase} from './database.js';
import type {PostgresMemberStore} from './member-store.js';
import {PostgresMessagingAuthority,type MessagingPublisher} from './messaging-authority.js';
import {PostgresMessagingStore} from './messaging-store.js';
import {PostgresRelayNodeStore,openPostgresRelayNode,listPostgresRelayNodeIdentities} from './relay-node-store.js';

export const postgresMessagingNodeId=(endpointId:string)=>`communication:${endpointId}`;
type IdentityReceipt={principal:Principal;bearer:string;digest:string};

/** Real PostgreSQL communication service. Separate custody approval remains
 * mandatory; no task/source grant is issued. Member, bearer, fences and the
 * exact communication generation are checked before/after network operations.
 * Customer PA credentials never enter its encrypted service-node storage. */
export class PostgresAgentMessagingService implements AgentMessagingGatewayPort {
  readonly store:PostgresMessagingStore;
  private readonly authority:PostgresMessagingAuthority;
  private readonly protocol:AgentMessagingProtocol;
  private readonly identities=new WeakMap<MessagingIdentity,IdentityReceipt>();
  private readonly calls=new AsyncLocalStorage<MessagingIdentity>();
  private closed=false;
  get permissionsUrl(){return this.options.permissionsUrl;}
  constructor(private readonly options:{database:Pick<PostgresDatabase,'run'>;publisher:MessagingPublisher;members:PostgresMemberStore;
    relayUrl:string;wrappingKey:CryptoKey;enrollment:Pick<RelayEnrollmentIssuer,'issueCommunication'>;fetch?:typeof fetch;permissionsUrl?:string;nodeImportDigests?:ReadonlyMap<string,string>}){
    this.authority=new PostgresMessagingAuthority(options.database,options.publisher,options.members);
    this.store=new PostgresMessagingStore(options.database,options.publisher);
    this.protocol=new AgentMessagingProtocol(this.store,options.members,{relayUrl:options.relayUrl,enrollment:options.enrollment,openNode:(grant,assertCurrent)=>openPostgresRelayNode({...this.nodeOptions(grant),assertCurrent,fetch:options.fetch})},
      {available:()=>this.available(),live:id=>this.live(id),authorized:(identity,scope)=>this.authorized(identity,scope)});
  }
  private available(){if(this.closed)return messagingFail('MESSAGING_UNAVAILABLE',503);}
  private nodeOptions(grant:CommunicationGrant){return {database:this.options.database,publisher:this.options.publisher,nodeId:postgresMessagingNodeId(grant.id),baseUrl:this.options.relayUrl,wrappingKey:this.options.wrappingKey,displayName:grant.displayName,expectedAgentId:grant.agentId,expectedImportDigest:this.options.nodeImportDigests?.get(postgresMessagingNodeId(grant.id)),createIfMissing:!grant.agentId};}
  async identity(principal:Principal,bearer:string):Promise<MessagingIdentity>{
    this.available();const p=structuredClone(principal),identity=await this.authority.authenticate(p,bearer);this.available();
    this.identities.set(identity,{principal:p,bearer,digest:digest(identity)});return identity;
  }
  private async caller(identity:MessagingIdentity){
    const receipt=this.identities.get(identity);if(!receipt||digest(identity)!==receipt.digest)return messagingFail('MESSAGING_AUTHORIZATION_REQUIRED');
    const current=await this.authority.authenticate(receipt.principal,receipt.bearer);
    if(digest(current)!==receipt.digest)return messagingFail('MESSAGING_AUTHORIZATION_REQUIRED');this.available();
  }
  private async live(id:string){
    this.available();const caller=this.calls.getStore();if(caller)await this.caller(caller);
    const old=await this.store.grant(id),identity=await this.authority.current(old.memberId,old.installationId);
    if(identity.owner!==old.owner||identity.clientId!==old.clientId)return messagingFail('MESSAGING_AUTHORIZATION_REQUIRED');
    const current=await this.store.currentGrant(id);this.available();return current;
  }
  private async authorized(identity:MessagingIdentity,scope:string){
    await this.caller(identity);if(!identity.scopes.includes(scope))return messagingFail('MESSAGING_AUTHORIZATION_REQUIRED');
    const grant=await this.store.installation(identity.installationId);if(!grant)return messagingFail('MESSAGING_AUTHORIZATION_REQUIRED');
    const current=await this.live(grant.id);
    if(current.memberId!==identity.memberId||current.owner!==identity.owner||current.clientId!==identity.clientId||!current.scopes.some(value=>value===scope))return messagingFail('MESSAGING_AUTHORIZATION_REQUIRED');return current;
  }
  async readiness(installationId:string){
    this.available();const grant=await this.store.installation(installationId);if(!grant)return {state:'authorization_required' as const};
    try{
      const current=await this.live(grant.id),node=await PostgresRelayNodeStore.open(this.nodeOptions(current));node.store.close();await this.live(current.id);
      return {state:'ready' as const,endpointId:current.id,scopes:current.scopes,expiresAt:current.expiresAt};
    }catch(error){if(error instanceof MessagingError&&['MESSAGING_AUTHORIZATION_REQUIRED','NOT_FOUND'].includes(error.code))return {state:'authorization_required' as const};throw error;}
  }
  async approve(memberId:string,input:unknown){
    this.available();const args=communicationGrantInputSchema.parse(input),identity=await this.authority.current(memberId,args.installationId),generation=await this.authority.generation(identity);
    const grant=await this.store.approve(identity,args,generation);return this.live(grant.id);
  }
  async revoke(memberId:string,id:string,revision:number){
    this.available();const member=await this.options.members.get(memberId);if(member.status!=='active'||!member.acceptedAt)return messagingFail('MESSAGING_AUTHORIZATION_REQUIRED');
    await this.store.revoke(memberId,id,revision);this.protocol.retire(id);
  }
  /** Full legacy endpoint/startup check, including revoked/expired grants.
   * Newly approved PG nodes may have no import stamp. An imported node must
   * have its exact baseline entry, configured digest pin and authenticated
   * original private identity; unexplained/orphan state is refused. */
  async assertNodeMigrations(expected:ReadonlyMap<string,{agentId:string;importDigest:string}>){
    this.available();const grants=await this.store.grants(),inventory=await listPostgresRelayNodeIdentities({database:this.options.database,publisher:this.options.publisher,communicationsOnly:true}),seen=new Set<string>();let imported=0;
    const grantIds=new Set(grants.map(grant=>postgresMessagingNodeId(grant.id)));
    if(inventory.some(node=>!grantIds.has(node.nodeId)))throw new Error('Communication node has no original endpoint metadata');
    for(const grant of grants){const nodeId=postgresMessagingNodeId(grant.id),baseline=expected.get(nodeId),state=inventory.find(node=>node.nodeId===nodeId);
      if(baseline){seen.add(nodeId);if(this.options.nodeImportDigests?.get(nodeId)!==baseline.importDigest||grant.agentId&&grant.agentId!==baseline.agentId)throw new Error('Legacy communication node requires its exact host migration binding');}
      if(!grant.agentId&&!baseline&&!state)continue;
      const expectedAgentId=baseline?.agentId??grant.agentId??state!.agentId;
      const checked=await PostgresRelayNodeStore.verifyExisting({...this.nodeOptions(grant),expectedAgentId,expectedImportDigest:baseline?.importDigest});
      if(checked.importDigest){if(!baseline||checked.importDigest!==baseline.importDigest)throw new Error('Imported communication node is missing from the complete source inventory');imported++;}
      else if(baseline)throw new Error('Legacy communication node has no authenticated import receipt');
    }
    if(seen.size!==expected.size)throw new Error('Source communication node is missing its original endpoint metadata');this.available();return {endpoints:grants.length,nodes:inventory.length,imported};
  }
  execute(identity:MessagingIdentity,input:unknown):Promise<unknown>{this.available();return this.calls.run(identity,()=>this.protocol.execute(identity,input));}
  prepareEndpoint(id:string){this.available();return this.protocol.prepareEndpoint(id);}
  close():Promise<void>{this.closed=true;return this.protocol.close();}
}
