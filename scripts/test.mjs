import { spawn, execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

const e2e = process.argv.includes('--e2e'), suite = process.argv.find(arg => arg.startsWith('--suite='))?.split('=')[1];
const files = e2e ? ['dist/tests/e2e/gateway.test.js'] : readdirSync('tests').filter(name => /^\d\d-.+\.test\.ts$/.test(name) && (!suite || name.startsWith(suite.padStart(2, '0') + '-'))).map(name => 'tests/' + name);
if (!files.length) throw new Error('No test files selected');
let url = process.env.EIGOS_TEST_DATABASE_URL, container;
try {
  if (!url) {
    container = 'eigos-test-' + randomUUID();
    execFileSync('docker', ['run', '--detach', '--rm', '--name', container, '--publish', '127.0.0.1::5432', '--env', 'POSTGRES_PASSWORD=synthetic-only', 'postgres:17'], { stdio: 'ignore' });
    const address = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).trim();
    url = `postgres://postgres:synthetic-only@${address}/postgres`;
  }
  const endpoint = new URL(url);
  if (endpoint.hostname !== '127.0.0.1' || endpoint.password !== 'synthetic-only') throw new Error('Tests require their loopback synthetic PostgreSQL database');
  const deadline = Date.now() + 15000;
  for (;;) {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1000 });
    try { await client.connect(); await client.end(); break; }
    catch (error) { await client.end().catch(() => {}); if (Date.now() >= deadline) throw error; await delay(100); }
  }
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...(e2e ? [] : ['--import', 'tsx']), '--test', '--test-concurrency=2', ...files], { stdio: 'inherit', env: { ...process.env, EIGOS_TEST_DATABASE_URL: url } });
    child.on('error', reject); child.on('exit', code => resolve(code ?? 1));
  });
} finally { if (container) execFileSync('docker', ['stop', container], { stdio: 'ignore' }); }
