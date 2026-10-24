import { spawn } from 'node:child_process';

// Gateway and Worker share DATABASE_PATH; an optional browser bridge owns only
// its separate source queue and reads the original task database for authority.
const built = process.argv.includes('--built');
const children = new Set();
let stopping = false;
let forced;
function stop(code = 0) {
  if (stopping) return;
  stopping = true; process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
  forced = setTimeout(() => { for (const child of children) child.kill('SIGKILL'); }, 10000);
  forced.unref();
}
for (const role of ['gateway', 'worker', ...(process.env.EIGOS_FREE_BOOKING_BROWSER_CONFIG ? ['participant-browser'] : [])]) {
  const args = built ? [`dist/apps/${role}/main.js`] : ['--import', 'tsx', `apps/${role}/main.ts`];
  const child = spawn(process.execPath, args, { stdio: 'inherit', env: process.env });
  children.add(child);
  child.on('error', () => stop(1));
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (!stopping) stop(code === 0 && !signal ? 0 : 1);
    if (!children.size) clearTimeout(forced);
  });
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
