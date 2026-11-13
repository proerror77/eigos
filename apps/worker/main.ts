import { readConfig, configuredSource } from '../../packages/core/config.js';
import { Database } from '../../packages/runtime/database.js';
import { Metadata } from '../../packages/runtime/metadata.js';
import { Tasks } from '../../packages/runtime/tasks.js';
import { createCapabilities } from '../../packages/capabilities/index.js';
import { OntologyAgent } from '../../packages/runtime/agent.js';
import { HarnessAgent } from '../../packages/runtime/harness.js';
import { Worker } from './worker.js';

const config = readConfig(), db = new Database(config.DATABASE_URL, config.EIGOS_PG_SCHEMA), metadata = new Metadata(db);
if (!config.EIGOS_HARNESS_BIN || !config.EIGOS_HARNESS_CREDENTIAL_FILE) throw new Error('Worker requires its cloud model runtime and credential file');
const tasks = new Tasks(db, metadata), capabilities = createCapabilities(db, configuredSource(config.EIGOS_DIDI_CONNECTION_FILE));
metadata.checkBindings(await metadata.active(), capabilities);
const driver = new HarnessAgent({ binary: config.EIGOS_HARNESS_BIN, credentialFile: config.EIGOS_HARNESS_CREDENTIAL_FILE, model: config.EIGOS_HARNESS_MODEL, reasoningEffort: config.EIGOS_HARNESS_REASONING_EFFORT });
const worker = new Worker(tasks, new OntologyAgent(db, metadata, tasks, capabilities, driver));
process.on('SIGTERM', () => { void worker.stop(); });
process.on('SIGINT', () => { void worker.stop(); });
try { await worker.run(); } finally { await db.close(); }
