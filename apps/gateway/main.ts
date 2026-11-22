import { loadExtensions } from '../../packages/runtime/extensions.js';
import { readConfig, configuredSource } from '../../packages/core/config.js';
import { Database } from '../../packages/runtime/database.js';
import { createApp } from './app.js';
import { assertOwnerIsolation } from '../../packages/runtime/owner-isolation.js';

const config = readConfig(), db = new Database(config.DATABASE_URL, config.EIGOS_PG_SCHEMA, undefined, config.QUERY_DATABASE_URL);
await assertOwnerIsolation(db);
const gateway = createApp(config, db, configuredSource(config.EIGOS_DIDI_CONNECTION_FILE, config.EIGOS_DIDI_WATCH_SANDBOX_CONNECTION_FILE),undefined,await loadExtensions(config.EIGOS_EXTENSION_MODULE));
gateway.metadata.checkBindings(await gateway.metadata.active(), gateway.capabilities);
const server = gateway.app.listen(config.PORT, config.HOST, () => {
  console.log(`EIGOS listening on ${config.HOST}:${config.PORT}`);
  if (config.OAUTH_MEMBER_MCP_CLIENT_ID) console.log(`EIGOS account sign-up mode: ${config.EIGOS_SIGNUP}`);
});
const close = () => server.close(() => { void db.close(); });
process.on('SIGTERM', close); process.on('SIGINT', close);
