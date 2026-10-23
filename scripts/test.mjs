import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';

// Keep one test entry point; CI partitions files with Node's built-in sharding.
const files = readdirSync('tests').filter(name => name.endsWith('.test.ts')).sort().map(name => `tests/${name}`);
const child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=2', ...process.argv.slice(2), ...files], { stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('close', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
