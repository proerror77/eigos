import type { Installation } from '../../packages/runtime/installation.js';
import { openInstallation } from '../../packages/runtime/open-installation.js';
import { Tasks } from '../../packages/runtime/tasks.js';
import { OntologyAgent } from '../../packages/runtime/agent.js';
import { Worker } from './worker.js';
import { ScheduledActions, ScheduledActionRunner } from '../../packages/runtime/scheduled-actions.js';
import { assertOwnerIsolation } from '../../packages/runtime/owner-isolation.js';

export async function startWorker(installation: Installation) {
  const { db, metadata } = openInstallation(installation);
  await assertOwnerIsolation(db);
  const tasks = new Tasks(db, metadata);
  const capabilities = installation.assemble(db);
  metadata.checkBindings(await metadata.active(), capabilities);
  const driver = installation.driver();
  const worker = new Worker(tasks, new OntologyAgent(db, metadata, tasks, capabilities, driver, {
    sandbox: db.sandboxEnabled,
  }),new ScheduledActions(db,metadata,capabilities.scheduledTerminals),new ScheduledActionRunner(db,metadata,tasks,capabilities.actions));
  process.on('SIGTERM', () => { void worker.stop(); });
  process.on('SIGINT', () => { void worker.stop(); });
  try { await worker.run(); } finally { await db.close(); }
}
