import { FunctionInvocations } from '../../packages/runtime/function-invocations.js';
import type { Installation } from '../../packages/runtime/installation.js';
import { checkInstallation, openInstallation } from '../../packages/runtime/open-installation.js';
import { ObservationInterests } from '../../packages/runtime/observation-interests.js';
import { ProcessNotifications } from '../../packages/runtime/process-notifications.js';
import { setTimeout as delay } from 'node:timers/promises';
import { assertOwnerIsolation } from '../../packages/runtime/owner-isolation.js';
import { Indexing } from '../../packages/runtime/indexing.js';
import { Scenarios } from '../../packages/runtime/scenarios.js';
import { ScenarioEvaluations } from '../../packages/runtime/scenario-evaluation.js';
import { MachineryReviews } from '../../packages/runtime/machinery-reviews.js';
import { Automation } from '../../packages/runtime/automation.js';
import { dispatchAutomation } from './dispatch.js';
import { ChangeSubscriptions } from '../../packages/runtime/change-subscriptions.js';
import { Tasks } from '../../packages/runtime/tasks.js';

export async function startIndexer(installation: Installation) {
  const { db, metadata } = openInstallation(installation);
  await assertOwnerIsolation(db);
  const notifications = new ProcessNotifications(db, metadata);
  const capabilities = installation.assemble(db);
  await checkInstallation(installation, metadata, capabilities);
  const indexing = new Indexing(db, metadata);
  const { effects } = capabilities;
  const automation = new Automation(db, metadata, capabilities.actions);
  const scenarios = new Scenarios(db);
  const observations = new ObservationInterests(db,metadata);
  const subscriptions = new ChangeSubscriptions(db, new Tasks(db, metadata));
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
    scans: [() => observations.scanOne(), () => automation.scanObjectRules(), () => automation.scanProcessRules(), () => subscriptions.scanOne(),
      () => notifications.deliverOne(),
      () => scenarios.syncOne(metadata)],
    run: signal => automation.runOne(signal),
  }, controller.signal);
  async function reviewProcesses() {
    while (!controller.signal.aborted) {
      if (!await machinery.scanOne()) {
        await delay(60000, undefined, { signal: controller.signal }).catch(() => {});
      }
    }
  }
  async function pruneFunctionInvocations() {
    const invocations = new FunctionInvocations(db);
    while (!controller.signal.aborted) {
      try { await invocations.prune(); }
      catch { console.error('Could not expire Function invocations'); }
      await delay(3600_000, undefined, { signal: controller.signal }).catch(() => {});
    }
  }
  const jobs = [indexing.run(controller.signal), dispatch(), deliverEffects(), reviewProcesses(), pruneFunctionInvocations()];
  try { await Promise.all(jobs); }
  catch (error) { if (!controller.signal.aborted) throw error; }
  finally { controller.abort(); await Promise.allSettled(jobs); await db.close(); }
}
