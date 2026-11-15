import { randomUUID } from 'node:crypto';
import { loadOperatorCredential } from './ontology-operator-credential.mjs';

async function main() {
  const receivedAt = new Date().toISOString(), start = performance.now();
  const [command, target, extra] = process.argv.slice(2);
  if (!target || !['submit', 'read', 'confirm'].includes(command)) {
    throw new Error('Usage: ontology-worker-client.mjs submit MESSAGE [REQUEST_ID] | read TASK_ID | confirm TASK_ID PLACES_JSON');
  }
  const { base, token } = await loadOperatorCredential();
  const authMs = Math.round(performance.now() - start);
  const requestId = command === 'submit' ? extra ?? randomUUID() : undefined;
  const path = command === 'submit' ? '/tasks'
    : '/tasks/' + encodeURIComponent(target) + (command === 'confirm' ? '/places' : '');
  const body = command === 'submit' ? { requestId, message: target }
    : command === 'confirm' ? JSON.parse(extra) : undefined;
  const response = await fetch(new URL(path, base), {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`EIGOS task request failed (HTTP ${response.status})`);
  const task = await response.json();
  console.log(JSON.stringify({ receivedAt, returnedAt: new Date().toISOString(),
    authMs, elapsedMs: Math.round(performance.now() - start), requestId, task }));
}

main().catch(error => {
  const message = error instanceof Error ? error.message : '';
  console.error(/^(Usage:|The operator |OAuth |Unexpected operator|EIGOS task request)/.test(message)
    ? message : 'EIGOS worker request failed. Check the authorized operator profile and network.');
  process.exitCode = 1;
});
