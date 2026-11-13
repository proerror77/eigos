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
import { ScheduledActions,ScheduledActionRunner } from '../../packages/runtime/scheduled-actions.js';

const db = new Database(process.env.EIGOS_TEST_DATABASE_URL!, process.env.EIGOS_PG_SCHEMA), metadata = new Metadata(db), tasks = new Tasks(db, metadata);
const driver: AgentDriver={model:'fixture-process-decisions',async run(prompt,tools,signal){
 const message=JSON.parse(prompt.split('\n').at(-1)!).userRequest.message;
 if(message==='luma discovery'){
  await tools.get('complete_with_action')!.invoke({action:{interface:{type:'EventSearch',implementation:'LumaEventSearch',action:'search'},input:{query:'synthetic event'}},read:{function:'readServiceSearch',resultParameter:'search'}});return;
 }
 return message.startsWith('{"planning":')?new PlanningFixtureAgent().run(prompt,tools):new FixtureAgent().run(prompt,tools,signal);
}};
const source = await provider(),capabilities=createCapabilities(db,async()=>source.source), worker = new Worker(tasks, new OntologyAgent(db, metadata, tasks, capabilities, driver),new ScheduledActions(db,metadata),new ScheduledActionRunner(db,metadata,tasks,capabilities.actions));
process.on('SIGTERM', () => worker.stop());
process.send?.('ready');
try { await worker.run(); } finally { await source.close(); await db.close(); }
