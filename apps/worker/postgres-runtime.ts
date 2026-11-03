import {CodexExecutor,type Executor} from '../../packages/capabilities/executor.js';
import {CodexReasoner,type Reasoner} from '../../packages/coordinator/coordinator.js';
import type {Config} from '../../packages/core/config.js';
import type {PostgresDatabase} from '../../packages/postgres/database.js';
import type {StagedKernelBuilder} from '../../packages/ontology/seed-definition.js';
import {PostgresWorkerStore} from '../../packages/postgres/worker-store.js';
import {PostgresCoordinator,type PostgresReasoner,type PostgresExecutor} from '../../packages/postgres/coordinator.js';
import {PostgresTaskWorker} from './postgres-worker.js';

/** The app-server session transport still has synchronous-recorder behavior.
 * Keep it out of this PostgreSQL port. Both native reasoning and the separate
 * review therefore use the known acknowledged/pre-spawn-guarded exec transport,
 * with the very same configured model, binary, channel and native tool mode. */
export function postgresCodexReasoner(model:CodexExecutor):PostgresReasoner{
  if(!(model instanceof CodexExecutor))throw new Error('Only the known Codex transport can be registered by this factory');
  const view={runStructured:model.runStructured.bind(model),securityChannelId:model.securityChannelId,ontologyTransport:model.ontologyTransport,
    ontologyContextPreparation:model.ontologyContextPreparation,closeStructuredSessions:model.closeStructuredSessions.bind(model)};
  return Object.assign(new CodexReasoner(view),{postgresModelDispatch:'acknowledged-v1' as const});
}

/** Explicit Worker candidate for the configured execution host and model ports.
 * creating it does not start polling, switch primary, or change Gateway. The
 * caller owns the injected database/publisher lifecycle. */
export function createPostgresWorker(config:Pick<Config,'EIGOS_CODEX_BIN'|'EIGOS_EXECUTOR_TIMEOUT_MS'|'EIGOS_CODEX_MODEL'|'EIGOS_CODEX_REASONING_EFFORT'|'EIGOS_CODEX_SERVICE_TIER'|'EIGOS_TASK_MAX_MS'>,options:{
  database:PostgresDatabase;policyDigest:string;sourceBindingId?:string;builder?:StagedKernelBuilder;
  reasoner?:PostgresReasoner;executor?:PostgresExecutor;modelChannel?:string;
  timing?:{leaseMs?:number;pollMs?:number;timeoutMs?:number};
}){
  const model=!options.executor||!options.reasoner?new CodexExecutor(config.EIGOS_CODEX_BIN,config.EIGOS_EXECUTOR_TIMEOUT_MS,{model:config.EIGOS_CODEX_MODEL,reasoningEffort:config.EIGOS_CODEX_REASONING_EFFORT,serviceTier:config.EIGOS_CODEX_SERVICE_TIER}):undefined;
  // Only known implementations created here are registered by default. An
  // injected Harness/other port must declare AND implement the same contract;
  // existing unadapted synchronous recorder implementations are rejected.
  const executor=options.executor??Object.assign(model!,{postgresModelDispatch:'acknowledged-v1' as const}),reasoner=options.reasoner??postgresCodexReasoner(model!),modelChannel=options.modelChannel??reasoner.securityChannelId??executor.securityChannelId;
  const store=new PostgresWorkerStore(options.database,options.policyDigest,options.builder),coordinator=new PostgresCoordinator({...options,store,executor,reasoner,modelChannel,maxTaskMs:config.EIGOS_TASK_MAX_MS});
  const worker=new PostgresTaskWorker(store,{...options.timing,run:(claim,signal)=>coordinator.run(claim,signal),onError:(claim,error,signal)=>coordinator.onError(claim,error,signal)});
  return {worker,coordinator,store,start:()=>worker.start(),pause:()=>worker.pauseClaims(),resume:()=>worker.resumeClaims(),close:async()=>{await worker.close();await coordinator.closeModelContexts();}};
}
