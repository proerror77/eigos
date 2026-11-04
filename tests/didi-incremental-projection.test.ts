import assert from 'node:assert/strict';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { test } from 'node:test';
import { digest } from '../packages/core/delegation.js';
import {
  linkSnapshotDigest,
  type LinkWrite,
} from '../packages/ontology/object-store.js';
import type { ObjectRef } from '../packages/ontology/model.js';
import { owner } from './backend-fixture.js';
import { setupDidi } from './fixtures/didi.js';

test('incremental DiDi estimate stays within its read budget with exact routes and attested quotes', async (t) => {
  const f = setupDidi();
  let selects = 0;
  for (const method of ['get', 'all', 'run'] as const) {
    const execute = StatementSync.prototype[method];
    t.mock.method(
      StatementSync.prototype,
      method,
      function (
        this: StatementSync,
        ...args: Parameters<StatementSync['get']>
      ) {
        if (/^SELECT\b/i.test(this.sourceSQL.trim())) selects++;
        return Reflect.apply(execute, this, args);
      },
    );
  }
  try {
    const job = f.b.submit({
      goal: '只查北京西站到西二旗地铁站的滴滴估价，不下单不付款',
    });
    const done = await f.finish(job.id);
    assert.equal(done.state, 'completed');
    assert(
      selects <= 10500,
      `Single-estimate SELECT budget exceeded: ${selects}`,
    );
    assert.deepEqual(
      f.calls.filter((c) => c.method === 'tools/call').map((c) => c.name),
      ['maps_textsearch', 'maps_textsearch', 'taxi_estimate'],
    );
    const graph = f.store.ontology;
    const db = (f.store as unknown as { db: DatabaseSync }).db;
    const core = db
      .prepare(
        "SELECT type,id FROM ontology_objects WHERE owner=? AND type IN ('RideEstimate','RideRoute','SourceReceipt')",
      )
      .all(owner);
    const rows = core.map((r) =>
      graph.readPrivate(owner, { type: String(r.type), id: String(r.id) }),
    );
    const quotes = rows.filter((r) => r.ref.type === 'RideEstimate');
    assert.equal(quotes.length, 2);
    assert(
      quotes.some(
        (q) =>
          q.properties.estimatedAmount === '73.05' &&
          q.properties.currency === 'CNY',
      ),
    );
    assert(
      quotes.some(
        (q) =>
          q.properties.priceText === '100-120元' &&
          q.properties.estimatedAmount === undefined,
      ),
    );
    const routes = rows.filter((r) => r.ref.type === 'RideRoute');
    assert.equal(routes.length, 1);
    assert.equal(routes[0]!.properties.origin, '北京西站');
    assert.equal(routes[0]!.properties.destination, '西二旗地铁站');
    const links: LinkWrite[] = db
      .prepare('SELECT * FROM ontology_links WHERE owner=?')
      .all(owner)
      .map((r) => ({
        type: String(r.type),
        from: { type: String(r.from_type), id: String(r.from_id) },
        to: { type: String(r.to_type), id: String(r.to_id) },
      }));
    const receipts = rows.filter((r) => r.ref.type === 'SourceReceipt');
    assert.equal(receipts.length, 3);
    for (const receipt of receipts) {
      assert.equal(receipt.properties.evidenceLevel, 'synthetic');
      const subjects = receipt.properties.subjects as {
        object: ObjectRef;
        digest: string;
        linksDigest: string;
      }[];
      for (const subject of subjects) {
        assert.equal(
          digest(graph.readPrivate(owner, subject.object).properties),
          subject.digest,
        );
        assert.equal(
          linkSnapshotDigest(subject.object, links),
          subject.linksDigest,
        );
      }
    }
    for (const quote of quotes) {
      const matches = (type: string) =>
        links.filter(
          (l) =>
            l.type === type &&
            l.from.type === quote.ref.type &&
            l.from.id === quote.ref.id,
        );
      assert.deepEqual(
        matches('RideEstimateBusinessRoute').map((l) => l.to),
        [routes[0]!.ref],
      );
      assert(
        matches('RideEstimateEvidence').some((l) =>
          receipts.some(
            (receipt) =>
              receipt.ref.id === l.to.id &&
              (receipt.properties.subjects as { object: ObjectRef }[]).some(
                (s) =>
                  s.object.type === quote.ref.type &&
                  s.object.id === quote.ref.id,
              ),
          ),
        ),
      );
    }
  } finally {
    f.close();
  }
});
