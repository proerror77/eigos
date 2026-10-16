// Explicit in-process harness for local examples/tests, including :memory: databases.
// Production entry points use apps/gateway/main.ts and apps/worker/main.ts separately.
import { createApp } from './gateway/app.js';
import type { VerifyToken } from './gateway/auth.js';
import type { Config } from '../packages/core/config.js';
import type { Executor } from '../packages/capabilities/executor.js';
import type { PaotuiOrderProvider } from '../packages/capabilities/paotui-orders.js';
import type { AuditPilot } from '../packages/capabilities/pilot/service.js';
import type { JobStore } from '../packages/core/store.js';
import { createWorker } from './worker/runtime.js';

export function createLocalApp(config: Config, verify?: VerifyToken, executor?: Executor, orderProvider?: PaotuiOrderProvider, pilotFactory?: (store: JobStore) => AuditPilot) {
  const gateway = createApp(executor ? { ...config, EIGOS_EXECUTOR: 'codex' } : config, verify);
  const runtime = createWorker(config, { store: gateway.store, executor, orderProvider, pilotFactory });
  return { ...gateway, close: async () => { await runtime.close(); await gateway.close(); } };
}
