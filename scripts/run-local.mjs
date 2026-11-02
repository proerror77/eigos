import { spawn } from 'node:child_process';

// Gateway and Worker share DATABASE_PATH; an optional browser bridge owns only
// its separate source queue and reads the original task database for authority.
const built = process.argv.includes('--built');
const cutoverEnabled = process.env.EIGOS_RELAY_CUTOVER_SIGNALS === 'true';
const managedCommerce=process.env.EIGOS_MANAGED_COMMERCE_SANDBOX==='true';
if(managedCommerce && (process.env.NODE_ENV==='production' || process.env.EIGOS_ACTION_SANDBOX!=='true' || !process.env.EIGOS_COMMERCE_SANDBOX_DATABASE || !process.env.EIGOS_COMMERCE_SANDBOX_PORT || process.env.EIGOS_COMMERCE_SANDBOX_URL!==`http://127.0.0.1:${process.env.EIGOS_COMMERCE_SANDBOX_PORT}`))throw new Error('Managed commerce simulator requires explicit local settings and an exact source port');
const children = new Set();
let stopping = false;
let forced;
let gateway;
let worker;
let gatewayReady = false;
let cutover = 'running';
function stop(code = 0) {
  if (stopping) return;
  stopping = true; process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
  // Keep the Worker's 45s recovery and cleanup inside launchd's effective 60s
  // ceiling, rather than relying on a configured timeout the OS clamps.
  forced = setTimeout(() => { for (const child of children) child.kill('SIGKILL'); }, 50000);
  forced.unref();
}
function start(role) {
  const args = built ? [`dist/apps/${role}/main.js`] : ['--import', 'tsx', `apps/${role}/main.ts`];
  const child = spawn(process.execPath, args, { stdio: cutoverEnabled && (role === 'gateway' || role === 'worker') ? ['inherit','inherit','inherit','ipc'] : 'inherit', env: process.env });
  if (role === 'gateway') { gateway = child; gatewayReady = false; }
  if (role === 'worker') worker = child;
  children.add(child);
  child.on('error', () => stop(1));
  child.on('message', message => {
    if (stopping || !message || typeof message !== 'object') return;
    if (role === 'worker' && message.type === 'relay-cutover-drained' && cutover === 'draining') {
      if (!gateway || gateway.exitCode !== null || gateway.signalCode !== null) return stop(1);
      cutover = 'gateway-stopping';
      if (!gateway.kill('SIGTERM')) stop(1);
    } else if (role === 'worker' && message.type === 'relay-cutover-resumed' && cutover === 'worker-resuming') {
      cutover = 'running'; console.log('Worker claims resumed');
    } else if (role === 'worker' && ['relay-cutover-drain-failed','relay-cutover-resume-failed'].includes(message.type)) stop(1);
    else if (role === 'gateway' && message.type === 'relay-cutover-gateway-ready') {
      gatewayReady = true;
      if (cutover === 'gateway-starting') { cutover = 'gateway-ready'; console.log('Gateway ready; Worker claims remain paused'); }
      else if (cutover === 'running') console.log('Gateway cutover control ready');
    }
  });
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (role === 'gateway') { gateway = undefined; gatewayReady = false; }
    if (role === 'worker') worker = undefined;
    if (!stopping && role === 'gateway' && cutover === 'gateway-stopping' && code === 0 && !signal) {
      if (!worker || worker.exitCode !== null || worker.signalCode !== null) return stop(1);
      cutover = 'gateway-paused';
      console.log('Gateway paused; Worker claims drained');
    } else if (!stopping) stop(code === 0 && !signal ? 0 : 1);
    if (!children.size) clearTimeout(forced);
  });
}
for (const role of ['gateway', 'worker', ...(process.env.EIGOS_FREE_BOOKING_BROWSER_CONFIG ? ['participant-browser'] : []),...(managedCommerce?['commerce-sandbox']:[])]) start(role);
// Explicit operator opt-in. Signals are local OS process controls, not HTTP
// endpoints; a resumed process must still pass the normal health checks.
if (cutoverEnabled) {
  const sendWorker = type => {
    if (!worker?.connected) return stop(1);
    try { worker.send({type}, error => { if (error) stop(1); }); } catch { stop(1); }
  };
  process.on('SIGUSR1', () => {
    if (stopping || cutover !== 'running' || !gatewayReady) return;
    if (!gateway || gateway.exitCode !== null || gateway.signalCode !== null) return stop(1);
    cutover = 'draining'; sendWorker('relay-cutover-drain');
  });
  process.on('SIGUSR2', () => {
    if (stopping) return;
    if (cutover === 'gateway-paused') { cutover = 'gateway-starting'; start('gateway'); }
    else if (cutover === 'gateway-ready') { cutover = 'worker-resuming'; sendWorker('relay-cutover-resume'); }
  });
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
