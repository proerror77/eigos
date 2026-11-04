import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fixtureRead, fixtureAuthority } from '../fixtures/taobao-pa-rehearsal.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const exec = promisify(execFile);
test('Separate PA process exposes preparation tools with private authentication and no payment tool', { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pa-mcp-')), tokenFile = join(directory, 'token'), token = randomBytes(32).toString('hex');
  writeFileSync(tokenFile, token, { mode: 0o600 });
  const child = spawn(process.execPath, ['dist/apps/pa-payments/main.js', '--token-file', tokenFile], { stdio: ['ignore', 'pipe', 'pipe'], env: {} });
  const exited = once(child, 'exit'), lines = createInterface({ input: child.stdout });
  const client = new Client({ name: 'pa-process-test', version: '1' });
  let timer: NodeJS.Timeout | undefined;
  try {
    const [line] = await Promise.race([once(lines, 'line'), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('PA service did not become ready')), 15_000);
    })]);
    clearTimeout(timer);
    const ready = JSON.parse(line);
    assert.equal(new URL(ready.url).hostname, '127.0.0.1'); assert.equal(ready.realPaymentsAllowed, false);
    assert.equal((await fetch(ready.url, { method: 'POST' })).status, 401);
    await client.connect(new StreamableHTTPClientTransport(new URL(ready.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const tools = await client.listTools(); assert.equal(tools.tools.length, 3);
    assert(tools.tools.every(tool => tool.annotations?.readOnlyHint === true));
    const escalation = await client.callTool({ name: 'prepare_taobao_shopping', arguments: {
      catalogRead: fixtureRead(), authority: { ...fixtureAuthority(), allowRealOrders: true },
    } });
    assert.equal(escalation.isError, true);
  } finally {
    clearTimeout(timer); await client.close(); lines.close();
    if (child.exitCode === null) child.kill('SIGTERM');
    const kill = setTimeout(() => child.kill('SIGKILL'), 3000);
    await exited; clearTimeout(kill); rmSync(directory, { recursive: true, force: true });
  }
});
test('Built PA connector rehearses the EIGOS Taobao catalog and independent synthetic order/payment readbacks', { timeout: 120_000 }, async () => {
  const { stdout } = await exec(process.execPath, ['dist/examples/verify-pa-taobao-rehearsal.js'], { timeout: 110_000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH } });
  const result = JSON.parse(stdout.trim());
  assert.equal(result.paMcpVerified, true); assert.equal(result.catalogReadThroughEigos, true);
  assert.equal(result.simulatedSubmissions, 1); assert.equal(result.noDuplicateDispatch, true);
  assert.equal(result.simulationState, 'confirmed'); assert.equal(result.officialPaymentVerified, false);
  assert.equal(result.liveTaobaoCheckoutVerified, false); assert.equal(result.realOrdersCreated, 0); assert.equal(result.realPaymentsSubmitted, 0);
});
test('PA CLI accepts only private preparation inputs and rejects payment/unknown commands', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pa-no-spend-')), input = join(directory, 'input.json'), script = resolve('dist/examples/pa-alipay-agent-pay.js');
  try {
    writeFileSync(input, JSON.stringify({ catalogRead: fixtureRead(), authority: fixtureAuthority() }), { mode: 0o600 });
    const { stdout } = await exec(process.execPath, [script, 'prepare', '--input', input]);
    assert.equal(JSON.parse(stdout).status, 'awaiting_order_material');
    for (const command of ['submit-payment', 'create-order', 'prepare --execute']) {
      await assert.rejects(exec(process.execPath, [script, ...command.split(' '), '--input', input]), /No real order or payment was submitted/);
    }
    writeFileSync(input, JSON.stringify({ catalogRead: fixtureRead(), authority: { ...fixtureAuthority(), allowRealPayments: true } }));
    await assert.rejects(exec(process.execPath, [script, 'prepare', '--input', input]));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
