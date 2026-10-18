// Explicit same-process test harness; it uses the same ontology backend as production.
import { createApp } from './gateway/app.js';
import type { VerifyToken } from './gateway/auth.js';
import type { Config } from '../packages/core/config.js';
import type { Executor } from '../packages/capabilities/executor.js';
import type { Reasoner } from '../packages/coordinator/coordinator.js';
import { createWorker } from './worker/runtime.js';
export function createLocalApp(config: Config, verify?: VerifyToken, overrides: { reasoner?: Reasoner; executor?: Executor } = {}) {
  const gateway = createApp(config, verify);
  const runtime = createWorker(config, { store: gateway.store, ...overrides });
  return { ...gateway, close: async () => { await runtime.close(); await gateway.close(); } };
}
