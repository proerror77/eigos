import { ObservationInterests } from '../../packages/runtime/observation-interests.js';
import { setTimeout as delay } from 'node:timers/promises';
import { Database } from '../../packages/runtime/database.js';
import { assertOwnerIsolation } from '../../packages/runtime/owner-isolation.js';
import { Indexing } from '../../packages/runtime/indexing.js';
import { loadExtensions } from '../../packages/runtime/extensions.js';
import { Metadata } from '../../packages/runtime/metadata.js';
import { Scenarios } from '../../packages/runtime/scenarios.js';
import { ScenarioEvaluations } from '../../packages/runtime/scenario-evaluation.js';
import { MachineryReviews } from '../../packages/runtime/machinery-reviews.js';
import { Automation } from '../../packages/runtime/automation.js';
import { configuredCapabilities } from '../../packages/capabilities/index.js';
import { connectionConfigSchema } from '../../packages/core/config.js';
import { dispatchAutomation } from './dispatch.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const db = new Database(process.env.DATABASE_URL, process.env.EIGOS_PG_SCHEMA);
await assertOwnerIsolation(db);
const extensions = await loadExtensions(process.env.EIGOS_EXTENSION_MODULE);
const metadata = new Metadata(db);
const capabilities = configuredCapabilities(db, connectionConfigSchema.parse(process.env), extensions);
const indexing = new Indexing(db, metadata);
const { effects } = capabilities;
const automation = new Automation(db, metadata, capabilities.actions);
const scenarios = new Scenarios(db);
const observations = new ObservationInterests(db,metadata);
const machinery = new MachineryReviews(db, metadata, new ScenarioEvaluations(db, capabilities.actions, capabilities.functions));
const controller = new AbortController();
process.on('SIGTERM', () => controller.abort());
process.on('SIGINT', () => controller.abort());
const idle = () => delay(1000, undefined, { signal: controller.signal }).catch(() => {});
async function deliverEffects() {
  while (!controller.signal.aborted) {
    if (!await effects.runOne(controller.signal)) await idle();
  }
}
const dispatch = () => dispatchAutomation({
  cleanup: () => scenarios.cleanup(),
  scans: [() => observations.scanOne(), () => automation.scanOne()],
  run: signal => automation.runOne(signal),
}, controller.signal);
async function reviewProcesses() {
  while (!controller.signal.aborted) {
    if (!await machinery.scanOne()) {
      await delay(60000, undefined, { signal: controller.signal }).catch(() => {});
    }
  }
}
const jobs = [indexing.run(controller.signal), dispatch(), deliverEffects(), reviewProcesses()];
try { await Promise.all(jobs); }
catch (error) { if (!controller.signal.aborted) throw error; }
finally { controller.abort(); await Promise.allSettled(jobs); await db.close(); }
