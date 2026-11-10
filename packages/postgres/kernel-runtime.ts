import {setImmediate as yieldToHost} from 'node:timers/promises';
import {StagedKernelBuilder,stagedKernelComponents,CURRENT_KERNEL_VERSION,type ReviewedKernelVersion} from '../ontology/seed-definition.js';

/** Prepare the existing trusted kernel before starting eligibility publishers
 * or accepting work. Construction publishes nothing and reads no database.
 * Yield between audited stages so sockets, timers and cancellation can run. */
export async function preparePostgresKernel(signal?:AbortSignal,targetVersion:ReviewedKernelVersion=CURRENT_KERNEL_VERSION):Promise<StagedKernelBuilder>{
  signal?.throwIfAborted();const kernel=new StagedKernelBuilder(targetVersion);
  // Drive the builder by its own progress: every reviewed target has a different
  // stage count (14/15/16/17), so a fixed loop silently stopped short of the
  // classification and vocabulary releases.
  let progress=kernel.step(0);
  while(!progress.ready){signal?.throwIfAborted();await yieldToHost();progress=kernel.step(progress.completed);}
  signal?.throwIfAborted();kernel.installExecutableContracts();signal?.throwIfAborted();stagedKernelComponents(kernel);return kernel;
}
