import { Database } from '../../packages/runtime/database.js';
import { Metadata } from '../../packages/runtime/metadata.js';
import { Tasks } from '../../packages/runtime/tasks.js';
import { createCapabilities } from '../../packages/capabilities/index.js';
import { OntologyAgent } from '../../packages/runtime/agent.js';
import { FixtureAgent } from '../agent-driver.js';
import { PlanningFixtureAgent } from '../planning-fixture.js';
import type { AgentDriver } from '../../packages/runtime/agent.js';
import { Worker } from '../../apps/worker/worker.js';
import { provider } from '../fixture.js';

const db = new Database(process.env.EIGOS_TEST_DATABASE_URL!, process.env.EIGOS_PG_SCHEMA), metadata = new Metadata(db), tasks = new Tasks(db, metadata);
const driver: AgentDriver={model:'fixture-process-decisions',run(prompt,tools,signal){
 const message=JSON.parse(prompt.split('\n').at(-1)!).userRequest.message;
 return message.startsWith('{"planning":')?new PlanningFixtureAgent().run(prompt,tools):new FixtureAgent().run(prompt,tools,signal);
}};
const source = await provider(), worker = new Worker(tasks, new OntologyAgent(db, metadata, tasks, createCapabilities(db, async () => source.source), driver));
process.on('SIGTERM', () => worker.stop());
process.send?.('ready');
try { await worker.run(); } finally { await source.close(); await db.close(); }
