import { spawn } from 'node:child_process';

// Convenience launcher: two separate processes on one host, sharing DATABASE_PATH.
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
for (const role of ['gateway', 'worker']) {
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
