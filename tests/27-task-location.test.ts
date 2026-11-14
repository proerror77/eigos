import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PARequests } from '../packages/runtime/pa.js';
import type { AgentDriver, AgentTool } from '../packages/runtime/agent.js';
import { fixture, principal } from './fixture.js';

const point = { latitude: 31.1234567, longitude: 121.2345678, coordinateSystem: 'wgs84' };
const current = () => ({
  status: 'available',
  location: { ...point, source: 'device', accuracyMeters: 15, observedAt: new Date().toISOString() },
});
const other = { ...principal, owner: 'different-location-owner' };
type Request = { kind: string; requestId: string; capability: string; input: Record<string, unknown> };

class LocationAgent implements AgentDriver {
  readonly model = 'location-fixture';
  async run(prompt: string, tools: ReadonlyMap<string, AgentTool>) {
    const goal = JSON.parse(JSON.parse(prompt.split('\n').at(-1)!).userRequest.message);
    const { functionName, ...input } = goal;
    await tools.get('complete_with_function')!.invoke({ function: functionName ?? 'findLuckinShops', input });
  }
}
const requestFrom = (result: unknown) => {
  const request = result as Request;
  assert.equal(request.kind, 'pa-request');
  return request;
};

test('a nearby coffee query resumes with a fresh, authorized point on the same task', async () => {
  const f = await fixture(new LocationAgent());
  try {
    assert(f.model.resolvedDocument.valueTypes?.some(t => t.apiName === 'TaskLocation'));
    const task = await f.tasks.submit(principal, { requestId: 'coffee-nearby', message: '{}' });
    await f.worker.runOne();
    const pending = requestFrom((await f.tasks.get(principal, task.id)).result);
    assert.equal(pending.capability, 'location.resolve');
    assert.deepEqual(pending.input, {
      use: 'luckin_pickup', selection: { source: 'current' }, coordinateSystem: 'wgs84',
      maxAgeMs: 120000, maxAccuracyMeters: 300,
    });
    const pa = new PARequests(f.tasks);
    await assert.rejects(pa.respond(other, task.id, { requestId: pending.requestId, response: current() }), /Task is unavailable/);
    await pa.respond(principal, task.id, { requestId: pending.requestId, response: current() });
    await f.worker.runOne();
    const shopsRequest = requestFrom((await f.tasks.get(principal, task.id)).result);
    assert.equal(shopsRequest.capability, 'luckin.shops.read');
    assert.deepEqual(shopsRequest.input, { latitude: point.latitude, longitude: point.longitude });
    await pa.respond(principal, task.id, { requestId: shopsRequest.requestId, response: {
      status: 'available', connectionRef: 'a'.repeat(64), observedAt: new Date().toISOString(),
      evidence: 'pa_reported', data: [],
    } });
    await f.worker.runOne();
    const result = await f.tasks.get(principal, task.id);
    assert.equal(result.state, 'completed', result.error ?? undefined);
    assert(!JSON.stringify(result.result).includes(String(point.longitude)));
    const { rows: [counts] } = await f.db.query(`SELECT
       (SELECT count(*)::int FROM ${f.db.schema}.scenarios) scenarios,
       (SELECT count(*)::int FROM ${f.db.schema}.scheduled_actions) scheduled,
       (SELECT count(*)::int FROM ${f.db.schema}.external_operations) operations`);
    assert.deepEqual(counts, { scenarios: 0, scheduled: 0, operations: 0 });
    const separate = await f.tasks.submit(principal, { requestId: 'other-task',
      message: JSON.stringify({ locationRequestId: pending.requestId }) });
    await f.worker.runOne();
    const denied = await f.tasks.get(principal, separate.id);
    assert.equal(denied.state, 'failed');
    assert.match(denied.error ?? '', /matching authorized location/);
  } finally { await f.close(); }
});

test('planned and specified locations require the chosen place, and stale or low-accuracy device points stop the provider call', async () => {
  const f = await fixture(new LocationAgent()), pa = new PARequests(f.tasks);
  try {
    const observation = current();
    const cases = [
      { selection: { source: 'planned', place: '杭州东站' },
        response: { status: 'available', location: { ...point, source: 'planned', place: '杭州东站' } }, accepted: true },
      { selection: { source: 'specified', place: '公司' },
        response: observation, accepted: false },
      { selection: { source: 'current' },
        response: { ...observation, location: { ...observation.location, observedAt: new Date(Date.now() - 180000).toISOString() } }, accepted: false },
      { selection: { source: 'current' },
        response: { ...observation, location: { ...observation.location, accuracyMeters: 800 } }, accepted: false },
      { selection: { source: 'current' },
        response: { ...observation, location: { ...observation.location, coordinateSystem: 'gcj02' } }, accepted: false },
      { selection: { source: 'current' },
        response: { status: 'declined' }, accepted: false },
    ];
    for (const [index, entry] of cases.entries()) {
      const task = await f.tasks.submit(principal, { requestId: `location-${index}`, message: JSON.stringify({
        functionName: 'resolveTaskLocation', use: 'luckin_pickup', selection: entry.selection, coordinateSystem: 'wgs84',
      }) });
      await f.worker.runOne();
      const pending = requestFrom((await f.tasks.get(principal, task.id)).result);
      assert.deepEqual(pending.input.selection, entry.selection);
      await pa.respond(principal, task.id, { requestId: pending.requestId, response: entry.response });
      await f.worker.runOne();
      const result = await f.tasks.get(principal, task.id);
      if (entry.accepted) {
        assert.equal(result.state, 'completed');
        assert.equal((result.result as { source: string }).source, 'planned');
        assert(!JSON.stringify(result.result).includes(String(point.latitude)));
      } else {
        assert.equal(result.state, 'input-required');
        assert.equal(result.result, null);
        assert.match(result.error ?? '', /请/);
      }
      const rows = (await f.db.query(`SELECT request FROM ${f.db.schema}.pa_requests WHERE task_id=$1`, [task.id])).rows;
      assert.deepEqual(rows.map(row => row.request.capability), ['location.resolve']);
    }
  } finally { await f.close(); }
});
