import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FunctionHostClient, FunctionHostError, type FunctionLimits } from '../packages/runtime/function-host.js';

// The workflow step of this suite builds both. Locally:
//   cargo build --release --manifest-path function-host/Cargo.toml   → EIGOS_FUNCTION_HOST_BIN
//   function-host/fixtures/build.sh <directory>                       → EIGOS_FUNCTION_HOST_FIXTURES
const binary = process.env.EIGOS_FUNCTION_HOST_BIN;
const fixtures = process.env.EIGOS_FUNCTION_HOST_FIXTURES;
const skip = !binary || !fixtures;
const component = (name: 'echo_rust' | 'net_rust' | 'wrong_rust') => readFile(join(fixtures!, `${name}.wasm`));
/** The same component with a different SHA-256: a trailing custom section named `variant`. */
const variant = (bytes: Uint8Array) => Buffer.concat([bytes, Buffer.from([0x00, 0x08, 0x07, ...Buffer.from('variant')])]);
const limits: FunctionLimits = { fuel: 100_000_000, memoryMb: 64, deadlineMs: 2000 };
const refused = (status: number, message: RegExp) => (error: unknown) =>
  error instanceof FunctionHostError && error.status === status && message.test(error.message);

async function withHost<T>(env: Record<string, string>, run: (host: FunctionHostClient) => Promise<T>) {
  const host = await FunctionHostClient.start(binary!, env);
  try { return await run(host); } finally { await host.stop(); }
}

test('the function host keeps only components that import allowed interfaces and export the EIGOS world', { skip }, () => withHost({}, async host => {
  const echo = await component('echo_rust');
  const mismatch = await fetch(host.url + '/components', { method: 'POST', headers: { 'x-eigos-sha256': '0'.repeat(64) }, body: echo });
  assert.equal(mismatch.status, 400);
  assert.match(await mismatch.text(), /does not match its SHA-256/);
  await assert.rejects(host.upload(Buffer.from('not a component')), refused(400, /Not a WebAssembly component/));
  await assert.rejects(host.upload(await component('net_rust')), refused(422, /imports wasi:sockets\/.+, which Functions may not use/));
  await assert.rejects(host.upload(await component('wrong_rust')), refused(422, /does not export invoke: func\(input: string\) -> result<string, failure>/));
  assert.equal((await host.health()).components, 0);

  const uploaded = await host.upload(echo);
  assert.equal(uploaded.cached, false);
  assert.ok(uploaded.imports!.every(name => /^wasi:(cli|clocks|random|io|filesystem)\//.test(name)), uploaded.imports!.join());
  assert.deepEqual(await host.upload(echo), { sha256: uploaded.sha256, cached: true });
  const health = await host.health();
  assert.equal(health.world, 'eigos:function/handler@0.1.0');
  assert.equal(health.components, 1);
}));

test('the function host runs each call within the limits it gives', { skip }, () => withHost({}, async host => {
  const { sha256 } = await host.upload(await component('echo_rust'));
  const call = (input: object | string, overrides: Partial<FunctionLimits> = {}) =>
    host.invoke(sha256, typeof input === 'string' ? input : JSON.stringify(input), { ...limits, ...overrides });

  const echoed = await call({ values: [1, 2] });
  assert.deepEqual(JSON.parse(echoed.output!), { echo: { values: [1, 2] } });
  assert.ok(echoed.fuelUsed > 0 && echoed.fuelUsed < limits.fuel);
  // Fuel counts instructions, so the same call uses the same fuel.
  assert.equal((await call({ values: [1, 2] })).fuelUsed, echoed.fuelUsed);

  assert.deepEqual((await call({ fail: true })).error, { kind: 'failure', code: 'asked', message: 'asked to fail' });
  const panicked = await call({ panic: true });
  assert.equal(panicked.error?.kind, 'trap');
  assert.match(panicked.stderr!, /asked to panic/);
  const logged = await call({ log: true });
  assert.ok(logged.output);
  assert.equal(logged.stderr, 'diagnostic line\n');

  const spun = await call({ spin: 1_000_000_000 });
  assert.equal(spun.error?.kind, 'fuel');
  assert.equal(spun.fuelUsed, limits.fuel);
  // Fuel enough for minutes, so the deadline stops it.
  const late = await call({ spin: 10_000_000_000_000 }, { fuel: 200_000_000_000, deadlineMs: 100 });
  assert.equal(late.error?.kind, 'deadline');
  assert.ok(late.ms >= 90 && late.ms < 2000, String(late.ms));

  assert.deepEqual(JSON.parse((await call({ allocate: 4 }, { memoryMb: 16 })).output!), { chunks: 4 });
  assert.equal((await call({ allocate: 64 }, { memoryMb: 16 })).error?.kind, 'memory');
  assert.equal((await call({ repeat: 500 }, { outputBytes: 1000 })).output!.length, 502);
  assert.deepEqual((await call({ repeat: 2000 }, { outputBytes: 1000 })).error, { kind: 'output', message: 'The output exceeds 1000 bytes' });

  await assert.rejects(call('x'.repeat(2000), { inputBytes: 1000 }), refused(413, /The input exceeds 1000 bytes/));
  await assert.rejects(call({}, { memoryMb: 1024 }), refused(400, /at most fuel .+ memoryMb 512/));
  await assert.rejects(call({}, { fuel: 0 }), refused(400, /Limits are positive/));
  await assert.rejects(host.invoke('f'.repeat(64), '{}', limits), refused(404, /Unknown component/));
  await assert.rejects(host.invoke('../escape', '{}', limits), refused(400, /64 lowercase hexadecimal/));
  const unknown = await fetch(host.url + '/invoke', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sha256, input: '{}', limits: { ...limits, cpus: 8 } }),
  });
  assert.equal(unknown.status, 422);
}));

test('the function host keeps precompiled components across restarts and reloads evicted ones', { skip }, async () => {
  const data = await mkdtemp(join(tmpdir(), 'eigos-function-host-'));
  try {
    const echo = await component('echo_rust');
    const { sha256 } = await withHost({ EIGOS_FUNCTION_HOST_DATA: data }, host => host.upload(echo));
    assert.deepEqual(await readdir(data), [`${sha256}.cwasm`]);
    const corrupt = 'e'.repeat(64);
    await writeFile(join(data, `${corrupt}.cwasm`), 'not a precompiled component');
    await writeFile(join(data, `${corrupt}.1.0.partial`), 'an unfinished write');

    await withHost({ EIGOS_FUNCTION_HOST_DATA: data, EIGOS_FUNCTION_HOST_COMPONENTS: '1' }, async host => {
      // A restarted host removes unfinished writes, and loads a component from disk on its first call, without an upload.
      assert.deepEqual((await readdir(data)).sort(), [`${corrupt}.cwasm`, `${sha256}.cwasm`].sort());
      assert.equal((await host.health()).components, 0);
      assert.ok((await host.invoke(sha256, '{"restart":1}', limits)).output);
      await assert.rejects(host.invoke(corrupt, '{}', limits), refused(404, /Unknown component/));
      assert.deepEqual((await readdir(data)).sort(), [`${sha256}.cwasm`]);

      // Holding one component at a time, the host evicts the first and loads it from disk again.
      const second = await host.upload(variant(echo));
      assert.equal(second.cached, false);
      assert.equal((await host.health()).components, 1);
      assert.ok((await host.invoke(sha256, '{}', limits)).output);
      assert.ok((await host.invoke(second.sha256, '{}', limits)).output);
      assert.equal((await host.health()).components, 1);
    });

    // Without a data directory an evicted component is gone until it is uploaded again.
    await withHost({ EIGOS_FUNCTION_HOST_COMPONENTS: '1' }, async host => {
      await host.upload(echo);
      await host.upload(variant(echo));
      await assert.rejects(host.invoke(sha256, '{}', limits), refused(404, /Unknown component/));
      assert.equal((await host.upload(echo)).cached, false);
      assert.ok((await host.invoke(sha256, '{}', limits)).output);
    });
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test('the function templates carry the world of the function host', async () => {
  const world = await readFile('function-host/wit/handler.wit', 'utf8');
  for (const template of ['function-rust', 'function-ts'])
    assert.equal(await readFile(`templates/${template}/wit/handler.wit`, 'utf8'), world, template);
});

// The workflow step builds both templates into EIGOS_FUNCTION_TEMPLATES as rust.wasm and ts.wasm.
const templates = process.env.EIGOS_FUNCTION_TEMPLATES;
test('components built from the templates run in the function host', { skip: skip || !templates }, () => withHost({}, async host => {
  for (const [template, memoryMb] of [['rust', 32], ['ts', 64]] as const) {
    const { sha256 } = await host.upload(await readFile(join(templates!, `${template}.wasm`)));
    const call = (input: string) => host.invoke(sha256, input, { fuel: 1_000_000_000, memoryMb, deadlineMs: 10_000 });
    assert.deepEqual(JSON.parse((await call('{"values":[1,2,3.5]}')).output!), { sum: 6.5, count: 3 }, template);
    assert.deepEqual((await call('{"values":[]}')).error, { kind: 'failure', code: 'empty', message: 'Give at least one value' }, template);
    const invalid = (await call('not JSON')).error;
    assert.ok(invalid?.kind === 'failure' && invalid.code === 'invalid-input', `${template}: ${JSON.stringify(invalid)}`);
  }
}));
