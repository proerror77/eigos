import { CapabilityRegistry } from '../core/capabilities.js';
import type { JobStore } from '../core/store.js';
import type { PilotCommands } from './pilot/commands.js';
import { BriefCapability } from './brief.js';
import { CsvAuditCapability } from './pilot/capability.js';

// Composition root: new capabilities are added here, not in Coordinator or Worker.
export function createCapabilityRegistry(store: JobStore, options: { csvInputDirectory?: string; pilot?: PilotCommands; csvTick?: () => void } = {}): CapabilityRegistry {
  // Explicit compatibility migration for previously persisted CSV tasks.
  store.transaction(() => {
    for (const { owner, job } of store.pilotJobs()) {
      if (!job.executionMode) { job.executionMode = 'capability'; store.save(owner, job); }
    }
  });
  return new CapabilityRegistry([
    new BriefCapability(),
    ...(options.pilot && options.csvInputDirectory ? [new CsvAuditCapability(store, options.csvInputDirectory, options.pilot, options.csvTick)] : []),
  ]);
}
