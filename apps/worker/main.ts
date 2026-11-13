import { readConfig, configuredSource } from '../../packages/core/config.js';
import { Database } from '../../packages/runtime/database.js';
import { Metadata } from '../../packages/runtime/metadata.js';
import { Tasks } from '../../packages/runtime/tasks.js';
import { RideWorkflow } from '../../packages/capabilities/didi/workflow.js';
import { Worker } from './worker.js';

const config = readConfig(), db = new Database(config.DATABASE_URL, config.EIGOS_PG_SCHEMA), metadata = new Metadata(db);
await metadata.active();
const tasks = new Tasks(db, metadata), worker = new Worker(tasks, new RideWorkflow(db, metadata, tasks, configuredSource(config.EIGOS_DIDI_CONNECTION_FILE)));
process.on('SIGTERM', () => { void worker.stop(); });
process.on('SIGINT', () => { void worker.stop(); });
try { await worker.run(); } finally { await db.close(); }
