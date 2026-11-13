import { setTimeout as delay } from 'node:timers/promises';
import { Database } from '../../packages/runtime/database.js';
import { Indexing } from '../../packages/runtime/indexing.js';
import { Effects } from '../../packages/runtime/effects.js';
import { loadExtensions } from '../../packages/runtime/extensions.js';
import { Metadata } from '../../packages/runtime/metadata.js';
import { Scenarios } from '../../packages/runtime/scenarios.js';
import { Automation } from '../../packages/runtime/automation.js';
import { createCapabilities } from '../../packages/capabilities/index.js';
import { configuredSource } from '../../packages/core/config.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const db = new Database(process.env.DATABASE_URL, process.env.EIGOS_PG_SCHEMA);
const extensions = await loadExtensions(process.env.EIGOS_EXTENSION_MODULE);
const metadata = new Metadata(db);
const capabilities = createCapabilities(db, configuredSource(process.env.EIGOS_DIDI_CONNECTION_FILE), extensions);
const indexing = new Indexing(db, metadata);
const effects = new Effects(db, extensions.effects ?? new Map());
const automation = new Automation(db, metadata, capabilities.actions);
const scenarios = new Scenarios(db);
const controller = new AbortController();
process.on('SIGTERM', () => controller.abort());
process.on('SIGINT', () => controller.abort());
async function dispatch() {
  let nextCleanup = 0;
  while (!controller.signal.aborted) {
    if (Date.now() >= nextCleanup) {
      const cleaned = await scenarios.cleanup();
      nextCleanup = Date.now() + (cleaned.more ? 1000 : 60000);
    }
    let worked = await automation.scanOne();
    worked = await automation.runOne(controller.signal) || worked;
    worked = await effects.runOne(controller.signal) || worked;
    if (!worked) await delay(1000, undefined, { signal: controller.signal }).catch(() => {});
  }
}
const jobs = [indexing.run(controller.signal), dispatch()];
try { await Promise.all(jobs); }
catch (error) { if (!controller.signal.aborted) throw error; }
finally { controller.abort(); await Promise.allSettled(jobs); await db.close(); }
