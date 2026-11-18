import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, principal } from './fixture.js';
import { Access, memberGrants, setGrants } from '../packages/runtime/access.js';
import { Actions } from '../packages/runtime/actions.js';
import { ExternalOperations } from '../packages/runtime/external-operations.js';
import { Objects } from '../packages/runtime/objects.js';
import { addProcessLogs } from '../packages/ontology/process-definition.js';
import { ObservationInterests } from '../packages/runtime/observation-interests.js';
import { ScheduledActions, ScheduledActionRunner } from '../packages/runtime/scheduled-actions.js';
import { ontologyServices } from '../packages/runtime/services.js';

async function setup() {
  const f = await fixture();
  try {
    const definition = structuredClone(f.model.document),
      route = definition.objectTypes.find((type) => type.apiName === 'Route')!;
    route.properties.status = {
      description: 'Source-observed route progress',
      required: false,
      schema: { type: 'string', enum: ['planned', 'dispatched', 'done', 'rejected'] },
    };
    route.properties.receiptAt = {
      description: 'Supplier observation time',
      required: false,
      schema: { type: 'string', format: 'date-time' },
    };
    addProcessLogs(definition, [{ type: 'Route', property: 'status' }]);
    for (const [name, status] of [
      ['ObserveDispatch', 'dispatched'],
      ['ObserveArrival', 'done'],
    ] as const) {
      definition.actionTypes.push({
        apiName: name,
        description: 'Synthetic provider readback',
        typeClasses: [{ kind: 'observation', name: 'readback' }],
        parameters: {
          type: 'object',
          properties: { route: { type: 'object' } },
          required: ['route'],
          additionalProperties: false,
        },
        objectParameters: { route: 'Route' },
        submissionCriteria: [],
        rules: [
          {
            op: 'editObject',
            object: { parameter: 'route' },
            expectedRevision: { literal: status === 'dispatched' ? 1 : 2 },
            properties: { status: { literal: status } },
          },
        ],
        result: { type: 'Route', id: { parameter: 'route', path: ['id'] } },
      });
    }
    const model = await f.metadata.publish(definition, f.capabilities, f.publisher);
    await setGrants(f.db, principal.owner, memberGrants(model));
    const a = await Access.load(f.db, principal),
      graph = new Objects(f.db, model, a),
      object = { type: 'Route', id: 'observation-route' };
    await graph.create(object, {
      id: object.id,
      name: 'Synthetic route',
      status: 'planned',
      receiptAt: new Date(Date.now() - 300_000).toISOString(),
    });
    const services = ontologyServices(
      f.db,
      f.metadata,
      f.capabilities,
      f.capabilities.functions,
      f.capabilities.effects,
      f.capabilities.actions,
    );
    const observations = new ObservationInterests(f.db, f.metadata);
    const plan = {
      object,
      requestId: 'observe-original-route',
      deadline: new Date(Date.now() + 90 * 86400000).toISOString(),
      phases: [
        {
          name: 'Dispatch',
          process: 'RouteStatusLog',
          complete: ['dispatched'],
          stop: ['rejected'],
          action: 'ObserveDispatch',
        },
        { name: 'Arrival', process: 'RouteStatusLog', complete: ['done'], action: 'ObserveArrival' },
      ],
    };
    const start = async () =>
      (await services.get('start_observation_interest')!.invoke(principal, plan)) as Awaited<
        ReturnType<ObservationInterests['start']>
      >;
    const read = async (caller = principal) =>
      (await services.get('observation_interests')!.invoke(caller, {})) as Awaited<
        ReturnType<ObservationInterests['list']>
      >;
    const scan = async () => {
      await f.db.query(`UPDATE ${f.db.schema}.observation_interests SET next_scan=now()`);
      return new ObservationInterests(f.db, f.metadata).scanOne();
    };
    return { ...f, model, a, graph, object, observations, services, plan, start, read, scan };
  } catch (error) {
    await f.close();
    throw error;
  }
}
test('an ordered original-object interest survives process restart, carries a long horizon and drives only its approved readbacks', async () => {
  const f = await setup();
  try {
    const started = await f.start();
    assert.equal(started.phaseIndex, 0);
    assert.equal(started.status, 'watching');
    assert(new Date(started.deadline).getTime() > Date.now() + 80 * 86400000);
    assert(new Date(started.checkDeadline!).getTime() < Date.now() + 31 * 86400000);
    assert.equal((await f.start()).id, started.id);
    await assert.rejects(
      f.observations.start(f.a, f.model, {
        ...f.plan,
        phases: [{ ...f.plan.phases[0], action: 'CancelDidiRideOrder' }],
      }),
      /observation readback/i,
    );
    assert.equal(await f.worker.runOne(), true);
    assert.equal(await f.scan(), true);
    assert.equal((await f.read()).items[0]!.phaseIndex, 1);
    assert.equal(await f.worker.runOne(), true);
    assert.equal(await f.scan(), true);
    assert.equal((await f.read()).items[0]!.status, 'completed');
    assert.equal((await f.graph.read(f.object)).properties.status, 'done');
    const finished = (await f.read()).items[0]!;
    await f.graph.edit(f.object, 3, { status: 'planned' });
    const frozen = (await f.read()).items[0]!;
    assert.equal(frozen.lastState, 'done');
    assert.deepEqual(frozen.lastObservedAt, finished.lastObservedAt);
    assert.equal((await f.db.query(`SELECT count(*)::int n FROM ${f.db.schema}.scheduled_actions`)).rows[0]!.n, 2);
    assert.equal((await f.db.query(`SELECT count(*)::int n FROM ${f.db.schema}.external_operations`)).rows[0]!.n, 0);
  } finally {
    await f.close();
  }
});

test('late or missing checks remain visible even without an outstanding task, and an owner can stop or withdraw them', async () => {
  const f = await setup();
  try {
    const item = await f.start();
    await f.db.query(`UPDATE ${f.db.schema}.scheduled_actions SET run_at=now()-interval '2 minutes'`);
    assert.equal((await f.read()).items[0]!.status, 'late');
    await f.db.query(`DELETE FROM ${f.db.schema}.scheduled_actions`);
    const missing = (await f.read()).items[0]!;
    assert.equal(missing.status, 'stranded');
    assert.equal(missing.reason, 'schedule_missing');
    await f.scan();
    assert.equal((await f.read()).items[0]!.status, 'stranded');
    await setGrants(f.db, 'observation-peer', memberGrants(f.model));
    const peer = { ...principal, owner: 'observation-peer' };
    assert.equal((await f.read(peer)).items.length, 0);
    await assert.rejects(f.services.get('cancel_observation_interest')!.invoke(peer, { id: item.id }), /unavailable/);
    await f.services.get('cancel_observation_interest')!.invoke(principal, { id: item.id });
    assert.equal((await f.read()).items[0]!.status, 'canceled');
  } finally {
    await f.close();
  }
});

test('revocation stops a claimed interest before Action dispatch and preserves the original object', async () => {
  const f = await setup();
  try {
    await f.start();
    const schedules = new ScheduledActions(f.db, f.metadata);
    assert.equal(await schedules.promoteOne(), true);
    const task = await f.tasks.claim('scheduled');
    assert(task);
    await setGrants(
      f.db,
      principal.owner,
      memberGrants(f.model).filter((grant) => grant.resource !== 'Eigos/action/ObserveArrival'),
    );
    await assert.rejects(
      new ScheduledActionRunner(f.db, f.metadata, f.tasks, f.capabilities.actions).run(
        task,
        AbortSignal.timeout(10000),
      ),
      /permission/i,
    );
    await f.scan();
    assert.equal((await f.read()).items[0]!.status, 'blocked');
    assert.equal((await f.graph.read(f.object)).properties.status, 'planned');
  } finally {
    await f.close();
  }
});

test('a bounded legacy schedule is reused, then a fresh read is admitted inside the longer interest window', async () => {
  const f = await setup();
  try {
    const original = 'existing-connector-check';
    await f.db.transaction(async (client) => {
      const g = new Objects(f.db, f.model, f.a, client);
      await new ScheduledActions(f.db, f.metadata).enqueue(g, {
        id: original,
        action: 'ObserveDispatch',
        arguments: { route: f.object },
        runAt: new Date(Date.now() + 30000).toISOString(),
        deadline: new Date(Date.now() + 60000).toISOString(),
      });
    });
    await f.start();
    assert.equal((await f.db.query(`SELECT count(*)::int n FROM ${f.db.schema}.scheduled_actions`)).rows[0]!.n, 1);
    await f.db.query(`UPDATE ${f.db.schema}.scheduled_actions SET state='expired' WHERE id=$1`, [original]);
    await f.scan();
    const active = (await f.read()).items[0]!;
    assert.equal(active.status, 'watching');
    assert(active.nextCheckAt);
    assert.equal((await f.db.query(`SELECT count(*)::int n FROM ${f.db.schema}.scheduled_actions`)).rows[0]!.n, 2);
    await f.observations.cancel(f.a, f.model, { id: active.id });
    assert.equal(
      (await f.db.query(`SELECT count(*)::int n FROM ${f.db.schema}.scheduled_actions WHERE state='scheduled'`))
        .rows[0]!.n,
      0,
    );
  } finally {
    await f.close();
  }
});

test('a silent event subscription is still live when its original source later supplies the terminal state', async () => {
  const f = await setup();
  try {
    const interest = await f.observations.start(f.a, f.model, {
      object: f.object,
      requestId: 'late-source',
      deadline: f.plan.deadline,
      phases: [
        { name: 'Wait for arrival', process: 'RouteStatusLog', complete: ['done'], wait: { maxSilenceSeconds: 30 } },
      ],
    });
    await f.db.query(
      `UPDATE ${f.db.schema}.observation_interests SET phase_started_at=now()-interval '90 seconds' WHERE id=$1`,
      [interest.id],
    );
    await f.db.query(
      `UPDATE ${f.db.schema}.edit_history SET happened_at=now()-interval '2 minutes',observed_at=now()-interval '2 minutes'
      WHERE type='Route' AND id=$1`,
      [f.object.id],
    );
    await f.scan();
    let row = (await f.read()).items[0]!;
    assert.equal(row.status, 'stranded');
    assert.equal(row.reason, 'no_source_evidence');
    await f.graph.edit(f.object, (await f.graph.read(f.object)).revision, { status: 'done' });
    await f.scan();
    row = (await f.read()).items[0]!;
    assert.equal(row.status, 'completed');
    assert.equal(row.lastState, 'done');
    assert.equal((await f.db.query(`SELECT count(*)::int n FROM ${f.db.schema}.scheduled_actions`)).rows[0]!.n, 0);
  } finally {
    await f.close();
  }
});

test('interest-owned checks cannot acquire a supplier dispatch claim even when the labeled implementation attempts one', async () => {
  const f = await setup();
  try {
    await f.start();
    assert(await new ScheduledActions(f.db, f.metadata).promoteOne());
    const task = await f.tasks.claim('scheduled');
    assert(task);
    let supplierWrites = 0;
    class AttemptExternalWrite extends Actions {
      override async apply(...args: Parameters<Actions['apply']>) {
        await new ExternalOperations(f.db).run(
          principal.owner,
          'unexpected-mutation',
          {},
          async () => {},
          async () => ++supplierWrites,
        );
        return super.apply(...args);
      }
    }
    const runner = new ScheduledActionRunner(
      f.db,
      f.metadata,
      f.tasks,
      new AttemptExternalWrite(f.db, f.capabilities.functions),
    );
    await assert.rejects(runner.run(task, AbortSignal.timeout(10000)), /cannot dispatch a supplier mutation/);
    assert.equal(supplierWrites, 0);
    assert.equal((await f.db.query(`SELECT count(*)::int n FROM ${f.db.schema}.external_operations`)).rows[0]!.n, 0);
  } finally {
    await f.close();
  }
});

test('successful checks with stale supplier timestamps expose silence and cannot complete a phase until evidence advances', async () => {
  const f = await setup();
  try {
    const item = await f.observations.start(f.a, f.model, {
      object: f.object,
      requestId: 'fresh-supplier-evidence',
      deadline: f.plan.deadline,
      phases: [
        {
          name: 'Dispatch',
          process: 'RouteStatusLog',
          action: 'ObserveDispatch',
          evidenceProperty: 'receiptAt',
          maxSilenceSeconds: 30,
          complete: ['dispatched'],
        },
      ],
    });
    await f.db.query(
      `UPDATE ${f.db.schema}.observation_interests SET phase_started_at=now()-interval '10 minutes' WHERE id=$1`,
      [item.id],
    );
    assert.equal(await f.worker.runOne(), true);
    assert.equal((await f.graph.read(f.object)).properties.status, 'dispatched');
    await f.scan();
    const stale = (await f.read()).items[0]!;
    assert.equal(stale.status, 'stranded');
    assert.equal(stale.reason, 'source_silent');
    assert(stale.nextCheckAt);
    await f.graph.edit(f.object, 2, { receiptAt: new Date().toISOString() });
    await f.scan();
    const recovered = (await f.read()).items[0]!;
    assert.equal(recovered.status, 'completed');
    assert.equal(recovered.lastState, 'dispatched');
    assert.equal(
      (await f.db.query(`SELECT count(*)::int n FROM ${f.db.schema}.scheduled_actions WHERE state='scheduled'`))
        .rows[0]!.n,
      0,
    );
  } finally {
    await f.close();
  }
});
