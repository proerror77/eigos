import {CodexExecutor,type Executor} from '../../packages/capabilities/executor.js';
import {HarnessExecutor} from '../../packages/capabilities/harness-executor.js';
import {isAbsolute} from 'node:path';
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

/** Same bounded reasoning programs, using the selected acknowledged Harness
 * transport. No app-server session or alternate model is offered by this view. */
export function postgresHarnessReasoner(model:HarnessExecutor):PostgresReasoner{
  if(!(model instanceof HarnessExecutor))throw new Error('Only the known Harness transport can be registered by this factory');
  const view={runStructured:model.runStructured.bind(model),securityChannelId:model.securityChannelId,ontologyTransport:model.ontologyTransport,
    ontologyContextPreparation:model.ontologyContextPreparation};
  return Object.assign(new CodexReasoner(view),{postgresModelDispatch:'acknowledged-v1' as const});
}

type PostgresModelConfig=Pick<Config,'EIGOS_CODEX_BIN'|'EIGOS_EXECUTOR_TIMEOUT_MS'|'EIGOS_CODEX_MODEL'|'EIGOS_CODEX_REASONING_EFFORT'|'EIGOS_CODEX_SERVICE_TIER'|'EIGOS_TASK_MAX_MS'>
  &Partial<Pick<Config,'EIGOS_EXECUTOR'|'EIGOS_HARNESS_BIN'|'EIGOS_HARNESS_CREDENTIAL_FILE'|'EIGOS_HARNESS_CREDENTIAL_KIND'|'EIGOS_HARNESS_MODEL'|'EIGOS_HARNESS_REASONING_EFFORT'|'EIGOS_HARNESS_MAX_TOKENS'>>;
function configuredModel(config:PostgresModelConfig):CodexExecutor|HarnessExecutor{
  if(config.EIGOS_EXECUTOR==='harness'){
    if(!config.EIGOS_HARNESS_CREDENTIAL_FILE||!isAbsolute(config.EIGOS_HARNESS_CREDENTIAL_FILE))throw new Error('PostgreSQL Harness Worker requires an absolute private credential file');
    return new HarnessExecutor(config.EIGOS_HARNESS_BIN??'dsh',config.EIGOS_EXECUTOR_TIMEOUT_MS,{
      credentialFile:config.EIGOS_HARNESS_CREDENTIAL_FILE,credentialKind:config.EIGOS_HARNESS_CREDENTIAL_KIND,
      model:config.EIGOS_HARNESS_MODEL,reasoningEffort:config.EIGOS_HARNESS_REASONING_EFFORT,maxTokens:config.EIGOS_HARNESS_MAX_TOKENS,
    });
  }
  if(config.EIGOS_EXECUTOR!==undefined&&config.EIGOS_EXECUTOR!=='codex')throw new Error('PostgreSQL Worker model execution is disabled');
  return new CodexExecutor(config.EIGOS_CODEX_BIN,config.EIGOS_EXECUTOR_TIMEOUT_MS,{model:config.EIGOS_CODEX_MODEL,reasoningEffort:config.EIGOS_CODEX_REASONING_EFFORT,serviceTier:config.EIGOS_CODEX_SERVICE_TIER});
}

/** Explicit Worker candidate for the configured execution host and model ports.
 * creating it does not start polling, switch primary, or change Gateway. The
 * caller owns the injected database/publisher lifecycle. */
export function createPostgresWorker(config:PostgresModelConfig,options:{
  database:PostgresDatabase;policyDigest:string;sourceBindingId?:string;builder?:StagedKernelBuilder;
  reasoner?:PostgresReasoner;executor?:PostgresExecutor;modelChannel?:string;
  timing?:{leaseMs?:number;pollMs?:number;timeoutMs?:number};
}){
  const model=!options.executor||!options.reasoner?(options.executor instanceof HarnessExecutor?options.executor:configuredModel(config)):undefined;
  // Only known implementations created here are registered by default. An
  // injected Harness/other port must declare AND implement the same contract;
  // existing unadapted synchronous recorder implementations are rejected.
  const executor=options.executor??Object.assign(model!,{postgresModelDispatch:'acknowledged-v1' as const}),reasoner=options.reasoner??(model instanceof HarnessExecutor?postgresHarnessReasoner(model):postgresCodexReasoner(model!)),modelChannel=options.modelChannel??reasoner.securityChannelId??executor.securityChannelId;
  const store=new PostgresWorkerStore(options.database,options.policyDigest,options.builder),coordinator=new PostgresCoordinator({...options,store,executor,reasoner,modelChannel,maxTaskMs:config.EIGOS_TASK_MAX_MS});
  const worker=new PostgresTaskWorker(store,{...options.timing,run:(claim,signal)=>coordinator.run(claim,signal),onError:(claim,error,signal)=>coordinator.onError(claim,error,signal)});
  return {worker,coordinator,store,start:()=>worker.start(),pause:()=>worker.pauseClaims(),resume:()=>worker.resumeClaims(),close:async()=>{await worker.close();await coordinator.closeModelContexts();}};
}
