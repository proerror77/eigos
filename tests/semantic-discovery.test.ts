import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
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
  'local Chinese embeddings and pgvector drive the real Agent action-discovery path',
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
      const reader = 'sem_reader_' + randomUUID().replaceAll('-', '');
      await f.t.client.query(`CREATE ROLE ${sqlIdentifier(reader)}`);
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
        await f.t.client.query(`DROP OWNED BY ${sqlIdentifier(reader)}`);
        await f.t.client.query(`DROP ROLE ${sqlIdentifier(reader)}`);
      }
      Object.assign(f.options, { semantic });
      const { value: session } = await f.session();
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
      await assert.rejects(() =>
        session.call('discover_actions', {
          search: query,
          searchMode: 'semantic',
        }),
      );
    } finally {
      await f.t.client.query(`DROP SCHEMA ${sqlIdentifier(schema)} CASCADE`);
      await f.close();
      await model.close();
    }
  },
);
