import { createExecutionCatalog } from '../../packages/capabilities/catalog.js';
import { Coordinator, CodexReasoner, type Reasoner } from '../../packages/coordinator/coordinator.js';
import type { Config } from '../../packages/core/config.js';
import { JobStore } from '../../packages/core/store.js';
import { CodexExecutor, type Executor } from '../../packages/capabilities/executor.js';
import { Worker } from './worker.js';

export function createWorker(config: Config, overrides: {
  reasoner?: Reasoner; store?: JobStore; executor?: Executor;
  timing?: { leaseMs?: number; pollMs?: number; timeoutMs?: number };
} = {}) {
  if (!overrides.store && config.DATABASE_PATH === ':memory:') throw new Error('Separate Gateway and Worker require a shared database file');
  const store = overrides.store ?? new JobStore(config.DATABASE_PATH);
  try {
    const model = new CodexExecutor(config.EIGOS_CODEX_BIN, config.EIGOS_EXECUTOR_TIMEOUT_MS);
    const catalog = createExecutionCatalog({ store, csvInputDirectory: config.EIGOS_CSV_PILOT === 'true' ? config.EIGOS_CSV_INPUT_DIR : undefined,
      documentEnabled: config.EIGOS_EXECUTOR === 'codex', documentExecutor: overrides.executor ?? model,
      paotuiSkillDirectory: config.EIGOS_PAOTUI_SKILL_DIR, ontologyAuditPath: config.EIGOS_ONTOLOGY_AUDIT_PATH,
      publicGeoDiscoveryQueries: config.EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES,
      shopifyCatalog: config.EIGOS_SHOPIFY_CATALOG_MERCHANTS?.length ? { merchants: config.EIGOS_SHOPIFY_CATALOG_MERCHANTS, auditDirectory: config.EIGOS_SHOPIFY_AUDIT_DIR } : undefined,
      sandbox: config.EIGOS_SANDBOX_PROVIDER_URL ? { endpoint: config.EIGOS_SANDBOX_PROVIDER_URL, tokenFile: config.EIGOS_SANDBOX_TOKEN_FILE! } : undefined });
    const worker = new Worker(store, { coordinator: new Coordinator(store, overrides.reasoner ?? new CodexReasoner(model), catalog,
      { allowSandbox: config.EIGOS_ACTION_SANDBOX === 'true', maxTaskMs: config.EIGOS_TASK_MAX_MS ?? 86400000 }), ...overrides.timing });
    worker.start();
    return { worker, close: async () => { await worker.close(); if (!overrides.store) store.close(); } };
  } catch (error) { if (!overrides.store) store.close(); throw error; }
}
