import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

async function loopbackPort() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

export async function sparedHost(binary: string, artifact: string) {
  const bytes = await readFile(artifact);
  const wasmSha256 = createHash('sha256').update(bytes).digest('hex');
  const directory = await mkdtemp(join(tmpdir(), 'eigos-spared-quote-'));
  const port = await loopbackPort(), adminPort = await loopbackPort();
  const token = randomUUID() + randomUUID();
  let child: ChildProcess | undefined;
  const stop = async () => {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, 'exit');
    child.kill('SIGTERM');
    await closed;
  };
  return {
    port, wasmSha256,
    async start() {
      const errors: Buffer[] = [];
      let spawnFailure: Error | undefined;
      child = spawn(binary, ['serve', '--listen', '127.0.0.1:' + port, '--admin-listen', '127.0.0.1:' + adminPort,
        '--data-dir', directory, '--max-request-mb', '1', '--max-app-data-mb', '1', '--access-log', 'off'], {
        env: { ...process.env, SPARED_ADMIN_TOKEN: token }, stdio: ['ignore', 'ignore', 'pipe'],
      });
      child.once('error', error => { spawnFailure = error; });
      child.stderr!.on('data', data => errors.push(data));
      for (let attempt = 0; attempt < 100 && child.exitCode === null && !spawnFailure; attempt++) {
        const response = await fetch('http://127.0.0.1:' + port + '/healthz', { signal: AbortSignal.timeout(500) }).catch(() => undefined);
        if (response?.ok) return;
        await delay(50);
      }
      throw new Error('spared startup failed: ' + Buffer.concat(errors).toString(), { cause: spawnFailure });
    },
    async deploy(name: string) {
      const manifest = Buffer.from('name = "' + name + '"\n[grants]\ndata = true\n').toString('base64');
      const response = await fetch('http://127.0.0.1:' + adminPort + '/v1/apps/' + name, {
        method: 'PUT', headers: { Authorization: 'Bearer ' + token, 'X-Spared-Manifest': manifest, 'Content-Type': 'application/wasm' },
        body: new Uint8Array(bytes), signal: AbortSignal.timeout(65000),
      });
      const result = await response.text();
      assert.equal(response.status, 200, result);
      const deployed = JSON.parse(result) as { component_sha256: string; component_reused: boolean };
      assert.equal(deployed.component_sha256, wasmSha256);
      return deployed;
    },
    async databases(names: readonly string[]) {
      return Promise.all(names.map(name => readFile(join(directory, 'apps', name, 'data', 'app.db'))));
    },
    stop,
    async close() {
      await stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
