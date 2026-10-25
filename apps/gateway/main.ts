import { createApp } from './app.js';
import { readConfig } from '../../packages/core/config.js';

const config = readConfig();
if (config.DATABASE_PATH === ':memory:') throw new Error('Separate Gateway and Worker require a shared database file');
const gateway = createApp(config);
const server = gateway.app.listen(config.PORT, config.HOST, () => {
  console.log(`EIGOS Gateway listening at ${config.PUBLIC_URL}; auth=${config.EIGOS_AUTH_MODE}`);
});
let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true; process.exitCode = code;
  // End polling responses before waiting for HTTP connections to drain.
  void gateway.tasks.close();
  server.close(() => { void gateway.close(); });
};
// The resident supervisor restarts the whole process group. New startup must
// acquire the manager lease and recheck membership; it never renews grants.
gateway.security?.onUnavailable(() => stop(1));
process.on('SIGTERM', () => stop());
process.on('SIGINT', () => stop());
