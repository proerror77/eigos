import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { test } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { readPrimaryHealth, waitForPrimaryHealth } from '../packages/deployment/primary.js';

const expected = { authorityId: 'primary', releaseDigest: 'current' };

async function withServer(handler: http.RequestListener, run: (port: number) => Promise<void>): Promise<void> {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run((server.address() as { port: number }).port); }
  finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test('primary readiness accepts a healthy response delayed beyond the old two-second limit', async () => {
  await withServer(async (_request, response) => {
    await pause(2200);
    response.end(JSON.stringify({ status: 'ok', ...expected }));
  }, async port => {
    assert.equal((await waitForPrimaryHealth(port, 'primary.example', expected)).releaseDigest, 'current');
  });
});

test('primary readiness retries temporary failure and stale identities with the registered Host', async () => {
  const hosts: (string | undefined)[] = [];
  const responses = [
    { code: 503, body: { status: 'unavailable' } },
    { code: 200, body: { status: 'ok', ...expected, authorityId: 'other' } },
    { code: 200, body: { status: 'ok', ...expected, releaseDigest: 'old' } },
    { code: 200, body: { status: 'ok', ...expected } },
  ];
  await withServer((request, response) => {
    hosts.push(request.headers.host);
    const next = responses.shift()!;
    response.writeHead(next.code);
    response.end(JSON.stringify(next.body));
  }, async port => {
    assert.deepEqual(await waitForPrimaryHealth(port, 'primary.example', expected, { retryDelayMs: 5 }), { status: 'ok', ...expected });
    assert.deepEqual(hosts, Array(4).fill('primary.example'));
  });
});

for (const mismatch of [{ status: 'unavailable' }, { authorityId: 'other' }, { releaseDigest: 'old' }]) {
  test(`primary readiness never accepts a mismatched ${Object.keys(mismatch)[0]}`, async () => {
    await withServer((_request, response) => response.end(JSON.stringify({ status: 'ok', ...expected, ...mismatch })), async port => {
      await assert.rejects(waitForPrimaryHealth(port, 'primary.example', expected, {
        timeoutMs: 150, requestTimeoutMs: 100, retryDelayMs: 150,
      }), /Last probe: Health status, authority ID or release digest does not match/);
    });
  });
}

test('primary readiness bounds all retries by one deadline and retains the final failure', async () => {
  let attempts = 0;
  await withServer((_request, response) => {
    attempts++;
    response.writeHead(503);
    response.end('{}');
  }, async port => {
    const started = performance.now();
    await assert.rejects(waitForPrimaryHealth(port, 'primary.example', expected, {
      timeoutMs: 150, requestTimeoutMs: 100, retryDelayMs: 40,
    }), /Primary failed readiness after 150ms.*Last probe: Primary readiness is unavailable \(HTTP 503\)/);
    assert(attempts > 1);
    assert(performance.now() - started < 2000, 'Retries must not multiply the overall wait budget');
  });
});

test('primary readiness does not start another probe before its retry interval fits', async () => {
  let attempts = 0;
  await withServer((_request, response) => {
    attempts++;
    response.end(JSON.stringify({ status: 'ok', ...expected, releaseDigest: 'old' }));
  }, async port => {
    await assert.rejects(waitForPrimaryHealth(port, 'primary.example', expected, {
      timeoutMs: 150, requestTimeoutMs: 100, retryDelayMs: 200,
    }), /Last probe: Health status, authority ID or release digest does not match/);
    assert.equal(attempts, 1, 'The final wait cannot become a sub-millisecond retry');
  });
});

test('primary readiness bounds a single unresponsive request by the remaining overall budget', async () => {
  await withServer(() => {}, async port => {
    const started = performance.now();
    await assert.rejects(waitForPrimaryHealth(port, 'primary.example', expected, {
      timeoutMs: 150, requestTimeoutMs: 5000,
    }), /Last probe: Primary readiness timed out/);
    assert(performance.now() - started < 2000, 'A probe must not outlive the overall wait budget');
  });
});

test('primary health deadline also stops a response that continuously sends bytes', async () => {
  await withServer((_request, response) => {
    response.writeHead(200);
    response.write('{');
    const stream = setInterval(() => response.write(' '), 5);
    response.once('close', () => clearInterval(stream));
  }, async port => {
    await assert.rejects(readPrimaryHealth(port, 'primary.example', 100), /timed out/);
  });
});

test('primary health still rejects an oversized response', async () => {
  await withServer((_request, response) => response.end(' '.repeat(65537)), async port => {
    await assert.rejects(readPrimaryHealth(port, 'primary.example'), /exceeds its bound/);
  });
});

test('a configured Relay cannot silently disappear from an otherwise healthy deployment', async () => {
  for (const taskRelay of [undefined, {status:'unavailable'}]) {
    await withServer((_request,response)=>response.end(JSON.stringify({status:'ok',...expected,...(taskRelay?{taskRelay}:{})})), async port=>{
      await assert.rejects(waitForPrimaryHealth(port,'primary.example',{...expected,taskRelay:'connected'},{timeoutMs:150,requestTimeoutMs:100,retryDelayMs:150}),/Configured Task Relay is not connected/);
    });
  }
  await withServer((_request,response)=>response.end(JSON.stringify({status:'ok',...expected,taskRelay:{status:'connected'}})),async port=>{
    assert.equal((await waitForPrimaryHealth(port,'primary.example',{...expected,taskRelay:'connected'})).status,'ok');
  });
});
