import { spawn } from 'node:child_process';

// Gateway and Worker share DATABASE_PATH; an optional browser bridge owns only
// its separate source queue and reads the original task database for authority.
const built = process.argv.includes('--built');
const managedCommerce=process.env.EIGOS_MANAGED_COMMERCE_SANDBOX==='true';
if(managedCommerce && (process.env.NODE_ENV==='production' || process.env.EIGOS_ACTION_SANDBOX!=='true' || !process.env.EIGOS_COMMERCE_SANDBOX_DATABASE || !process.env.EIGOS_COMMERCE_SANDBOX_PORT || process.env.EIGOS_COMMERCE_SANDBOX_URL!==`http://127.0.0.1:${process.env.EIGOS_COMMERCE_SANDBOX_PORT}`))throw new Error('Managed commerce simulator requires explicit local settings and an exact source port');
const children = new Set();
let stopping = false;
let forced;
let gateway;
let worker;
let pausingGateway = false;
let gatewayPaused = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true; process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
  forced = setTimeout(() => { for (const child of children) child.kill('SIGKILL'); }, 10000);
  forced.unref();
}
function start(role) {
  const args = built ? [`dist/apps/${role}/main.js`] : ['--import', 'tsx', `apps/${role}/main.ts`];
  const child = spawn(process.execPath, args, { stdio: 'inherit', env: process.env });
  if (role === 'gateway') gateway = child;
  if (role === 'worker') worker = child;
  children.add(child);
  child.on('error', () => stop(1));
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (role === 'gateway') gateway = undefined;
    if (role === 'worker') worker = undefined;
    if (!stopping && role === 'gateway' && pausingGateway && code === 0 && !signal) {
      if (!worker || worker.exitCode !== null || worker.signalCode !== null) return stop(1);
      pausingGateway = false; gatewayPaused = true;
      console.log('Gateway paused; Worker remains running');
    } else if (!stopping) stop(code === 0 && !signal ? 0 : 1);
    if (!children.size) clearTimeout(forced);
  });
}
for (const role of ['gateway', 'worker', ...(process.env.EIGOS_FREE_BOOKING_BROWSER_CONFIG ? ['participant-browser'] : []),...(managedCommerce?['commerce-sandbox']:[])]) start(role);
// Explicit operator opt-in. Signals are local OS process controls, not HTTP
// endpoints; a resumed process must still pass the normal health checks.
if (process.env.EIGOS_RELAY_CUTOVER_SIGNALS === 'true') {
  process.on('SIGUSR1', () => {
    if (stopping || pausingGateway || gatewayPaused) return;
    if (!gateway || gateway.exitCode !== null || gateway.signalCode !== null) return stop(1);
    pausingGateway = true;
    if (!gateway.kill('SIGTERM')) stop(1);
  });
  process.on('SIGUSR2', () => {
    if (stopping) return;
    if (pausingGateway) return;
    if (gatewayPaused) { gatewayPaused = false; start('gateway'); }
  });
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
