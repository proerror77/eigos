import { createExecutionCatalog } from '../../packages/capabilities/catalog.js';
import { Coordinator, CodexReasoner, type Reasoner } from '../../packages/coordinator/coordinator.js';
import type { Config } from '../../packages/core/config.js';
import { JobStore } from '../../packages/core/store.js';
import { CodexExecutor, type Executor } from '../../packages/capabilities/executor.js';
import { LocalPaotuiReader } from '../../packages/capabilities/paotui.js';
import { PaotuiOrders, type PaotuiOrderProvider } from '../../packages/capabilities/paotui-orders.js';
import { AuditPilot } from '../../packages/capabilities/pilot/service.js';
import { Worker } from './worker.js';

export function createWorker(config: Config, overrides: {
  reasoner?: Reasoner; store?: JobStore; executor?: Executor; orderProvider?: PaotuiOrderProvider;
  pilotFactory?: (store: JobStore) => AuditPilot;
  timing?: { leaseMs?: number; pollMs?: number; timeoutMs?: number };
} = {}) {
  if (!overrides.store && config.DATABASE_PATH === ':memory:') throw new Error('Separate Gateway and Worker require a shared database file');
  const store = overrides.store ?? new JobStore(config.DATABASE_PATH);
  const ontologyBackend = config.EIGOS_COORDINATOR === 'codex';
  let orders: PaotuiOrders | undefined;
  try {
    const paotui = !ontologyBackend && config.EIGOS_PAOTUI_SKILL_DIR ? new LocalPaotuiReader(config.EIGOS_PAOTUI_SKILL_DIR, config.EIGOS_PAOTUI_ORDERS_ENABLED === 'true') : undefined;
    orders = paotui ? new PaotuiOrders(config.DATABASE_PATH === ':memory:' ? ':memory:' : config.DATABASE_PATH + '.paotui', overrides.orderProvider ?? paotui, config.EIGOS_PAOTUI_ORDERS_ENABLED === 'true') : undefined;
    const pilot = !ontologyBackend && config.EIGOS_CSV_PILOT === 'true' ? (overrides.pilotFactory?.(store) ?? new AuditPilot(store)) : undefined;
    const catalog = createExecutionCatalog({ csvInputDirectory: config.EIGOS_CSV_PILOT === 'true' ? config.EIGOS_CSV_INPUT_DIR : undefined,
      documentEnabled: config.EIGOS_EXECUTOR === 'codex', documentExecutor: overrides.executor ?? (config.EIGOS_EXECUTOR === 'codex' ? new CodexExecutor(config.EIGOS_CODEX_BIN, config.EIGOS_EXECUTOR_TIMEOUT_MS) : undefined), paotuiSkillDirectory: config.EIGOS_PAOTUI_SKILL_DIR, ontologyAuditPath: config.EIGOS_ONTOLOGY_AUDIT_PATH,
      sandbox: config.EIGOS_SANDBOX_PROVIDER_URL ? { endpoint: config.EIGOS_SANDBOX_PROVIDER_URL, tokenFile: config.EIGOS_SANDBOX_TOKEN_FILE! } : undefined });
    const worker = new Worker(store, {
      coordinator: config.EIGOS_COORDINATOR === 'codex' ? new Coordinator(store, overrides.reasoner ?? new CodexReasoner(new CodexExecutor(config.EIGOS_CODEX_BIN, config.EIGOS_EXECUTOR_TIMEOUT_MS)), catalog, { allowSandbox: config.EIGOS_ACTION_SANDBOX === 'true', maxTaskMs: config.EIGOS_TASK_MAX_MS ?? 86400000 }) : undefined,
      executor: ontologyBackend ? undefined : overrides.executor ?? (config.EIGOS_EXECUTOR === 'codex' ? new CodexExecutor(config.EIGOS_CODEX_BIN, config.EIGOS_EXECUTOR_TIMEOUT_MS) : undefined),
      paotui, paotuiOrders: orders,
      maintenance: pilot ? () => pilot.tick() : undefined,
      ...overrides.timing,
    });
    worker.start();
    return { worker, close: async () => { await worker.close(); orders?.close(); if (!overrides.store) store.close(); } };
  } catch (error) { orders?.close(); if (!overrides.store) store.close(); throw error; }
}
