import { createRelayApp } from './app.js';
import { readRelayConfig } from './config.js';

const config = readRelayConfig(), relay = createRelayApp(config);
const server = relay.app.listen(config.port, config.host, () => { console.log(`EIGOS Relay listening at ${config.publicUrl}`); });
let stopping = false;
const stop = () => {
  if (stopping) return; stopping = true; relay.stop();
  server.close(() => relay.close());
};
server.on('error', () => { relay.close(); console.error('Relay listener failed'); process.exitCode = 1; });
process.on('SIGTERM', stop); process.on('SIGINT', stop);
