import { createGateway } from './app.js';
import { readConfig } from '../../packages/core/config.js';

const config = readConfig();
if (config.DATABASE_PATH === ':memory:') throw new Error('Separate Gateway and Worker require a shared database file');
const gateway = await createGateway(config);
await gateway.start();
const server = gateway.app.listen(config.PORT, config.HOST, () => {
  console.log(`EIGOS Gateway listening at ${config.PUBLIC_URL}; auth=${config.EIGOS_AUTH_MODE}`);
  if (process.env.EIGOS_RELAY_CUTOVER_SIGNALS === 'true' && process.connected) process.send?.({ type: 'relay-cutover-gateway-ready' }, error => { if (error) stop(1); });
});
let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true; process.exitCode = code;
  // End polling responses before waiting for HTTP connections to drain.
  void gateway.tasks.close();
  server.close(() => { void gateway.close().then(() => { if (process.connected) process.disconnect(); }, () => { process.exitCode = 1; if (process.connected) process.disconnect(); }); });
};
// The resident supervisor restarts the whole process group. New startup must
// acquire the manager lease and recheck membership; it never renews grants.
gateway.onUnavailable(() => stop(1));
process.on('SIGTERM', () => stop());
process.on('SIGINT', () => stop());
if (process.env.EIGOS_RELAY_CUTOVER_SIGNALS === 'true' && process.send) process.on('disconnect', () => stop(1));
