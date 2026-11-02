// Local synthetic SQLite benchmark. No model, provider, credential or live task.
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { cpus, platform, release, arch } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DomainError } from '../packages/core/domain.js';
import { currentKernelImplementation } from '../packages/ontology/definition-store.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import { requestedFactsSchema, readRequestedFacts } from '../packages/coordinator/requested-facts.js';
import { registrationHistory } from '../tests/fixtures/registration-history.js';
import { readDependencyFixture } from '../tests/fixtures/read-dependencies.js';

interface Counters { sqlExecutions: number; sqlRows: number; sqlMs: number; graphQueries: number; graphReads: number; relationships: number; evaluations: number }
const counters = (): Counters => ({ sqlExecutions: 0, sqlRows: 0, sqlMs: 0, graphQueries: 0, graphReads: 0, relationships: 0, evaluations: 0 });
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)]!;

/** Count statement executions (including repeats), not just prepare() calls.
 * Instrumentation and serialization are included in local elapsed time. */
export function measureQuery(db: DatabaseSync, graph: OntologyObjectStore, action: () => unknown, samples = 25, warmups = 3) {
  if (!Number.isInteger(samples) || samples < 1 || samples > 1000 || !Number.isInteger(warmups) || warmups < 0 || warmups > 100) throw new Error('Invalid benchmark sample bounds');
  let counts = counters();
  const prepare = db.prepare;
  db.prepare = function(sql) {
    const statement = prepare.call(this, sql);
    for (const method of ['get', 'all', 'run'] as const) {
      const execute = statement[method];
      Object.defineProperty(statement, method, { configurable: true, value: function(...args: unknown[]) {
        counts.sqlExecutions++;
        const start = performance.now();
        try {
          const result = Reflect.apply(execute, this, args);
          counts.sqlRows += method === 'all' ? result.length : method === 'get' && result !== undefined ? 1 : 0;
          return result;
        } finally { counts.sqlMs += performance.now() - start; }
      } });
    }
    return statement;
  };
  const query = graph.query, read = graph.read, related = graph.related, evaluate = graph.evaluate;
  graph.query = function(...args) { counts.graphQueries++; return query.apply(this, args); };
  graph.read = function(...args) { counts.graphReads++; return read.apply(this, args); };
  graph.related = function(...args) { counts.relationships++; return related.apply(this, args); };
  graph.evaluate = function(...args) { counts.evaluations++; return evaluate.apply(this, args); };
  const once = () => {
    counts = counters(); const start = performance.now();
    let result: unknown;
    try { result = action(); }
    catch (error) { if (!(error instanceof DomainError)) throw error; result = { status: 'blocked', reason: error.message }; }
    const responseBytes = Buffer.byteLength(JSON.stringify(result));
    const status = result && typeof result === 'object' && 'status' in result ? String(result.status) : 'returned';
    return { elapsedMs: performance.now() - start, ...counts, responseBytes, status };
  };
  try {
    const first = once();
    for (let n = 0; n < warmups; n++) once();
    const runs = Array.from({ length: samples }, once);
    return { first, warm: { samples, warmups, p50Ms: percentile(runs.map(run => run.elapsedMs), .5), p95Ms: percentile(runs.map(run => run.elapsedMs), .95),
      statuses: [...new Set(runs.map(run => run.status))],
      perCall: Object.fromEntries(Object.keys(first).filter(key => !['elapsedMs', 'status'].includes(key)).map(key => {
        const values = runs.map(run => Number(run[key as keyof typeof run]));
        return [key, { min: Math.min(...values), median: percentile(values, .5), max: Math.max(...values) }];
      })) } };
  } finally { db.prepare = prepare; graph.query = query; graph.read = read; graph.related = related; graph.evaluate = evaluate; }
}

export function benchmarkHistory(sizes = [1, 5, 10, 25, 50, 51, 100, 500], samples = 25) {
  if (!sizes.length || sizes.length > 20 || sizes.some(size => !Number.isInteger(size) || size < 1 || size > 1000)) throw new Error('History sizes must be integers from 1 to 1000');
  const model = currentKernelImplementation(), now = Date.now();
  return sizes.map(historySize => {
    const db = new DatabaseSync(':memory:'), graph = new OntologyObjectStore(db, model, () => now);
    try {
      const f = registrationHistory(graph, historySize), latest = f.refs.at(-1)!;
      const facts = requestedFactsSchema.parse([
        { key: 'identity', query: { object: latest, select: ['id'] } },
        { key: 'label', query: { object: latest, select: ['displayTitle'] } },
        { key: 'request', query: { from: f.scope, link: 'request', select: ['originalGoal'] } },
        { key: 'receipt', query: { from: latest, link: 'sourceReceipts', select: ['safeSummary'] } },
      ]);
      const readFacts = (batch: typeof facts) => readRequestedFacts(batch, query => graph.query(f.owner, query), () => { throw new Error('This workload does not request evaluation'); });
      const workloads = {
        knownReference: () => graph.query(f.owner, { object: latest, select: ['id', 'displayTitle'] }),
        historyPage: () => graph.query(f.owner, { from: f.scope, link: 'RegistrationOfferObservations', select: ['id'], limit: 50 }),
        currentTerms: () => graph.evaluate(f.owner, { function: 'registrationStatus', object: latest }, { remaining: 5000 }),
        separateFacts: () => facts.map(fact => readFacts([fact])),
        batchedFacts: () => readFacts(facts),
      };
      return { historySize, workloads: Object.fromEntries(Object.entries(workloads).map(([name, action]) => [name, measureQuery(db, graph, action, samples)])) };
    } finally { db.close(); }
  });
}

/** Same cumulative-evidence fixture as the authorization regressions. The
 * prototype counter covers both the task store and membership connections. */
export function benchmarkAuthorizedReads(sizes = [1, 8, 32, 64], samples = 25) {
  if (!sizes.length || sizes.length > 10 || sizes.some(size => !Number.isInteger(size) || size < 1 || size > 64)) throw new Error('Dependency sizes must be integers from 1 to 64');
  return sizes.map(dependencies => {
    const f = readDependencyFixture(dependencies);
    try { return { dependencies, measurement: measureQuery(DatabaseSync.prototype, f.jobs.ontology, f.read, samples) }; }
    finally { f.close(); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const samples = Number(process.argv.find(arg => arg.startsWith('--samples='))?.split('=')[1] ?? 25);
  const sizes = process.argv.find(arg => arg.startsWith('--sizes='))?.slice('--sizes='.length).split(',').map(Number);
  const results = benchmarkHistory(sizes, samples);
  const authorizedReads = benchmarkAuthorizedReads(undefined, samples);
  console.log(JSON.stringify({ version: 1, commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), at: new Date().toISOString(),
    environment: { node: process.version, platform: platform(), os: release(), arch: arch(), cpu: cpus()[0]?.model, cores: cpus().length },
    scope: { database: 'isolated in-memory SQLite', authority: 'trusted internal reader; no Foundation permission overhead', clock: 'fixed throughout each run', modelCalls: 0, providerCalls: 0,
      excludes: ['startup', 'model compilation', 'fixture ingestion', 'Foundation authorization', 'model reasoning', 'network latency', 'production load'],
      timing: 'first workload sample plus warm instrumented calls; local p95 is not a production SLA' },
    authorizedScope: { database: 'isolated on-disk SQLite task and membership stores', authority: 'Foundation task grant, fields and cumulative evidence; new authorization scope on every call', modelCalls: 0, providerCalls: 0 },
    results, authorizedReads }, null, 2));
}
