import type {Express,Request,RequestHandler} from 'express';
import type {Config} from '../../packages/core/config.js';
import type {Principal} from '../../packages/core/domain.js';
import type {TaskService} from '../../packages/core/tasks.js';
import type {TaskServicePort} from '../../packages/core/task-service-port.js';
import type {AccessContext} from '../../packages/security/contracts.js';
import type {MemberStoragePort,MemberPermissionCoordinatorPort} from '../../packages/members/ports.js';
import type {DefinitionServicePort} from '../../packages/ontology/definition-service-port.js';
import type {AgentMessagingGatewayPort} from '../../packages/agent-messaging/ports.js';
import type {OntologyReleaseRef} from '../../packages/ontology/definition-contracts.js';
import type {NetworkService} from '../../packages/network/service.js';
import type {MemberSourceService} from '../../packages/members/source-service.js';
import type {TaskRelayGateway} from './relay.js';

export type {DefinitionServicePort} from '../../packages/ontology/definition-service-port.js';
export type {AgentMessagingExecutionPort,AgentMessagingGatewayPort} from '../../packages/agent-messaging/ports.js';
export type GatewayAwaitable<T>=T|Promise<T>;
type AwaitableMethods<T,K extends keyof T>={
  [P in K]:T[P] extends (...args:infer A)=>infer R?(...args:A)=>GatewayAwaitable<Awaited<R>>:never;
};
export type GatewayTaskPort=TaskServicePort&AwaitableMethods<TaskService,'downloadArtifact'|'close'>;
export interface GatewaySecurityPort {
  permissions:MemberPermissionCoordinatorPort;
  authenticate(principal:Principal,bearer:string):GatewayAwaitable<AccessContext>;
  available():GatewayAwaitable<boolean>;
  onUnavailable(handler:()=>void):void;
}
export interface GatewayRelayPort {
  status():GatewayAwaitable<TaskRelayGateway['status']>;
  mount(app:Express,authenticate:RequestHandler,principal:(request:Request)=>Principal):void;
}
export interface GatewayMessagingPort {
  service:AgentMessagingGatewayPort;
  /** The actual member-session/CSRF routes of this runtime, with the same store. */
  mountMembers(app:Express):void;
}
/** Runtime-owned storage and lifecycle. No model/provider execution is allowed
 * while assembling or starting a Gateway. The host binds all ports to the
 * same reviewed primary; a feature adapter cannot select another database. */
export interface GatewayRuntimePorts {
  backend:'sqlite'|'postgres';
  authority?:{id:string;revision:number;digest:string};
  tasks:GatewayTaskPort;
  members:MemberStoragePort;
  security?:GatewaySecurityPort;
  definitions:DefinitionServicePort;
  relay?:GatewayRelayPort;
  messaging?:GatewayMessagingPort;
  authorityCurrent():GatewayAwaitable<boolean>;
  ontologyRelease():GatewayAwaitable<OntologyReleaseRef>;
  start():GatewayAwaitable<void>;
  close():GatewayAwaitable<void>;
  /** Legacy adapters retain their exact existing routes and transport readers. */
  legacy?:{
    network?:NetworkService;
    sources?:MemberSourceService;
    mount(app:Express,authenticate:RequestHandler,principal:(request:Request)=>Principal):void;
  };
}
export interface GatewayApplication {
  app:Express;
  tasks:GatewayTaskPort;
  start():Promise<void>;
  close():Promise<void>;
  onUnavailable(handler:()=>void):void;
}
export type GatewayApplicationFactory=(config:Config)=>GatewayAwaitable<GatewayApplication>;
