import { createWorker } from '../../apps/worker/runtime.js';
import { readWorkerConfig } from '../../packages/core/config.js';
const runtime = createWorker(readWorkerConfig());
console.log(JSON.stringify({ ready: true, pid: process.pid }));
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; await runtime.close(); };
process.on('SIGTERM', () => { void stop(); }); process.on('SIGINT', () => { void stop(); });
