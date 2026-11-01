import { readWorkerConfig } from '../../packages/core/config.js';
import { createWorker } from './runtime.js';

const runtime = createWorker(readWorkerConfig());
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
