import type { Database } from '../../packages/runtime/database.js';
import type { InstalledRuntime } from '../../packages/runtime/installation.js';
import { readConfig } from '../../packages/core/config.js';
import { assertOwnerIsolation } from '../../packages/runtime/owner-isolation.js';
import type { Installation } from '../../packages/runtime/installation.js';
import { openInstallation } from '../../packages/runtime/open-installation.js';
import { createHostApp } from './host.js';

export async function startGateway(installation: Installation, adapter?: (config: ReturnType<typeof readConfig>, db: Database, capabilities: InstalledRuntime) => ReturnType<typeof createHostApp>) {
  const config = readConfig();
  const { db } = openInstallation(installation);
  await assertOwnerIsolation(db);
  const capabilities = installation.assemble(db);
  const gateway = adapter ? adapter(config, db, capabilities) : createHostApp(config, db, capabilities, installation.model.document.id);
  gateway.metadata.checkBindings(await gateway.metadata.active(), gateway.capabilities);
  const server = gateway.app.listen(config.PORT, config.HOST, () => {
    console.log(`EIGOS listening on ${config.HOST}:${config.PORT}`);
    if (config.OAUTH_MEMBER_MCP_CLIENT_ID) console.log(`EIGOS account sign-up mode: ${config.EIGOS_SIGNUP}`);
  });
  const close = () => server.close(() => { void db.close(); });
  process.on('SIGTERM', close); process.on('SIGINT', close);
}
