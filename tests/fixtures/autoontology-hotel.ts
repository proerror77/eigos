// Controlled model decisions for isolated validation. The default source is synthetic.
import { setTimeout } from 'node:timers/promises';
import { stringify } from 'yaml';
import { Worker } from '../../apps/worker/worker.js';
import { createExecutionCatalog } from '../../packages/capabilities/catalog.js';
import { RollingGoProgram, type RollingGoOptions } from '../../packages/capabilities/rollinggo/program.js';
import { checkedRollingGo } from '../../packages/ontology/rollinggo.js';
import type { RollingGoSearchInput } from '../../packages/capabilities/rollinggo/connector.js';
import type { Reasoner } from '../../packages/coordinator/coordinator.js';
import { JobStore } from '../../packages/core/store.js';
import { digest } from '../../packages/core/delegation.js';
import { backend, owner, interpretation, evidence, observeTaskContext, acknowledgeReads, syntheticGoalReview } from '../backend-fixture.js';

export const hotelInput: RollingGoSearchInput = { originQuery: 'Synthetic hotel search', place: 'Synthetic city', placeType: 'city',
  checkInParam: { checkInDate: '2099-01-01', stayNights: 1, adultCount: 2 }, localeParam: { currency: 'USD', language: 'en' }, size: 3 };

export function hotelValidationFixture(options?: { source?: RollingGoOptions; input?: RollingGoSearchInput; database?: string; maxCalls?: number }) {
  const input = options?.input ?? hotelInput, store = new JobStore(options?.database ?? ':memory:');
  const configured: RollingGoOptions = options?.source ?? { keyFile: '/synthetic/rollinggo', keySha256: 'a'.repeat(64), evidenceKind: 'fixture', connector: { search: async () => ({
    hotels: [{ hotelId: 111, name: 'Synthetic Shared Hotel Name', address: 'Synthetic address', price: { hasPrice: true, currency: 'USD', lowestPrice: 80.25 } },
      { hotelId: 222, name: 'Synthetic Shared Hotel Name', price: { hasPrice: false, currency: 'USD' } }],
    observedAt: new Date().toISOString(), priceKind: 'reference', providerExpiry: 'unknown',
  }) } };
  let calls = 0;
  // An explicitly bounded live capture can inject its real connector; model
  // decisions remain controlled and do not claim a live reasoning benchmark.
  const connector = configured.connector;
  if (!connector) throw new Error('The validation fixture needs an explicit connector');
  const catalog = createExecutionCatalog({ store, rollinggo: { ...configured, connector: { search: async (...args) => {
    if (++calls > (options?.maxCalls ?? Infinity)) throw new Error('Validation source-call budget exhausted');
    return connector.search(...args);
  } } } });
  const program = catalog.agentProgram({ id: 'hotel.search.query', version: '1' }, owner);
  if (!(program instanceof RollingGoProgram)) throw new Error('Missing existing RollingGo program');
  const model: Reasoner = { reviewGoal: syntheticGoalReview,
    ground: async (request, _caps, _signal, access) => ({ decision: {
      ...interpretation(observeTaskContext(access) ?? request, program.ref.id, input), capabilityRef: program.ref,
    }, evidence: evidence() }), plan: async () => { throw new Error('No legacy plan'); },
    act: async (ctx, _signal, access) => {
      observeTaskContext(access);
      access.session.call('describe_ontology', { actions: ['SearchRollingGoHotels'] });
      access.session.call('query_ontology', { object: ctx.state.scope });
      const observation = ctx.state.observations[0];
      if (observation) {
        access.session.call('query_ontology', { object: observation });
        access.session.call('evaluate_ontology', { function: 'rollingGoSearchStatus', object: observation });
      }
      const decision = { kind: observation ? 'complete' as const : 'execute' as const, requestRevision: ctx.request.revision,
        message: 'Controlled isolated hotel validation', steps: observation ? [] : [{ id: 'search', action: 'SearchRollingGoHotels',
          argumentsJson: JSON.stringify({ scope: ctx.state.scope }), dependsOn: [], inputRefs: [] }],
        completionJson: observation ? JSON.stringify({ observation, rationale: 'Read and evaluate the exact hotel source observation' }) : '' };
      acknowledgeReads(access);
      return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
    } };
  const runtime = backend(catalog, model, store), worker = new Worker(store, { coordinator: runtime.coordinator, pollMs: 10, leaseMs: 30000, timeoutMs: 90000 });
  async function run() {
    const submitted = runtime.submit({ goal: 'Isolated hotel search validation; no booking or payment', executionEnvironment: program!.capability().environment });
    worker.start();
    const until = performance.now() + 90000;
    while (['submitted', 'working'].includes(store.get(owner, submitted.id).state) && performance.now() < until) await setTimeout(20);
    const job = store.get(owner, submitted.id);
    if (job.state !== 'completed') throw new Error(JSON.stringify({ state: job.state, feedback: job.delegation?.agent?.feedback, grounding: job.delegation?.groundingFeedback }));
    const observation = job.delegation!.agent!.observations[0]!;
    const graph = store.ontologyForJob(owner, job);
    const snapshot = checkedRollingGo(graph.read(owner, observation).properties.snapshot);
    const samples = { HotelProperty: graph.related(owner, observation, 'hotels', { remaining: 1000 })!.map(view => view.properties),
      HotelPrice: graph.related(owner, observation, 'prices', { remaining: 1000 })!.map(view => view.properties) };
    return { job, observation, snapshot, samples };
  }
  return { store, program, run, calls: () => calls, close: async () => { await worker.close(); store.close(); } };
}

/** Synthetic native-format metadata; real generated YAML stays in private evidence. */
export function hotelModelDocument(samples: { HotelProperty: Record<string, unknown>[]; HotelPrice: Record<string, unknown>[] }) {
  const sql: unknown[] = [];
  const tables = (['HotelProperty', 'HotelPrice'] as const).map(type => ({ id: type, name: type,
    columns: [...new Set(samples[type].flatMap(sample => Object.keys(sample)))].map(name => ({ id: `${type}.${name}`, name })) }));
  return { data_layer: { databases: [{ id: 'synthetic-hotels', schemas: [{ tables }] }] },
    semantic_layer: { terms: tables.map(table => ({ id: `term.${table.id}`, name: table.id === 'HotelProperty' ? 'Hotel' : 'Hotel Reference Price',
      represents: [table.id], columns_attributes: table.columns.map(column => ({ id: `attribute.${column.id}`, name: column.name, column_id: column.id })) })),
    sql_attributes: { manual: [], table: [], sql, bridge_table: [] }, custom_analyses: [] }, zones: [] };
}
export const hotelModelYaml = (samples: Parameters<typeof hotelModelDocument>[0]) => stringify(hotelModelDocument(samples));
