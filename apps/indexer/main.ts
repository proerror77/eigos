import { setTimeout as delay } from 'node:timers/promises';
import { Database } from '../../packages/runtime/database.js';
import { assertOwnerIsolation } from '../../packages/runtime/owner-isolation.js';
import { Indexing } from '../../packages/runtime/indexing.js';
import { loadExtensions } from '../../packages/runtime/extensions.js';
import { Metadata } from '../../packages/runtime/metadata.js';
import { Scenarios } from '../../packages/runtime/scenarios.js';
import { Automation } from '../../packages/runtime/automation.js';
import { createCapabilities } from '../../packages/capabilities/index.js';
import { configuredSource } from '../../packages/core/config.js';
import { configuredServices } from '../../packages/capabilities/services/sources.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const db = new Database(process.env.DATABASE_URL, process.env.EIGOS_PG_SCHEMA);
await assertOwnerIsolation(db);
const extensions = await loadExtensions(process.env.EIGOS_EXTENSION_MODULE);
const metadata = new Metadata(db);
const capabilities = createCapabilities(db, configuredSource(process.env.EIGOS_DIDI_CONNECTION_FILE, process.env.EIGOS_DIDI_WATCH_SANDBOX_CONNECTION_FILE), extensions, configuredServices(process.env.EIGOS_SERVICE_CONNECTION_FILE), undefined, {
  amap: process.env.EIGOS_AMAP_CONNECTION_FILE, xiaohongshu: process.env.EIGOS_XIAOHONGSHU_CONNECTION_FILE, variFlight: process.env.EIGOS_VARIFLIGHT_CONNECTION_FILE,
  dianping: process.env.EIGOS_DIANPING_CONNECTION_FILE,
  travelPA: process.env.EIGOS_TRAVEL_PA_CONNECTION_FILE, calendar: process.env.EIGOS_JOURNEY_CALENDAR_CONNECTION_FILE,
});
const indexing = new Indexing(db, metadata);
const { effects } = capabilities;
const automation = new Automation(db, metadata, capabilities.actions);
const scenarios = new Scenarios(db);
const controller = new AbortController();
process.on('SIGTERM', () => controller.abort());
process.on('SIGINT', () => controller.abort());
const idle = () => delay(1000, undefined, { signal: controller.signal }).catch(() => {});
async function deliverEffects() {
  while (!controller.signal.aborted) {
    if (!await effects.runOne(controller.signal)) await idle();
  }
}
async function dispatch() {
  let nextCleanup = 0;
  while (!controller.signal.aborted) {
    if (Date.now() >= nextCleanup) {
      const cleaned = await scenarios.cleanup();
      nextCleanup = Date.now() + (cleaned.more ? 1000 : 60000);
    }
    let worked = await automation.scanOne();
    worked = await automation.runOne(controller.signal) || worked;
    if (!worked) await idle();
  }
}
const jobs = [indexing.run(controller.signal), dispatch(), deliverEffects()];
try { await Promise.all(jobs); }
catch (error) { if (!controller.signal.aborted) throw error; }
finally { controller.abort(); await Promise.allSettled(jobs); await db.close(); }
