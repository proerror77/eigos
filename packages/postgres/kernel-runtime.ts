import {setImmediate as yieldToHost} from 'node:timers/promises';
import {StagedKernelBuilder,stagedKernelComponents,CURRENT_KERNEL_VERSION} from '../ontology/seed-definition.js';

/** Prepare the existing trusted kernel before starting eligibility publishers
 * or accepting work. Construction publishes nothing and reads no database.
 * Yield between audited stages so sockets, timers and cancellation can run. */
export async function preparePostgresKernel(signal?:AbortSignal,targetVersion:'27'|'28'|'29'|'30'=CURRENT_KERNEL_VERSION):Promise<StagedKernelBuilder>{
  signal?.throwIfAborted();const kernel=new StagedKernelBuilder(targetVersion);
  for(let stage=0;stage<(targetVersion==='30'?17:targetVersion==='29'?16:StagedKernelBuilder.stages);stage++){
    signal?.throwIfAborted();kernel.step(stage);await yieldToHost();
  }
  signal?.throwIfAborted();stagedKernelComponents(kernel);return kernel;
}
