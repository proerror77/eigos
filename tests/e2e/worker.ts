import { Database } from '../../packages/runtime/database.js';
import { Metadata } from '../../packages/runtime/metadata.js';
import { Tasks } from '../../packages/runtime/tasks.js';
import { rideCapabilities } from '../../packages/capabilities/didi/pipeline.js';
import { OntologyAgent } from '../../packages/runtime/agent.js';
import { FixtureAgent } from '../agent-driver.js';
import { Worker } from '../../apps/worker/worker.js';
import { provider } from '../fixture.js';

const db = new Database(process.env.EIGOS_TEST_DATABASE_URL!, process.env.EIGOS_PG_SCHEMA), metadata = new Metadata(db), tasks = new Tasks(db, metadata);
const source = await provider(), worker = new Worker(tasks, new OntologyAgent(db, metadata, tasks, rideCapabilities(db, async () => source.source), new FixtureAgent()));
process.on('SIGTERM', () => worker.stop());
process.send?.('ready');
try { await worker.run(); } finally { await source.close(); await db.close(); }
