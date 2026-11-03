import {AsyncLocalStorage} from 'node:async_hooks';
import type {Client} from 'pg';
import {digest} from '../core/delegation.js';
import type {AgentProgram} from '../core/agent-program.js';
import {bindPersonalSourceOwner} from '../core/source-owner.js';
import {ExecutionCatalog} from '../core/catalog.js';
import type {Job} from '../core/domain.js';
import {DocumentAgentProgram} from '../capabilities/document-agent.js';
import {initializeDocumentProgram,assertDocumentContextProgram,completeDocumentProgram,type DocumentProgramContext} from '../capabilities/document-program.js';
import {DidiAgentProgram,initializeDidiProgram,assertDidiContextProgram,completeDidiProgram,didiObservationProgram,type DidiProgramContext} from '../capabilities/didi/program.js';
import type {DidiBinding} from '../capabilities/didi/contracts.js';
import type {DidiConnector} from '../capabilities/didi/connector.js';
import type {ServiceRequest,Ref} from '../ontology/execution.js';
import type {GraphProgram,ProjectionMetadata} from '../ontology/graph-program.js';
import type {ObjectRef} from '../ontology/model.js';
import type {PlanningSnapshot} from '../ontology/planning-contract.js';
import type {Delivery} from '../core/catalog.js';
import type {AcceptedPortValue} from '../ontology/composition-contract.js';
import {SecurityError} from '../security/errors.js';
import {agentIdSchema} from '../relay/contracts.js';
import {PostgresRelayReadAuthority} from './relay-read-authority.js';
import {PostgresDidiRelayConnector} from './relay-read-connector.js';
import {PostgresDidiAccount,type PostgresDidiAccountDescriptor} from './didi-account.js';
import {createPostgresDidiPolicy,type PostgresDidiPolicyOptions} from './didi-policy.js';
import {createPostgresDocumentPolicy} from './document-policy.js';
import type {PostgresActionProgramPolicy} from './action-authorization.js';
import {postgresWorkReference,type PostgresWorkReference} from './work-claim.js';

export interface PostgresReadRegistration {
  readonly kind:'document'|'didi';readonly program:DocumentAgentProgram|DidiAgentProgram;readonly policy:PostgresActionProgramPolicy;readonly sourceBindingId?:string;
  readonly didi?:PostgresDidiPolicyOptions;
  initialize:(metadata:ProjectionMetadata,owner:string,request:ServiceRequest,input:unknown,component:{id:string;scopeKey:string})=>GraphProgram<{scope:ObjectRef;input:Record<string,unknown>}>;
  assertContext:(ctx:DocumentProgramContext)=>GraphProgram<void>;
  complete:(ctx:DocumentProgramContext,value:unknown,reads:PlanningSnapshot)=>GraphProgram<Delivery>;
  validateOutput?:(ctx:DidiProgramContext,output:AcceptedPortValue)=>GraphProgram<void>;
}
class PostgresDidiReadProgram extends DidiAgentProgram {
  constructor(binding:DidiBinding,connector:DidiConnector,readonly account:PostgresDidiAccount){super(binding,{connector});bindPersonalSourceOwner(this,account.owner);}
  override permitted(owner:string){return super.permitted(owner)&&this.account.permitted(owner);}
}
interface DidiMetadata {binding:DidiBinding;owner:string;account:PostgresDidiAccountDescriptor|PostgresDidiAccount;sourceBindingId?:string}
export type PostgresDidiRegistryOptions=DidiMetadata&({kind:'relay'|'relay-fixture';reads:PostgresRelayReadAuthority;peerId:string;authority:{id:string;gatewayOrigin:string}}|{kind:'synthetic-fixture';connector:DidiConnector});

/** Closed actual program registry, currently Doc plus the enabled DiDi read
 * program. No provider flag/model JSON installs arbitrary code or grants a
 * source. Production DiDi must use the real PostgreSQL Relay authority. */
export class PostgresReadProgramRegistry {
  private readonly claims=new AsyncLocalStorage<PostgresWorkReference>();
  readonly entries:readonly PostgresReadRegistration[];
  readonly catalog:ExecutionCatalog;
  constructor(readonly policyDigest:string,options:{documentEnabled?:boolean;documentSourceBindingId?:string;didi?:PostgresDidiRegistryOptions}={}){
    if(!/^[a-f0-9]{64}$/.test(policyDigest))throw new Error('A reviewed PostgreSQL program registry policy is required');const entries:PostgresReadRegistration[]=[];
    if(options.documentEnabled!==false){const program=new DocumentAgentProgram();entries.push({kind:'document',program,policy:createPostgresDocumentPolicy(),sourceBindingId:options.documentSourceBindingId,
      initialize:(metadata,owner,request,input,component)=>initializeDocumentProgram(program,owner,request,input,component),assertContext:ctx=>assertDocumentContextProgram(program,ctx),complete:(ctx,value,reads)=>completeDocumentProgram(program,ctx,value,reads)});}
    if(options.didi){
      const configured=options.didi,account=configured.account instanceof PostgresDidiAccount?configured.account:new PostgresDidiAccount(configured.binding,configured.owner,configured.account);account.assertBinding(configured.binding,configured.owner);let connector:DidiConnector;
      if(configured.kind!=='synthetic-fixture'){
        if(!(configured.reads instanceof PostgresRelayReadAuthority)||configured.reads.didiAccount!==account||configured.binding.environment!=='production')throw new Error('Production DiDi requires its actual current source Agent Relay authority and the same current account');agentIdSchema.parse(configured.peerId);
        const relay=new PostgresDidiRelayConnector(configured.reads,()=>this.claim(),configured.peerId,configured.binding,configured.authority);
        connector=configured.kind==='relay-fixture'?{evidenceKind:'fixture',transportDigest:digest({transport:relay.transportDigest,fixture:'explicit-synthetic-provider-v1'}),invoke:relay.invoke.bind(relay)}:relay;
      }else{if(configured.connector.evidenceKind!=='fixture')throw new Error('Synthetic DiDi registration cannot claim a live source');connector=configured.connector;}
      const program=new PostgresDidiReadProgram(configured.binding,connector,account),didi:PostgresDidiPolicyOptions={program,account,policyDigest,transport:configured.kind!=='synthetic-fixture'?{kind:configured.kind,peerId:configured.peerId,authorityId:configured.authority.id,gatewayOrigin:configured.authority.gatewayOrigin,binding:configured.binding}:{kind:'synthetic-fixture'}};
      entries.push({kind:'didi',program,policy:createPostgresDidiPolicy(didi),sourceBindingId:configured.sourceBindingId,didi,
        initialize:(metadata,owner,request,input,component)=>initializeDidiProgram(program,metadata,owner,request,input,component),
        assertContext:function*(ctx){yield* assertDidiContextProgram(program,ctx);},complete:(ctx,value,reads)=>completeDidiProgram(program,ctx,value,reads),
        validateOutput:function*(ctx,output){const refs=output.definition.cardinality==='many'?output.value as ObjectRef[]:[output.value as ObjectRef];for(const ref of refs)yield* didiObservationProgram(program,ctx,ref);},
      });
    }
    this.entries=Object.freeze(entries);this.catalog=new ExecutionCatalog(entries.map(entry=>entry.program.capability()),[],[],[],entries.map(entry=>entry.program));
  }
  policies(){return this.entries.map(entry=>entry.policy);}
  find(ref:Ref,configurationDigest:string){return this.entries.find(entry=>digest(entry.program.ref)===digest(ref)&&entry.program.configurationDigest===configurationDigest);}
  require(ref:Ref,configurationDigest:string){const found=this.find(ref,configurationDigest);if(!found)throw new SecurityError('SOURCE_NOT_AUTHORIZED');return found;}
  private claim(){const claim=this.claims.getStore();if(!claim)throw new SecurityError('AUTHORIZATION_REQUIRED','Original Worker claim scope is required for a source read');return postgresWorkReference(claim);}
  withClaim<T>(claim:PostgresWorkReference,action:()=>Promise<T>):Promise<T>{return this.claims.run(postgresWorkReference(claim),action);}
  async assertConfigured(client:Client,entry:PostgresReadRegistration,claim:PostgresWorkReference,job:Job){
    const current=this.require(entry.program.ref,entry.program.configurationDigest);if(current!==entry)throw new SecurityError('POLICY_CHANGED');
    if(!entry.program.permitted(claim.owner))throw new SecurityError('SOURCE_NOT_AUTHORIZED');if(entry.didi)await entry.didi.account.assert(client,claim,job,this.policyDigest);
  }
}
