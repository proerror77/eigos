import { Database } from '../../packages/runtime/database.js';
import { Metadata } from '../../packages/runtime/metadata.js';
import { Tasks } from '../../packages/runtime/tasks.js';
import { RideWorkflow } from '../../packages/capabilities/didi/workflow.js';
import { Worker } from '../../apps/worker/worker.js';
import { provider } from '../fixture.js';

const db = new Database(process.env.EIGOS_TEST_DATABASE_URL!, process.env.EIGOS_PG_SCHEMA), metadata = new Metadata(db), tasks = new Tasks(db, metadata);
const source = await provider(), worker = new Worker(tasks, new RideWorkflow(db, metadata, tasks, async () => source.source));
process.on('SIGTERM', () => worker.stop());
process.send?.('ready');
try { await worker.run(); } finally { await source.close(); await db.close(); }
