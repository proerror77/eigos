import { createApp } from './app.js';
import { readConfig } from './config.js';

const config = readConfig();
const gateway = createApp(config);
const server = gateway.app.listen(config.PORT, config.HOST, () => {
  console.log(`EIGOS listening at ${config.PUBLIC_URL}; auth=${config.EIGOS_AUTH_MODE}`);
});
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  server.close(() => { void gateway.close(); });
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
