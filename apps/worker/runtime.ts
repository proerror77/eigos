import { createExecutionCatalog } from '../../packages/capabilities/catalog.js';
import { Coordinator, CodexReasoner, type Reasoner } from '../../packages/coordinator/coordinator.js';
import { assertPersonalSourceConfig, type Config } from '../../packages/core/config.js';
import { assertSourceProxy } from '../../packages/core/private-source-proxy.js';
import { JobStore } from '../../packages/core/store.js';
import { CodexExecutor, type Executor } from '../../packages/capabilities/executor.js';
import { Worker } from './worker.js';

export function createWorker(config: Config, overrides: {
  reasoner?: Reasoner; store?: JobStore; executor?: Executor;
  timing?: { leaseMs?: number; pollMs?: number; timeoutMs?: number };
} = {}) {
  assertPersonalSourceConfig(config);
  assertSourceProxy(config);
  if (!overrides.store && config.DATABASE_PATH === ':memory:') throw new Error('Separate Gateway and Worker require a shared database file');
  const store = overrides.store ?? new JobStore(config.DATABASE_PATH);
  try {
    const model = new CodexExecutor(config.EIGOS_CODEX_BIN, config.EIGOS_EXECUTOR_TIMEOUT_MS, {
      model: config.EIGOS_CODEX_MODEL, reasoningEffort: config.EIGOS_CODEX_REASONING_EFFORT, serviceTier: config.EIGOS_CODEX_SERVICE_TIER,
    });
    const catalog = createExecutionCatalog({ store, csvInputDirectory: config.EIGOS_CSV_PILOT === 'true' ? config.EIGOS_CSV_INPUT_DIR : undefined,
      documentEnabled: config.EIGOS_EXECUTOR === 'codex', documentExecutor: overrides.executor ?? model,
      paotuiSkillDirectory: config.EIGOS_PAOTUI_SKILL_DIR, paotuiMemberConnectionFile: config.EIGOS_PAOTUI_MEMBER_CONNECTION_FILE, memberSourceKeyFile: config.EIGOS_MEMBER_SOURCE_KEY_FILE, executionHost: 'worker', ontologyAuditPath: config.EIGOS_ONTOLOGY_AUDIT_PATH,
      publicGeoDiscoveryQueries: config.EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES,
      didi: config.EIGOS_DIDI_KEY_FILE ? { keyFile: config.EIGOS_DIDI_KEY_FILE, keySha256: config.EIGOS_DIDI_KEY_SHA256!, bindingId: config.EIGOS_DIDI_BINDING_ID!, bookingEnabled: config.EIGOS_DIDI_ORDERS_ENABLED === 'mock', environment: config.EIGOS_DIDI_ENVIRONMENT, auditDirectory: config.EIGOS_DIDI_AUDIT_DIR } : undefined,
      shopifyCatalog: config.EIGOS_SHOPIFY_CATALOG_MERCHANTS?.length ? { merchants: config.EIGOS_SHOPIFY_CATALOG_MERCHANTS, auditDirectory: config.EIGOS_SHOPIFY_AUDIT_DIR } : undefined,
      participantBooking: config.EIGOS_FREE_BOOKING_BRIDGE_URL ? { endpoint: config.EIGOS_FREE_BOOKING_BRIDGE_URL, tokenFile: config.EIGOS_FREE_BOOKING_TOKEN_FILE!, bindingId: config.EIGOS_FREE_BOOKING_BINDING_ID!, attendeeRef: config.EIGOS_FREE_BOOKING_ATTENDEE_SHA256! } : undefined,
      bookingSandbox: config.EIGOS_BOOKING_SANDBOX_URL ? { endpoint: config.EIGOS_BOOKING_SANDBOX_URL, tokenFile: config.EIGOS_BOOKING_SANDBOX_TOKEN_FILE! } : undefined,
      commerceSandbox: config.EIGOS_COMMERCE_SANDBOX_URL ? { endpoint: config.EIGOS_COMMERCE_SANDBOX_URL, tokenFile: config.EIGOS_COMMERCE_SANDBOX_TOKEN_FILE!, auditDirectory: config.EIGOS_COMMERCE_SANDBOX_AUDIT_DIR } : undefined,
      sandbox: config.EIGOS_SANDBOX_PROVIDER_URL ? { endpoint: config.EIGOS_SANDBOX_PROVIDER_URL, tokenFile: config.EIGOS_SANDBOX_TOKEN_FILE! } : undefined });
    const worker = new Worker(store, { coordinator: new Coordinator(store, overrides.reasoner ?? new CodexReasoner(model), catalog,
      { allowSandbox: config.EIGOS_ACTION_SANDBOX === 'true', maxTaskMs: config.EIGOS_TASK_MAX_MS ?? 86400000 }), ...overrides.timing });
    worker.start();
    return { worker, close: async () => { await worker.close(); if (!overrides.store) store.close(); } };
  } catch (error) { if (!overrides.store) store.close(); throw error; }
}
