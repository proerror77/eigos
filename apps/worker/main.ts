import { readWorkerConfig } from '../../packages/core/config.js';
import { createWorker } from './runtime.js';

const config=readWorkerConfig();
async function createConfiguredWorker(){
  if(config.EIGOS_STORAGE_BACKEND!=='postgres')return createWorker(config);
  if(config.EIGOS_EXECUTOR==='disabled')throw new Error('PostgreSQL Worker model execution is disabled');
  const {createPostgresPrimaryHostResources,assertPostgresBuiltinSourceConfiguration,assertPostgresRelayHostConfiguration}=await import('../../packages/postgres/host-runtime.js');
  assertPostgresBuiltinSourceConfiguration(config);
  const resources=await createPostgresPrimaryHostResources(config,'worker');
  try{
    // Validate the same reviewed feature binding without opening Relay node
    // credentials or creating another publisher/network client in the Worker.
    assertPostgresRelayHostConfiguration(config,resources.binding);
    await resources.requireWorkerReadiness();
    const factory=await import('./postgres-runtime.js');
    if(config.EIGOS_EXECUTOR==='harness'&&typeof factory.postgresHarnessReasoner!=='function')throw new Error('The configured PostgreSQL Harness runtime is not installed');
    // Pass the original model/backend configuration through unchanged. This
    // host owns pools only; it never starts a second publisher or grants rights.
    const candidate=factory.createPostgresWorker(config,{database:resources.database,policyDigest:resources.binding.policyDigest,builder:resources.kernel});
    let closing:Promise<void>|undefined;
    const close=()=>closing??=(async()=>{const errors:unknown[]=[];try{await candidate.close();}catch(error){errors.push(error);}try{await resources.close();}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'PostgreSQL Worker shutdown failed');})();
    try{candidate.start();return {worker:candidate.worker,close};}catch(error){await close();throw error;}
  }catch(error){try{await resources.close();}catch(cleanup){throw new AggregateError([error,cleanup],'PostgreSQL Worker startup failed',{cause:error});}throw error;}
}
const runtime = await createConfiguredWorker();
console.log('EIGOS Worker started; waiting for durable tasks');
let stopping = false;
const stop = (code = 0) => { if (stopping) return; stopping = true; process.exitCode = code; void runtime.close().then(() => { if (process.connected) process.disconnect(); }, () => { process.exitCode = 1; if (process.connected) process.disconnect(); }); };
if (process.env.EIGOS_RELAY_CUTOVER_SIGNALS === 'true' && process.send) {
  const report = (type: string) => { if (process.connected) process.send?.({ type }, error => { if (error) stop(1); }); };
  process.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object' || !('type' in message)) return;
    if (message.type === 'relay-cutover-drain') {
      void runtime.worker.pauseClaims().then(() => report('relay-cutover-drained'), () => report('relay-cutover-drain-failed'));
    } else if (message.type === 'relay-cutover-resume') {
      try { runtime.worker.resumeClaims(); report('relay-cutover-resumed'); }
      catch { report('relay-cutover-resume-failed'); }
    }
  });
  process.on('disconnect', () => stop(1));
}
process.on('SIGTERM', () => stop());
process.on('SIGINT', () => stop());
