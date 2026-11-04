import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {createPostgresWorker} from '../apps/worker/postgres-runtime.js';
import type {PlanningAccess} from '../packages/coordinator/coordinator.js';
import type {PostgresExecutor,PostgresReasoner} from '../packages/postgres/coordinator.js';
import {assertSemanticIndexReader,createReadOnlySemanticRanker} from '../packages/semantic/runtime.js';
import { digest } from '../packages/core/delegation.js';
import { loadLocalEmbedding } from '../packages/semantic/local-embedding.js';
import {
  SemanticCatalog,
  catalogDocuments,
  sqlIdentifier,
} from '../packages/semantic/catalog.js';
import { parseOntologyDocument } from '../packages/ontology/definition-contracts.js';
import type { ActionDiscoveryPage } from '../packages/core/action-bindings.js';
import { postgresDidiFixture } from './fixtures/postgres-didi.js';

const enabled = process.env.EIGOS_TEST_SEMANTIC === '1';
test(
  'production PostgreSQL Worker routes local Chinese embeddings through native Agent discovery',
  { skip: !enabled, timeout: 240000 },
  async (t) => {
    const directory = process.env.EIGOS_SEMANTIC_MODEL_DIR;
    assert(directory);
    // Preparation downloads public weights separately. Serving is offline.
    t.mock.method(globalThis, 'fetch', () =>
      Promise.reject(Error('Network use during local semantic serving')),
    );
    const model = await loadLocalEmbedding(directory);
    const schema = 'eigos_semantic_' + randomUUID().replaceAll('-', '');
    const semantic = new SemanticCatalog(model, schema);
    const f = await postgresDidiFixture();
    const reader = 'sem_reader_' + randomUUID().replaceAll('-', '');
    let readerCreated = false, indexPool: pg.Pool | undefined;
    try {
      await f.t.client.query(
        'CREATE SCHEMA IF NOT EXISTS extensions; CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions',
      );
      await f.t.client.query('BEGIN');
      try {
        await semantic.initialize(f.t.client);
        await f.t.client.query('COMMIT');
      } catch (e) {
        await f.t.client.query('ROLLBACK');
        throw e;
      }
      const current = await f.stored(),
        ref = current.delegation!.ontologyRelease!;
      const row = await f.t.client.query(
        `SELECT body FROM ${f.q}.ontology_definition_releases WHERE id=$1 AND digest=$2`,
        [ref.releaseId, ref.digest],
      );
      const document = parseOntologyDocument(JSON.parse(row.rows[0].body));
      assert.equal(digest(document), ref.digest);
      const docs = catalogDocuments(document);
      const indexed = await promisify(execFile)(
        process.execPath,
        [
          '--import',
          'tsx',
          'scripts/semantic-catalog.mjs',
          'index',
          '--model-dir',
          directory,
          '--schema',
          schema,
          '--business-schema',
          f.t.schema,
          '--ontology',
          ref.ontologyId,
          '--release',
          ref.digest,
        ],
        { env: process.env, timeout: 180000 },
      );
      assert.equal(JSON.parse(indexed.stdout).documents, docs.length);
      await f.t.client.query(`CREATE ROLE ${sqlIdentifier(reader)} LOGIN NOINHERIT PASSWORD 'fixture-semantic-reader'`);
      readerCreated = true;
      try {
        await f.t.client.query('BEGIN');
        try {
          await semantic.initialize(f.t.client, reader);
          await f.t.client.query('COMMIT');
        } catch (e) {
          await f.t.client.query('ROLLBACK');
          throw e;
        }
        await f.t.client.query(`SET ROLE ${sqlIdentifier(reader)}`);
        await assertSemanticIndexReader(f.t.client,semantic,{role:process.env.PGUSER!,business:f.t.schema,membership:f.t.membershipSchema});
        await assert.rejects(()=>assertSemanticIndexReader(f.t.client,semantic,{role:reader,business:f.t.schema,membership:f.t.membershipSchema}),/independent/);
        assert.equal(
          (
            await f.t.client.query(
              "SELECT has_schema_privilege(current_user,'extensions','USAGE') AS value",
            )
          ).rows[0].value,
          false,
        );
        const limited = await semantic.rank(
          f.t.client,
          ref,
          [document.actions.find((a) => a.id === 'EstimateDidiRide')!],
          '车型预估价格',
        );
        assert.deepEqual(limited.actionIds, ['EstimateDidiRide']);
      } finally {
        await f.t.client.query('RESET ROLE');
      }
      await f.t.client.query(`GRANT USAGE ON SCHEMA ${f.q} TO ${sqlIdentifier(reader)}`);
      await f.t.client.query(`SET ROLE ${sqlIdentifier(reader)}`);
      try{await assert.rejects(()=>assertSemanticIndexReader(f.t.client,semantic,{role:process.env.PGUSER!,business:f.t.schema,membership:f.t.membershipSchema}),/independent/);}
      finally{await f.t.client.query('RESET ROLE');await f.t.client.query(`REVOKE USAGE ON SCHEMA ${f.q} FROM ${sqlIdentifier(reader)}`);}
      indexPool = new pg.Pool({host:process.env.PGHOST,port:Number(process.env.PGPORT),database:process.env.PGDATABASE,
        user:reader,password:'fixture-semantic-reader',max:2});
      const ranker=createReadOnlySemanticRanker(semantic,indexPool);
      const independent=await ranker.rank(new pg.Client(),ref,[document.actions.find(a=>a.id==='EstimateDidiRide')!],'车型预估价格');
      assert.deepEqual(independent.actionIds,['EstimateDidiRide'],'The business connection is unused by the independent index reader');
      const verifyDiscovery=async(session:PlanningAccess['session'])=>{
        const context = await session.call('read_task_context', {
          includeDefinitions: false,
        });
        assert(!('error' in (context as object)), JSON.stringify(context));
        const query = '从出发地到目的地有哪些车型，各自预计要花多少钱';
        const keyword = (await session.call('discover_actions', {
          search: query,
          searchMode: 'keyword',
        })) as ActionDiscoveryPage;
        assert(keyword.items, JSON.stringify(keyword));
        assert.equal(keyword.items.length, 0);
        const actual = (await session.call('discover_actions', {
          search: query,
          searchMode: 'semantic',
        })) as ActionDiscoveryPage;
        assert(actual.retrieval, JSON.stringify(actual));
        assert.equal(actual.retrieval.mode, 'semantic');
        assert.equal(actual.retrieval.modelId, model.modelId);
        assert.equal(actual.items[0]!.action.id, 'EstimateDidiRide');
        const binding = actual.items[0]!.bindings.find(
          (b) => b.readiness === 'ready',
        );
        assert(binding);
        assert.equal(binding.pin.ontologyRelease.digest, ref.digest);
        assert.equal(binding.pin.ownerDigest, digest(f.f.owner));
        assert(binding.inputSchema, JSON.stringify(binding));
        const contract = (await session.call('describe_ontology', {
          actions: ['EstimateDidiRide'],
          functions: ['selectDidiPlace', 'rideEstimateStatus'],
        })) as {
          actions: {
            id: string;
            read: { inputSchema: { properties: object } };
          }[];
          functions: { id: string }[];
        };
        const estimate = contract.actions.find(
          (a) => a.id === 'EstimateDidiRide',
        );
        assert(estimate, JSON.stringify(contract));
        assert.deepEqual(
          Object.keys(estimate.read.inputSchema.properties).sort(),
          [
            'destinationObservation',
            'destinationPlaceId',
            'originObservation',
            'originPlaceId',
            'scope',
          ],
        );
        assert.deepEqual(contract.functions.map((f) => f.id).sort(), [
          'rideEstimateStatus',
          'selectDidiPlace',
        ]);
        assert.equal(actual.authorization, 'per_action_required');
        assert(
          session
            .receipts()
            .some((r) => r.tool === 'discover_actions' && r.status === 'ok'),
        );
        const automatic = (await session.call('discover_actions', {
          search: query,
        })) as ActionDiscoveryPage;
        assert.equal(automatic.retrieval?.mode, 'semantic');
        t.diagnostic(
          JSON.stringify({
            model: model.modelId,
            indexed: docs.length,
            top: actual.items.map((i) => i.action.id),
            scores: actual.retrieval.scores,
          }),
        );
        // A wrong-release row with an otherwise identical embedding is never used.
        const expected = docs.find(
          (d) => d.kind === 'action' && d.id === 'EstimateDidiRide',
        )!;
        await f.t.client.query(
          `UPDATE ${semantic.schema}.catalog SET content_digest=$1 WHERE ontology_id=$2 AND release_digest=$3 AND kind='action' AND resource_id=$4`,
          ['0'.repeat(64), ref.ontologyId, ref.digest, expected.id],
        );
        await assert.rejects(
          () =>
            semantic.rank(
              f.t.client,
              ref,
              [document.actions.find((a) => a.id === expected.id)!],
              query,
            ),
          /not ready/,
        );
        await f.t.client.query(
          `UPDATE ${semantic.schema}.catalog SET content_digest=$1 WHERE ontology_id=$2 AND release_digest=$3 AND kind='action' AND resource_id=$4`,
          [expected.contentDigest, ref.ontologyId, ref.digest, expected.id],
        );
        const onlySearch = document.actions.find(
          (a) => a.id === 'SearchDidiPlaces',
        )!;
        const narrowed = await semantic.rank(
          f.t.client,
          ref,
          [onlySearch],
          query,
        );
        assert.deepEqual(narrowed.actionIds, ['SearchDidiPlaces']);
        await f.t.client.query(
          `UPDATE ${f.q}.security_grants SET state='revoked' WHERE id=$1`,
          [f.grant.id],
        );
        await assert.rejects(async () =>
          session.call('discover_actions', {
            search: query,
            searchMode: 'semantic',
          }),
        );
      };
      // Inspect the factory-created planning session, then exit before submitting a task decision.
      const verified=new Error('Synthetic reasoner finished discovery before submitting a decision');
      let entered=false;
      const reasoner:PostgresReasoner={postgresModelDispatch:'acknowledged-v1',securityChannelId:f.channel,
        ground:async()=>{throw Error('The original fixture task is already grounded');},
        plan:async()=>{throw Error('The fixture uses native Agent planning');},
        act:async(_context,_signal,access)=>{entered=true;await verifyDiscovery(access.session);throw verified;}};
      const executor:PostgresExecutor={postgresModelDispatch:'acknowledged-v1',securityChannelId:f.channel,
        run:async()=>{throw Error('Discovery must not dispatch a source or model');}};
      const runtime=createPostgresWorker({EIGOS_CODEX_BIN:'unused-with-synthetic-model-ports',EIGOS_EXECUTOR_TIMEOUT_MS:180000,
        EIGOS_CODEX_MODEL:'synthetic-semantic-wiring',EIGOS_CODEX_REASONING_EFFORT:'medium',EIGOS_CODEX_SERVICE_TIER:'priority',EIGOS_TASK_MAX_MS:86400000},
        {database:f.t.database,policyDigest:f.t.policy,builder:f.t.kernel,registry:f.registry,sourceBindingId:f.bindingId,
          modelChannel:f.channel,semantic:ranker,reasoner,executor});
      try{
        await assert.rejects(()=>runtime.coordinator.run(f.claim,new AbortController().signal),error=>error===verified);
        assert(entered,'The production Worker factory must reach its native planning session');
      }finally{await runtime.close();}
    } finally {
      await indexPool?.end();
      await f.t.client.query('RESET ROLE');
      if(readerCreated){await f.t.client.query(`DROP OWNED BY ${sqlIdentifier(reader)}`);await f.t.client.query(`DROP ROLE ${sqlIdentifier(reader)}`);}
      await f.t.client.query(`DROP SCHEMA ${sqlIdentifier(schema)} CASCADE`);
      await f.close();
      await model.close();
      await model.close(); // Startup cleanup and shutdown may share the runtime.
    }
  },
);
