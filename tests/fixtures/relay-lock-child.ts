import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';

const [credentialPath, baseUrl, gate, implementation] = process.argv.slice(2);
const unlink = fs.unlinkSync, lockPath = credentialPath + '.lock';
let recovered = false;
// Hold a stale-marker remover until the parent has observed both contenders.
// The old PID-only algorithm lets both enter; the OS lock permits only one.
fs.unlinkSync = path => {
  if (String(path) === lockPath && !recovered) {
    recovered = true; process.send?.({ state: 'recovering' });
    const deadline = Date.now() + 10000, sleeping = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(gate!)) {
      if (Date.now() >= deadline) throw new Error('Stale-lock test barrier expired');
      Atomics.wait(sleeping, 0, 0, 5);
    }
  }
  unlink(path);
};
syncBuiltinESMExports();
let client: import('../../packages/agent-transport/client.js').RelayClient | undefined;
try {
  const { RelayClient } = await import(implementation || '../../packages/agent-transport/client.js');
  client = await RelayClient.open({ credentialPath, baseUrl, displayName: 'Lock contender' });
  process.send?.({ state: 'opened' }); await once(process, 'message');
} catch { process.send?.({ state: 'rejected' }); }
finally { try { client?.close(); } catch { /* The losing legacy implementation can remove another owner's marker. */ } process.disconnect?.(); }
