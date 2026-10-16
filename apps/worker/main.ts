import { readWorkerConfig } from '../../packages/core/config.js';
import { createWorker } from './runtime.js';

const runtime = createWorker(readWorkerConfig());
console.log('EIGOS Worker started; waiting for durable tasks');
let stopping = false;
const stop = () => { if (stopping) return; stopping = true; void runtime.close(); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
