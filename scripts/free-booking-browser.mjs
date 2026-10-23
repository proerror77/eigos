import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';

const [action, directoryArg, value, file] = process.argv.slice(2);
if (!directoryArg || !isAbsolute(directoryArg)) throw new Error('Use an absolute private session directory');
const directory = resolve(directoryArg), configPath = join(directory, 'browser.json');
const write = (path, data) => writeFileSync(path, data, { mode: 0o600, flag: 'wx' });
if (action === 'setup') {
  if (existsSync(configPath)) throw new Error('The session already exists; reuse its operation identities');
  const email = process.env.EIGOS_PARTICIPANT_EMAIL?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Set EIGOS_PARTICIPANT_EMAIL to the signed-in Luma account email');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const workerTokenFile = join(directory, 'worker-token'), operatorTokenFile = join(directory, 'operator-token');
  write(workerTokenFile, randomBytes(32).toString('hex')); write(operatorTokenFile, randomBytes(32).toString('hex'));
  const config = { bindingId: `luma-${randomBytes(6).toString('hex')}`, attendeeRef: createHash('sha256').update(email).digest('hex'), port: Number(process.env.EIGOS_PARTICIPANT_BRIDGE_PORT ?? 3443), gatewayPort: Number(process.env.EIGOS_PARTICIPANT_GATEWAY_PORT ?? 3444), databasePath: join(directory, 'browser.sqlite'), taskDatabasePath: join(directory, 'tasks.sqlite'), evidenceDirectory: join(directory, 'browser-evidence'), workerTokenFile, operatorTokenFile };
  const { JobStore } = await import('../dist/packages/core/store.js'); const store = new JobStore(config.taskDatabasePath); store.close();
  write(configPath, JSON.stringify(config, null, 2));
  const endpoint = `http://127.0.0.1:${config.port}`;
  write(join(directory, 'gateway.env'), [
    'HOST=127.0.0.1', `PORT=${config.gatewayPort}`, `PUBLIC_URL=http://127.0.0.1:${config.gatewayPort}`, `DATABASE_PATH=${config.taskDatabasePath}`,
    'EIGOS_AUTH_MODE=development', `EIGOS_DEV_TOKEN=${randomBytes(32).toString('hex')}`, 'EIGOS_EXECUTOR=disabled', 'EIGOS_TASK_MAX_MS=604800000',
    `EIGOS_FREE_BOOKING_BRIDGE_URL=${endpoint}`, `EIGOS_FREE_BOOKING_TOKEN_FILE=${workerTokenFile}`, `EIGOS_FREE_BOOKING_BINDING_ID=${config.bindingId}`, `EIGOS_FREE_BOOKING_ATTENDEE_SHA256=${config.attendeeRef}`,
  ].join('\n') + '\n');
  console.log(JSON.stringify({ session: directory, bridge: endpoint, gateway: `http://127.0.0.1:${config.gatewayPort}`, browserRequired: true, unattended: false }));
} else {
  const config = JSON.parse(readFileSync(configPath, 'utf8')), origin = `http://127.0.0.1:${config.port}`;
  if (action === 'serve') {
    const { createParticipantBrowserBridge } = await import('../dist/packages/capabilities/free-booking/browser-bridge.js');
    const bridge = await createParticipantBrowserBridge({ ...config, workerToken: readFileSync(config.workerTokenFile, 'utf8').trim(), operatorToken: readFileSync(config.operatorTokenFile, 'utf8').trim() });
    console.log(JSON.stringify({ endpoint: bridge.endpoint, browserOperatorRequired: true }));
    let stopping = false; const stop = async () => { if (!stopping) { stopping = true; await bridge.close(); } }; process.on('SIGTERM', stop); process.on('SIGINT', stop);
  } else if (['next', 'dispatch', 'resolve'].includes(action)) {
    if (action !== 'next' && !/^[a-f0-9]{64}$/.test(value ?? '')) throw new Error('Use the exact original operation key');
    const path = action === 'next' ? '/operator/next' : `/operator/${action}/${value}`;
    const response = await fetch(origin + path, { method: action === 'next' ? 'GET' : 'POST', headers: { authorization: `Bearer ${readFileSync(config.operatorTokenFile, 'utf8').trim()}`, 'content-type': 'application/json' }, ...(action === 'resolve' ? { body: readFileSync(resolve(file), 'utf8') } : {}), redirect: 'error', signal: AbortSignal.timeout(10000) });
    const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); console.log(JSON.stringify(result, null, 2));
  } else if (action === 'request') {
    // A2A submission; the same task is read through MCP by the verification client.
    const { parseEnv } = await import('node:util'); const env = parseEnv(readFileSync(join(directory, 'gateway.env'), 'utf8'));
    const payload = JSON.parse(readFileSync(resolve(value), 'utf8'));
    const request = { jsonrpc: '2.0', id: randomUUID(), method: 'SendMessage', params: { configuration: { returnImmediately: true }, message: { role: 'ROLE_USER', messageId: payload.requestId ?? randomUUID(), parts: [{ data: { service: 'eigos.delegate', ...payload } }] } } };
    const response = await fetch(`http://127.0.0.1:${config.gatewayPort}/a2a`, { method: 'POST', headers: { authorization: `Bearer ${env.EIGOS_DEV_TOKEN}`, 'content-type': 'application/json', 'A2A-Version': '1.0' }, body: JSON.stringify(request), signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`A2A request failed (${response.status})`); console.log(JSON.stringify(await response.json(), null, 2));
  } else throw new Error('Actions: setup, serve, next, dispatch, resolve, request');
}
