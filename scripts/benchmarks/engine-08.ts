// Engine Benchmark 08: the reference implementation and the query kernel on the same synthetic data.
//
// For each size N it seeds N routes, N ride requests and N/10 places with 2N links, loads the kernel, and measures:
// - reads: filters, traversals, aggregations, an ordered query and an Interface query, on both paths;
// - writes: single-edit commits and the kernel query right after each (read after write), and a bulk source import
//   with the first kernel query that folds it;
// - recovery: a full load, a checkpoint and a restart that restores it.
// Each read case runs once to warm up, then `--runs` times. The report gives p50, p95 and p99 end to end, the kernel's
// own engine time, database statements, and the kernel process's resident and peak memory. On Linux, memory comes from
// /proc, which is what the capacity guidance uses; macOS compresses memory, so its numbers read low.
//
// Usage, from the repository root with the loopback test database that `npm test` uses:
//   cargo build --release --manifest-path kernel/Cargo.toml
//   EIGOS_KERNEL_BIN=$PWD/kernel/target/release/eigos-kernel EIGOS_TEST_DATABASE_URL=postgres://postgres:synthetic-only@127.0.0.1:5432/postgres \
//     node --import tsx scripts/benchmarks/engine-08.ts --sizes=100000 --runs=7 --out=engine-08.json
// A reference run that exceeds its 10,000-object complete-evaluation limit is reported as `overLimit`, and with
// --skip-over-limit it is not attempted again at larger sizes.
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Access, businessGrants, setGrants } from '../../packages/runtime/access.js';
import { latestCommit } from '../../packages/runtime/change-feed.js';
import { aggregateWithKernel, evaluateWithKernel, KernelClient, queryWithKernel } from '../../packages/runtime/kernel/client.js';
import { ObjectSets } from '../../packages/runtime/object-sets.js';
import { Objects, querySchema } from '../../packages/runtime/objects.js';
import { fixture, principal } from '../../tests/fixture.js';
import { measureScenarioRebase } from './scenario-rebase.js';

const flag = (name: string) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.split('=')[1];
const sizes = (flag('sizes') ?? '100000').split(',').map(Number);
const runs = Number(flag('runs') ?? 7), edits = Number(flag('edits') ?? 50), only = flag('cases');
const skipOverLimit = process.argv.includes('--skip-over-limit');
const binary = process.env.EIGOS_KERNEL_BIN, database = process.env.EIGOS_TEST_DATABASE_URL;
if (!binary || !database) throw new Error('Set EIGOS_KERNEL_BIN and EIGOS_TEST_DATABASE_URL');

type Timed<T> = { ms: number; value?: T; error?: string };
async function time<T>(run: () => Promise<T>): Promise<Timed<T>> {
  const started = performance.now();
  try { const value = await run(); return { ms: performance.now() - started, value }; }
  catch (error) { return { ms: performance.now() - started, error: (error as Error).message.slice(0, 120) }; }
}
const round = (value: number) => Math.round(value * 10) / 10;
function percentiles(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => round(sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? NaN);
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), runs: sorted.length };
}
/** Resident and peak memory of a process in MB: from /proc on Linux, from ps elsewhere (peak unknown). */
async function memory(pid: number | undefined) {
  if (!pid) return {};
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    const kb = (key: string) => Number(status.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'))?.[1] ?? NaN);
    return { rssMb: Math.round(kb('VmRSS') / 1024), peakMb: Math.round(kb('VmHWM') / 1024), source: 'proc' };
  } catch {
    return { rssMb: Math.round(Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024), source: 'ps' };
  }
}

/** The fixture's Ontology with benchmark fields and an Interface over routes and places. */
function document(base: Awaited<ReturnType<typeof fixture>>['model']['document']) {
  const copy = structuredClone(base);
  const route = copy.objectTypes.find(type => type.apiName === 'Route')!;
  Object.assign(route.properties, {
    distance: { description: 'Synthetic distance', schema: { type: 'number' }, required: false },
    lanes: { description: 'Synthetic lane count', schema: { type: 'integer' }, required: false },
    open: { description: 'Synthetic open flag', schema: { type: 'boolean' }, required: false },
  });
  const property = (description: string, type: string, required = false) => ({ description, schema: { type }, required });
  const request = copy.objectTypes.find(type => type.apiName === 'RideRequest')!;
  request.properties.benchmarkIndex = property('Synthetic request sequence', 'integer');
  copy.interfaceTypes.push({
    apiName: 'Measured', description: 'Synthetic measured things',
    properties: { label: property('Label', 'string', true), size: property('Size', 'number') },
    optionalProperties: ['size'], links: {}, actions: {},
  } as never);
  route.interfaces.Measured = { properties: { label: 'name', size: 'distance' }, links: {}, actions: {} };
  copy.objectTypes.find(type => type.apiName === 'Place')!.interfaces.Measured = { properties: { label: 'city' }, links: {}, actions: {} };
  return copy;
}

/** Seeds N routes, N ride requests and N/10 places, with a RequestRoute link per request and a RouteOrigin link per route. */
async function seed(f: Awaited<ReturnType<typeof fixture>>, projection: string, n: number) {
  const s = f.db.schema, o = principal.owner, places = Math.max(1, Math.floor(n / 10));
  await f.db.transaction(async client => {
    const q = (sql: string, values: unknown[]) => f.db.query(sql, values, client);
    await q('SET LOCAL statement_timeout=0', []);
    await q(`INSERT INTO ${s}.objects(projection,owner,type,id,revision,properties) SELECT $1,$2,'Route','r'||g,1,
      jsonb_build_object('id','r'||g,'name',CASE WHEN g%200=0 THEN 'hot' ELSE 'cold' END,'distance',(g%1000)::float8/10,'lanes',g%4,'open',g%2=0)
      FROM generate_series(1,$3::int) g`, [projection, o, n]);
    await q(`INSERT INTO ${s}.objects(projection,owner,type,id,revision,properties) SELECT $1,$2,'RideRequest','q'||g,1,
      jsonb_build_object('id','q'||g,'name','q'||g,'status',CASE WHEN g%200=0 THEN 'quoted' ELSE 'requested' END,
        'requestedAt','2026-11-01T00:00:00.000Z','benchmarkIndex',g)
      FROM generate_series(1,$3::int) g`, [projection, o, n]);
    await q(`INSERT INTO ${s}.objects(projection,owner,type,id,revision,properties) SELECT $1,$2,'Place','p'||g,1,
      jsonb_build_object('id','p'||g,'name','p'||g,'city',CASE WHEN g%20=0 THEN 'Shanghai' ELSE 'City'||(g%50) END,'address','A',
        'coordinates',jsonb_build_object('lat',31,'lng',121),'coordinateSystem','GCJ02','sourceBinding','bench','observedAt','2026-11-01T00:00:00.000Z')
      FROM generate_series(1,$3::int) g`, [projection, o, places]);
    await q(`INSERT INTO ${s}.links(projection,owner,type,from_type,from_id,to_type,to_id,single_from,single_to)
      SELECT $1,$2,'RequestRoute','RideRequest','q'||g,'Route','r'||(1+(g::bigint*7919)%$3::int),true,false FROM generate_series(1,$3::int) g`, [projection, o, n]);
    await q(`INSERT INTO ${s}.links(projection,owner,type,from_type,from_id,to_type,to_id,single_from,single_to)
      SELECT $1,$2,'RouteOrigin','Route','r'||g,'Place','p'||(1+g%$3::int),true,false FROM generate_series(1,$4::int) g`, [projection, o, places, n]);
  });
  await f.db.query(`ANALYZE ${s}.objects`);
  await f.db.query(`ANALYZE ${s}.links`);
}

type Case = { name: string; kind: 'evaluate' | 'aggregate' | 'query'; input: Record<string, unknown> };
const hot = { op: 'query', query: { type: 'Route', where: { name: 'hot' } } };
const quoted = { op: 'query', query: { type: 'RideRequest', where: { status: 'quoted' } } };
const byLanes = { groupBy: ['lanes'], metrics: { total: { op: 'count' }, mean: { op: 'avg', property: 'distance' } } };
const oneHop = [{ link: 'route' }];
const threeHops = [...oneHop, { link: 'origin' }, { link: 'departingRoutes' }];
/** Measure fixed root counts independently of the seeded population's quoted percentage. */
function traversalCases(n: number): Case[] {
  return [1, 100, 10_000].filter(count => count <= n).flatMap(count => {
    const set = { op: 'query', query: { type: 'RideRequest', filter: { op: 'lte', property: 'benchmarkIndex', value: count } } };
    return [oneHop, threeHops].map(path => ({ name: `${path.length} hop traversal from ${count} root objects`, kind: 'evaluate',
      input: { set: { op: 'traverse', set, path }, limit: 100 } }));
  });
}
function plannerCases(): Case[] {
  const narrow = { op:'refs',objects:[{type:'Route',id:'r1'}] };
  const broad = { op:'query',query:{type:'Route'} };
  const starts = { op:'refs',objects:[{type:'Place',id:'p1'}] };
  const walk = { op:'traverse',set:starts,path:[{link:'departingRoutes'},{link:'origin'}] };
  const variants: [string, unknown][] = [
    ['intersection broad first',{op:'intersection',sets:[broad,narrow]}],
    ['intersection narrow first',{op:'intersection',sets:[narrow,broad]}],
    ['difference broad minus narrow',{op:'difference',left:broad,right:narrow}],
    ['difference narrow minus broad',{op:'difference',left:narrow,right:broad}],
    ['wide first step complete',{...walk,set:{op:'query',query:{type:'Place'}}}],
    ['wide first step limit 100',{...walk,set:{op:'query',query:{type:'Place'}},frontierLimit:100}],
    ['contracting frontier complete',walk],
    ['contracting frontier limit 5',{...walk,frontierLimit:5}],
  ];
  return variants.map(([name,set])=>({ name:'C5b planner '+name,kind:'evaluate',input:{set,limit:100} }));
}
const cases: Case[] = [
  { name: 'filter 0.5%, first page', kind: 'evaluate', input: { set: hot, limit: 100 } },
  { name: '1 hop from 0.5%', kind: 'evaluate', input: { set: { op: 'traverse', set: quoted, path: oneHop }, limit: 100 } },
  { name: '3 hops from 0.5%', kind: 'evaluate', input: { set: { op: 'traverse', set: quoted, path: threeHops }, limit: 100 } },
  { name: 'aggregate 0.5% by lanes', kind: 'aggregate', input: { set: hot, ...byLanes } },
  { name: 'aggregate all routes by lanes', kind: 'aggregate', input: { set: { op: 'query', query: { type: 'Route' } }, ...byLanes } },
  { name: 'all routes, first page', kind: 'evaluate', input: { set: { op: 'query', query: { type: 'Route' } }, limit: 100 } },
  { name: 'ordered query over 10%, first page', kind: 'query', input: { type: 'Route', filter: { op: 'gte', property: 'distance', value: 90 },
    orderBy: [{ property: 'distance', direction: 'desc' }, { property: 'name' }], limit: 100 } },
  { name: 'Interface query, first page', kind: 'evaluate', input: { set: { op: 'query', query: { type: 'Measured', filter: { op: 'gte', property: 'size', value: 99.5 } } }, limit: 100 } },
];

const overLimit = new Set<string>();
const report: Record<string, unknown>[] = [];
for (const n of sizes) {
  const f = await fixture();
  const data = await mkdtemp(join(tmpdir(), 'eigos-engine-08-'));
  try {
    const model = await f.metadata.publish(document(f.model.document), f.capabilities, f.publisher);
    await setGrants(f.db, principal.owner, businessGrants(model));
    const seeded = await time(() => seed(f, model.projection, n));
    if (seeded.error) throw new Error(seeded.error);
    const access = await Access.load(f.db, principal), graph = new Objects(f.db, model, access);
    const reference = new ObjectSets(f.db, 10000, { mode: 'off', registry: { kernelFor: async () => undefined } });
    const previous = Objects.kernels;
    Objects.kernels = () => ({ mode: 'off', registry: { kernelFor: async () => undefined } });
    const kernel = await KernelClient.start(binary, { EIGOS_KERNEL_DATA: data, EIGOS_KERNEL_CHECKPOINT_S: '0' });
    try {
      const loaded = await time(() => kernel.load(f.db, model, database));
      const size: Record<string, unknown> = { n, seedMs: round(seeded.ms), load: { ms: round(loaded.ms), objects: loaded.value?.objects, edges: loaded.value?.edges,
        ...await memory(kernel.pid) } };
      console.log(JSON.stringify(size));
      const reads: Record<string, unknown>[] = [];
      for (const item of [...cases, ...traversalCases(n), ...plannerCases()].filter(item => !only || item.name.includes(only))) {
        const viaReference = async (): Promise<unknown> => item.kind === 'evaluate' ? reference.evaluate(access, model, item.input)
          : item.kind === 'aggregate' ? reference.aggregate(access, model, item.input) : graph.query(item.input as never);
        const viaKernel = async (): Promise<unknown> => {
          const value = item.kind === 'evaluate' ? await evaluateWithKernel(kernel, model, access, graph, item.input as never)
            : item.kind === 'aggregate' ? await aggregateWithKernel(kernel, model, access, graph, item.input as never)
            : await queryWithKernel(kernel, model, access, graph, { query: querySchema.parse(item.input), offset: 0 });
          if (!value) throw new Error('declined');
          return value;
        };
        const measure = async (path: 'reference' | 'kernel') => {
          if (path === 'reference' && skipOverLimit && overLimit.has(item.name)) return { skipped: 'over the limit at a smaller size' };
          const run: () => Promise<unknown> = path === 'reference' ? viaReference : viaKernel;
          const warm = await time(run);
          if (warm.error) {
            if (path === 'reference' && /exceeds|limit/i.test(warm.error)) overLimit.add(item.name);
            return { error: warm.error, ms: round(warm.ms), ...(overLimit.has(item.name) && path === 'reference' ? { overLimit: true } : {}) };
          }
          const times: number[] = [], engine: number[] = [];
          let statements = 0;
          for (let i = 0; i < runs; i++) {
            const before = f.db.queries;
            const result = await time(run);
            statements = f.db.queries - before;
            if (result.error) return { error: result.error };
            times.push(result.ms);
            const elapsed = (result.value as { elapsedMs?: number } | undefined)?.elapsedMs;
            if (elapsed !== undefined) engine.push(elapsed);
          }
          return { ...percentiles(times), statements, ...(engine.length ? { engineP50: percentiles(engine).p50 } : {}) };
        };
        const row = { case: item.name, reference: await measure('reference'), kernel: await measure('kernel') };
        console.log(JSON.stringify({ n, ...row }));
        reads.push(row);
      }
      size.reads = reads;
      size.afterReads = await memory(kernel.pid);

      // Writes: each edit commits, and the next kernel query applies it before answering.
      const editMs: number[] = [], readAfterWriteMs: number[] = [];
      for (let i = 1; i <= edits; i++) {
        const ref = { type: 'Route', id: 'r' + i * 7 };
        const current = await graph.read(ref);
        editMs.push((await time(() => graph.edit(ref, current.revision, { name: 'hot' }))).ms);
        const seen = await time(() => evaluateWithKernel(kernel, model, access, graph, { set: hot, limit: 1 } as never));
        if (seen.error || !seen.value) throw new Error('Kernel read after write failed: ' + (seen.error ?? 'declined'));
        readAfterWriteMs.push(seen.ms);
      }
      const bulk = Math.max(1, Math.floor(n / 100));
      const items = Array.from({ length: bulk }, (_, i) => ({ ref: { type: 'Route', id: 'bulk' + i },
        properties: { id: 'bulk' + i, name: 'cold', distance: 1, lanes: 3, open: true } }));
      const imported = await time(() => graph.ingestBatch(items, 'bench'));
      const folded = await time(() => evaluateWithKernel(kernel, model, access, graph, { set: hot, limit: 1 } as never));
      size.writes = { edit: percentiles(editMs), readAfterWrite: percentiles(readAfterWriteMs),
        bulkImport: { objects: bulk, ms: round(imported.ms), error: imported.error, firstQueryMs: round(folded.ms) },
        commit: Number(await latestCommit(f.db, principal.owner, f.db.pool)) };
      console.log(JSON.stringify({ n, writes: size.writes }));

      // Recovery: a checkpoint of the current version, then a restart that restores it.
      const written = await time(() => kernel.checkpoint());
      const checkpointMb = Math.round(Number(execFileSync('du', ['-sk', data], { encoding: 'utf8' }).split('\t')[0]) / 1024);
      await kernel.stop();
      const restarted = await KernelClient.start(binary, { EIGOS_KERNEL_DATA: data, EIGOS_KERNEL_CHECKPOINT_S: '0' });
      try {
        const restored = await time(() => restarted.load(f.db, model, database));
        size.recovery = { fullLoadMs: round(loaded.ms), checkpointMs: round(written.ms), checkpointMb, restoreMs: round(restored.ms),
          restored: restored.value?.restored, afterRestore: await memory(restarted.pid) };
      } finally { await restarted.stop(); }
      console.log(JSON.stringify({ n, recovery: size.recovery }));
      report.push(size);
    } finally { Objects.kernels = previous; await kernel.stop(); }
  } finally { await f.close(); await rm(data, { recursive: true, force: true }); }
}
const out = flag('out');
const scenarioRebase = await measureScenarioRebase();
const summary = { scenarioRebase, benchmark: 'engine-08', at: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, node: process.version, runs, sizes: report };
if (out) await writeFile(out, JSON.stringify(summary, null, 1) + '\n');
console.log(JSON.stringify({ done: true, out }));
