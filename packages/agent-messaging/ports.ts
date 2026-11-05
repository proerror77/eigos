import type {AgentMessagingService} from './service.js';
import type {MessagingStore} from './store.js';
import type {RelayProtocolClient} from '../agent-transport/async-client.js';
import type {CommunicationGrant,MessagingIdentity} from './contracts.js';

type AwaitableMethods<T,K extends keyof T>={
  [P in K]:T[P] extends (...args:infer A)=>infer R?(...args:A)=>R|Promise<Awaited<R>>:never;
};

export type AgentMessagingExecutionPort=Pick<AgentMessagingService,'permissionsUrl'>&AwaitableMethods<AgentMessagingService,'execute'>;
export type AgentMessagingGatewayPort=AgentMessagingExecutionPort&AwaitableMethods<AgentMessagingService,'identity'|'readiness'>;
export type MessagingStoragePort=Pick<MessagingStore,'now'>&AwaitableMethods<MessagingStore,Exclude<keyof MessagingStore,'now'>>;
export type MessagingNodePort=Pick<RelayProtocolClient,'agentId'>&AwaitableMethods<RelayProtocolClient,'register'|'renew'|'contacts'|'requestContact'|'respondContact'|'queue'|'deliver'|'receipt'|'poll'|'markHandled'|'retainInboxMessage'|'readRetainedMessage'|'close'>;
export interface MessagingAdmissionPort {
  available():void;
  live(id:string):CommunicationGrant|Promise<CommunicationGrant>;
  authorized(identity:MessagingIdentity,scope:string):CommunicationGrant|Promise<CommunicationGrant>;
}
export type MessagingNodeFactory=(grant:CommunicationGrant,assertCurrent:()=>Promise<void>)=>Promise<MessagingNodePort>;
