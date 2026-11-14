import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../apps/gateway/app.js';
import { Worker } from '../apps/worker/worker.js';
import { createCapabilities } from '../packages/capabilities/index.js';
import { readConfig } from '../packages/core/config.js';
import { calendarJourney, journeyReadResult } from '../packages/ontology/calendar-journey.js';
import type { ObjectRef } from '../packages/ontology/schema.js';
import { Access, memberGrants, setGrants } from '../packages/runtime/access.js';
import { Objects } from '../packages/runtime/objects.js';
import { ScheduledActions, ScheduledActionRunner } from '../packages/runtime/scheduled-actions.js';
import { CalendarJourneyPA, googleCalendarJourneyReader } from '../packages/sdk/calendar-journey-pa.js';
import { OntologyClient } from '../packages/sdk/client.js';
import { fakeAmap, testConnection, type Recorded } from './amap-fixture.js';
import { fixture, principal } from './fixture.js';

async function setup() {
  const f = await fixture(), directory = await mkdtemp(join(tmpdir(), 'eigos-journey-'));
  const start = Math.floor(Date.now() / 60_000) * 60_000;
  const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString();
  const calls: Recorded[] = [], route = { durationSeconds: 25 * 60, condition: '晴' };
  const amap = await testConnection(directory);
  const capabilities = createCapabilities(f.db, f.source, {}, undefined, undefined, { amap, amapFetch: fakeAmap(calls, route) });
  const schedules = new ScheduledActions(f.db, f.metadata);
  const worker = new Worker(f.tasks, f.agent, schedules, new ScheduledActionRunner(f.db, f.metadata, f.tasks, capabilities.actions));
  const token = 'fixture-eigos-journey-'.repeat(3), config = readConfig({
    DATABASE_URL: process.env.EIGOS_TEST_DATABASE_URL, EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token,
    EIGOS_AMAP_CONNECTION_FILE: amap,
  });
  const server = createApp(config, f.db, f.source).app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  assert(addr && typeof addr !== 'string');
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const mcp = new Client({ name: 'calendar-journey-pa', version: '1' });
  const headers = { Authorization: 'Bearer ' + token };
  await mcp.connect(new StreamableHTTPClientTransport(new URL(baseUrl + '/mcp'), { requestInit: { headers } }));
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await mcp.callTool({ name, arguments: args });
    const block = r.content[0] as {text: string};
    if (r.isError) throw new Error(block.text);
    return JSON.parse(block.text);
  };
  const input = {
    origin: { calendarId: 'selected', eventId: 'original-meeting' },
    destination: { calendarId: 'selected', eventId: 'next-meeting' },
    monitorUntil: at(120), mode: 'driving',
  };
  const events = { destinationStart: 75, canceled: false };
  const calendarCalls: string[] = [];
  const readCalendar = googleCalendarJourneyReader(() => 'fixture-calendar-token', async (target, init) => {
    const url = new URL(String(target));
    assert.equal(url.origin, 'https://www.googleapis.com');
    assert.equal(init?.method ?? 'GET', 'GET');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fixture-calendar-token');
    const [id, ...path] = url.pathname.split('/').reverse();
    assert.deepEqual(path, ['events', 'selected', 'calendars', 'v3', 'calendar', '']);
    calendarCalls.push(id!);
    if (id === input.destination.eventId && events.canceled)
      return Response.json({ id, status: 'cancelled' });
    assert(id === input.origin.eventId || id === input.destination.eventId);
    const origin = id === input.origin.eventId, eventStart = origin ? -30 : events.destinationStart;
    return Response.json({
      id, summary: origin ? 'Origin' : 'Destination', location: origin ? '上海第一站' : '上海第二站',
      status: 'confirmed', etag: String(eventStart), start: { dateTime: at(eventStart) }, end: { dateTime: at(origin ? 10 : eventStart + 30) },
    });
  });
  const pa = new CalendarJourneyPA(new OntologyClient({ baseUrl, token }), async (selection, signal) => {
    const contents = await readCalendar(selection, signal);
    return contents.status === 'available' ? { ...contents, evidence: 'synthetic' } : contents;
  });
  return {
    ...f, worker, schedules, calls, route, events, calendarCalls, at, input, call,
    async replaceMapBinding() {
      const contents = JSON.parse(await readFile(amap, 'utf8'));
      await writeFile(amap, JSON.stringify({ ...contents, expiresAt: new Date(Date.now() + 7200000).toISOString() }), { mode: 0o600 });
    },
    startJourney: (requestId = 'calendar-trip') => call('apply_ontology_action',
      {action: 'StartCalendarJourney', requestId, input}) as Promise<ObjectRef>,
    read: async (journey: ObjectRef) => journeyReadResult.parse(
      await call('evaluate_ontology', {function: 'readCalendarJourney', input: {journey}})),
    async pending() {
      assert(await worker.runOne());
      const { items } = await call('list_pa_requests', {});
      assert.equal(items.length, 1);
      assert.equal(items[0].request.capability, 'calendar.journey.read');
      assert.deepEqual(items[0].request.input, { origin: input.origin, destination: input.destination });
      return items[0] as { taskId: string; request: { requestId: string } };
    },
    async makeDue(taskId: string) {
      const result = await f.db.query(`UPDATE ${f.db.schema}.tasks SET available_at=now()-interval '1 second'
        WHERE id=$1 AND state='submitted'`, [taskId]);
      assert.equal(result.rowCount, 1);
    },
    async answer(taskId: string) { await pa.answer(taskId); assert(await worker.runOne()); },
    async close() {
      worker.stop();
      await mcp.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
      await f.close();
    },
  };
}

test('the same PA task advances, replaces, or withdraws its calendar reminder and skips duplicate versions', async () => {
  const f = await setup();
  try {
    const ref = await f.startJourney(), duplicate = await f.startJourney('calendar-trip-again');
    assert.deepEqual(duplicate, ref);
    assert.equal((await f.db.query(`SELECT count(*)::int n FROM ${f.db.schema}.scheduled_actions`)).rows[0]?.n, 1);
    const task = await f.pending();
    assert.equal(f.calls.length, 0);
    await f.answer(task.taskId);
    const first = await f.read(ref);
    assert.equal(first.calendarEvidence, 'synthetic');
    assert.equal(first.reminder?.prepareAt, f.at(35));
    assert.equal(first.reminder?.cause, 'initial');

    const recheck = async () => {
      await f.makeDue(task.taskId);
      const pending = await f.pending();
      assert.equal(pending.taskId, task.taskId);
      await f.answer(pending.taskId);
      return f.read(ref);
    };
    f.route.durationSeconds = 40 * 60;
    const longer = await recheck();
    assert.equal(longer.reminder?.version, 2);
    assert.equal(longer.reminder?.prepareAt, f.at(20));
    assert.equal(longer.reminder?.cause, 'route_estimate_changed');
    assert.deepEqual((await recheck()).reminder, longer.reminder);
    const count = f.calls.filter(c => c.name === 'maps_direction_driving').length;
    assert.equal(count, 3);

    f.route.condition = '小雨';
    const rain = await recheck();
    assert.equal(rain.reminder?.prepareAt, f.at(15));
    assert.equal(rain.reminder?.cause, 'weather_buffer_changed');
    assert.equal(rain.timing?.durationSeconds, 40 * 60);
    assert.equal(rain.timing?.weatherBufferMinutes, 5);

    f.events.destinationStart = 66;
    const moved = await recheck();
    assert.equal(moved.reminder?.version, 4);
    assert.equal(moved.reminder?.prepareAt, f.at(6));
    assert.equal(moved.reminder?.cause, 'calendar_changed');
    assert.equal(moved.state, 'risk');
    assert.equal(moved.reason, 'calendar_conflict');
    const supplierCount = f.calls.length;
    f.events.canceled = true;
    const canceled = await recheck();
    assert.equal(canceled.reminderVersion, 5);
    assert.equal(canceled.reminder, null);
    assert.equal(canceled.state, 'canceled');
    assert.equal(canceled.nextCheckAt, null);
    assert.equal(f.calls.length, supplierCount);
    assert.equal(await f.worker.runOne(), false);

    const logs = await f.call('query_ontology', {
      query: { type: 'ProcessLog', from: { object: ref, link: 'stateLogs' }, orderBy: [{ property: 'timestamp', direction: 'asc' }] },
    });
    assert.deepEqual(logs.items.map((o: {properties: { newState: string }}) => o.properties.newState),
      ['pending', 'scheduled', 'risk', 'canceled']);
    assert.equal(f.calendarCalls.length, 12);
    const inventory = (await f.db.query(`SELECT (SELECT count(*)::int FROM ${f.db.schema}.scenarios) scenarios,
      (SELECT count(*)::int FROM ${f.db.schema}.external_operations) operations`)).rows[0];
    assert.deepEqual(inventory, { scenarios: 0, operations: 0 });
  } finally { await f.close(); }
});

test('the journey withdraws an expired reminder and refuses calendar responses after PA access is revoked', async () => {
  const f = await setup();
  try {
    const ref = await f.startJourney(), first = await f.pending();
    await f.answer(first.taskId);
    assert((await f.read(ref)).reminder);
    const graph = new Objects(f.db, f.model, await Access.load(f.db, principal));
    const before = await graph.read(ref);
    await graph.edit(ref, before.revision, { validUntil: f.at(-1) });
    const expired = await f.read(ref);
    assert.equal(expired.state, 'expired');
    assert.equal(expired.reminder, null);

    await f.makeDue(first.taskId);
    const pending = await f.pending();
    await setGrants(f.db, principal.owner, memberGrants(f.model).filter(g => g.resource !== 'Eigos/source/PACalendar'));
    await assert.rejects(f.call('respond_to_task', {
      taskId: pending.taskId, requestId: pending.request.requestId, response: {status: 'denied'},
    }), /no longer authorized/i);
    assert.equal((await f.db.query(`SELECT response FROM ${f.db.schema}.pa_requests WHERE id=$1`,
      [pending.request.requestId])).rows[0]?.response, null);

    await setGrants(f.db, principal.owner, memberGrants(f.model));
    const history = calendarJourney.parse((await graph.read(ref)).properties);
    await f.call('apply_ontology_action', { action: 'CancelCalendarJourney', requestId: 'stop-trip', input: {journey: ref} });
    const stopped = await f.read(ref);
    assert.equal(stopped.state, 'canceled');
    assert.equal(stopped.reminder, null);
    assert.equal((await f.schedules.inspect(principal, history.scheduleId)).state, 'canceled');
    assert.equal((await f.tasks.get(principal, first.taskId)).state, 'canceled');
    assert.equal(await f.worker.runOne(), false);
  } finally { await f.close(); }
});

test('a changed map account withdraws the reminder and stops repeated calendar reads until reauthorized', async () => {
  const f = await setup();
  try {
    const ref = await f.startJourney(), first = await f.pending();
    await f.answer(first.taskId);
    assert((await f.read(ref)).reminder);
    const supplierCount = f.calls.length;
    await f.replaceMapBinding();
    const changed = await f.read(ref);
    assert.equal(changed.state, 'unavailable');
    assert.equal(changed.reason, 'source_changed');
    assert.equal(changed.reminder, null);
    await f.makeDue(first.taskId);
    assert(await f.worker.runOne());
    assert.equal((await f.read(ref)).state, 'ended');
    assert.equal((await f.call('list_pa_requests', {})).items.length, 0);
    assert.equal(await f.worker.runOne(), false);
    assert.equal(f.calls.length, supplierCount);
    assert.deepEqual(await f.startJourney('corrected-map-source'), ref);
    const second = await f.pending();
    assert.notEqual(second.taskId, first.taskId);
  } finally { await f.close(); }
});
