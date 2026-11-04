import {setImmediate as yieldToHost} from 'node:timers/promises';
import {StagedKernelBuilder,stagedKernelComponents} from '../ontology/seed-definition.js';

/** Prepare the existing trusted kernel before starting eligibility publishers
 * or accepting work. Construction publishes nothing and reads no database.
 * Yield between audited stages so sockets, timers and cancellation can run. */
export async function preparePostgresKernel(signal?:AbortSignal,options:{semanticRetrieval?:boolean}={}):Promise<StagedKernelBuilder>{
  signal?.throwIfAborted();const kernel=new StagedKernelBuilder(options);
  for(let stage=0;stage<StagedKernelBuilder.stages;stage++){
    signal?.throwIfAborted();kernel.step(stage);await yieldToHost();
  }
  signal?.throwIfAborted();stagedKernelComponents(kernel);return kernel;
}
