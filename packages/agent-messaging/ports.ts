import type {AgentMessagingService} from './service.js';

type AwaitableMethods<T,K extends keyof T>={
  [P in K]:T[P] extends (...args:infer A)=>infer R?(...args:A)=>R|Promise<Awaited<R>>:never;
};

export type AgentMessagingExecutionPort=Pick<AgentMessagingService,'permissionsUrl'>&AwaitableMethods<AgentMessagingService,'execute'>;
export type AgentMessagingGatewayPort=AgentMessagingExecutionPort&AwaitableMethods<AgentMessagingService,'identity'|'readiness'>;
