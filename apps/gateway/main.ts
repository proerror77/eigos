import { readConfig, configuredSource } from '../../packages/core/config.js';
import { Database } from '../../packages/runtime/database.js';
import { createApp } from './app.js';

const config = readConfig(), db = new Database(config.DATABASE_URL, config.EIGOS_PG_SCHEMA);
const gateway = createApp(config, db, configuredSource(config.EIGOS_DIDI_CONNECTION_FILE));
await gateway.metadata.active();
const server = gateway.app.listen(config.PORT, config.HOST, () => console.log(`EIGOS listening on ${config.HOST}:${config.PORT}`));
const close = () => server.close(() => { void db.close(); });
process.on('SIGTERM', close); process.on('SIGINT', close);
