import type {Principal} from '../core/domain.js';
import type {TaskRelayHostPort} from '../agent-transport/task-host.js';
import {PostgresTaskRelayAuthority} from './task-relay-authority.js';
import {PostgresRelayReadAuthority,type PostgresRelayReadAuthorityOptions} from './relay-read-authority.js';
import {postgresTaskView} from './task-view.js';

/** Actual async business port. The transport node/store and task service are
 * injected by the host; no SQLite database or second task authority is opened. */
export class PostgresTaskRelay implements TaskRelayHostPort {
  readonly authorityId:string;readonly gatewayOrigin:string;
  readonly authority:PostgresTaskRelayAuthority;readonly reads:PostgresRelayReadAuthority;
  readonly enrollment;
  constructor(private readonly options:PostgresRelayReadAuthorityOptions){
    this.authority=new PostgresTaskRelayAuthority(options);this.authorityId=this.authority.authorityId;this.gatewayOrigin=this.authority.gatewayOrigin;
    this.reads=new PostgresRelayReadAuthority(options);this.enrollment={now:this.authority.now,withEnrollmentAdmission:this.authority.withEnrollmentAdmission.bind(this.authority)};
  }
  readonly now=Date.now;
  authorityCurrent(){return this.authority.authorityCurrent();}
  principal(agentId:string){return this.authority.principal(agentId);}
  command(agentId:string,requestId:string,inputDigest:string){return this.authority.command(agentId,requestId,inputDigest);}
  project(principal:Principal,taskId:string){return this.options.database.run(client=>postgresTaskView(client,principal,taskId,this.options.policyDigest,this.options.builder));}
  bindingAdmission(principal:Principal){return this.authority.withEnrollmentAdmission(principal,async({installationId,expiresAt})=>({installationId,expiresAt}));}
  bind(...args:Parameters<PostgresTaskRelayAuthority['bind']>){return this.authority.bind(...args);}
  revoke(...args:Parameters<PostgresTaskRelayAuthority['revoke']>){return this.authority.revoke(...args);}
  consumeProof(...args:Parameters<PostgresTaskRelayAuthority['consumeProof']>){return this.authority.consumeProof(...args);}
}
