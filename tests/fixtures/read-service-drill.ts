// Synthetic provider inputs and frozen public investigation cases. Expected
// answers live in the maintainer test, never in the participant interface.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from '../../packages/core/delegation.js';
import { JobStore } from '../../packages/core/store.js';
import { createExecutionCatalog } from '../../packages/capabilities/catalog.js';
import { OntologyObjectStore } from '../../packages/ontology/object-store.js';
import { projectRideEstimate, checkedRideEstimate } from '../../packages/ontology/ride-estimate-projection.js';
import { backend, owner } from '../backend-fixture.js';
import { didiFixture, didiModel, input as rideInput } from './didi.js';
import { hotelValidationFixture } from './autoontology-hotel.js';
import type { ServiceRequest } from '../../packages/ontology/execution.js';
import type { DrillDataset } from '../../examples/ontology-drill.js';

export async function readServiceDrillDatasets(directory: string, values = { fare: '73.05', revisedFare: '89.10', hotelPrice: 80.25 }): Promise<DrillDataset[]> {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const datasets: DrillDataset[] = [];
  function capture(id: string, question: string, database: string, graph: OntologyObjectStore, request: ServiceRequest, asOf = Date.now()) {
    const source = new DatabaseSync(database, { readOnly: true });
    try {
      const tables = Object.fromEntries(['ontology_objects', 'ontology_links', 'ontology_revisions'].map(table => [table, source.prepare(`SELECT * FROM ${table} WHERE owner=?`).all(owner)]));
      const model = graph.model;
      datasets.push({ id, question, request: structuredClone(request), owner, asOf: new Date(asOf).toISOString(), datasetVersion: 'read-service-drill-1',
        datasetDigest: digest({ tables, request, model: model.ref, asOf }), initialize(_graph, _actor, target) {
          if (!target) throw new Error('The frozen drill needs an isolated database');
          target.exec('BEGIN');
          try {
            for (const [table, rows] of Object.entries(tables)) for (const row of rows) {
              const columns = Object.keys(row);
              target.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...columns.map(key => row[key] as SQLInputValue));
            }
            target.exec('COMMIT');
          } catch (error) { target.exec('ROLLBACK'); throw error; }
          return new OntologyObjectStore(target, model, () => asOf, undefined, { skipLegacyMigration: true });
        } });
    } finally { source.close(); }
  }

  const rideDatabase = join(directory, 'ride-source.sqlite'), fixture = didiFixture(), store = new JobStore(rideDatabase);
  try {
    fixture.flags.transform = body => {
      if (body.result?.structuredContent?.items?.[0]) body.result.structuredContent.items[0].priceText = values.fare;
      return body;
    };
    const catalog = createExecutionCatalog({ store, didi: { ...fixture.binding, connector: fixture.connector } });
    const runtime = backend(catalog, didiModel(), store);
    const task = runtime.submit({ goal: `只查${rideInput.city}${rideInput.origin}到${rideInput.destination}的滴滴车型估价，不下单不付款` });
    let job = task;
    for (let round = 0; round < 12 && ['submitted', 'working'].includes(job.state); round++) job = await runtime.run();
    if (job.state !== 'completed') throw new Error(`Synthetic ride capture did not settle: ${job.state}`);
    const graph = store.ontologyForJob(owner, job), request = job.delegation!.request;
    capture('R1', '我现在从北京西站到西二旗地铁站，各车型有哪些有依据的费用信息？说明币种、价格性质和适用条件。能否保证最终支出，是否已经叫到车？', rideDatabase, graph, request);
    const ref = job.delegation!.agent!.observations.find(ref => ref.type === 'RideEstimateObservation')!;
    const { contentDigest: _digest, ...snapshot } = structuredClone(checkedRideEstimate(graph.read(owner, ref).properties.snapshot));
    if (snapshot.data.kind !== 'estimate') throw new Error('Expected the estimate capture');
    const changedAt = Date.parse(snapshot.observedAt) + 1000, id = randomUUID();
    snapshot.data.items[0]!.priceText = values.revisedFare;
    snapshot.data.items[0]!.estimatedMoney = { minor: values.revisedFare.replace('.', ''), currency: 'CNY' };
    Object.assign(snapshot, { id, observedAt: new Date(changedAt).toISOString(), expiresAt: new Date(changedAt + 300000).toISOString(),
      receipt: { ...snapshot.receipt, id, startedAt: new Date(changedAt).toISOString(), receivedAt: new Date(changedAt).toISOString(), resultDigest: digest(snapshot.data) } });
    projectRideEstimate(graph, owner, { ...snapshot, contentDigest: digest(snapshot) });
    capture('R2', '同一路线已有不止一批车型估价。现在应采用哪些价格，旧价格为什么能用或不能用？请用来源和时点支持判断，保留未知费用。', rideDatabase, graph, request, Math.max(Date.now(), changedAt + 100));
    capture('R3', '以本题时点为准，没有再收到新的滴滴价格回执。现有估价还能用于当前费用回答吗？哪些地点或路线信息可以继续引用，哪些需要补充核验？', rideDatabase, graph, request, changedAt + 600001);
  } finally { store.close(); fixture.close(); }

  const hotelDatabase = join(directory, 'hotel-source.sqlite');
  const hotel = hotelValidationFixture({ database: hotelDatabase, source: { keyFile: '/synthetic/rollinggo', keySha256: 'a'.repeat(64), evidenceKind: 'fixture', connector: { search: async () => ({
    hotels: [{ hotelId: 111, name: '合成同名酒店', address: '合成地址甲', price: { hasPrice: true, currency: 'USD', lowestPrice: values.hotelPrice } },
      { hotelId: 222, name: '合成同名酒店', price: { hasPrice: false, currency: 'USD' } }],
    observedAt: new Date().toISOString(), priceKind: 'reference', providerExpiry: 'unknown',
  }) } } });
  try {
    const result = await hotel.run(), graph = hotel.store.ontologyForJob(owner, result.job), request = result.job.delegation!.request;
    capture('H1', '酒店搜索实际找到了几家不同的酒店？有哪些有依据的价格、入住日期、晚数和人数？能否据此确定含税总价、早餐、房型和可预订库存？', hotelDatabase, graph, request);
    capture('H2', '我选的是来源编号222那家同名酒店。现在有依据的价格是多少？可以直接使用另一家同名酒店的价格或判断已经订妥吗？说明信息缺口。', hotelDatabase, graph, request);
    const property = graph.query(owner, { type: 'HotelProperty', where: [{ property: 'sourceId', op: 'eq', value: '111' }] }).items[0]!;
    graph.ingest(owner, { objects: [{ ref: property.ref, expectedRevision: property.revision, properties: { ...property.properties, address: '合成地址乙' } }] },
      { kind: 'synthetic', id: 'hotel-description-change', observedAt: new Date().toISOString() });
    capture('H3', '酒店资料已经发生变化。先前返回的参考价格还能直接用于现在的酒店资料吗？哪些已读事实支持你的判断，下一步需要刷新什么？', hotelDatabase, graph, request);
  } finally { await hotel.close(); }
  return datasets;
}
