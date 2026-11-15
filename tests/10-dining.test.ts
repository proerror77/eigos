import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AgentDriver } from '../packages/runtime/agent.js';
import type { ObjectRef } from '../packages/ontology/schema.js';
import { Objects } from '../packages/runtime/objects.js';
import { PARequests } from '../packages/runtime/pa.js';
import { Scenarios } from '../packages/runtime/scenarios.js';
import { testConnection, fakeAmap, type Recorded } from './amap-fixture.js';
import { fixture, principal } from './fixture.js';
import { calendarAnswer } from './planning-fixture.js';

const hour = 3600000, dateAt = (offset: number) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short' }).format(new Date(Date.now() + offset * 24 * hour));
const iso = (ms: number) => new Date(ms).toISOString();

test('the Xiaohongshu PA fallback resumes only the original task and labels reported evidence', async () => {
  const f = await fixture({
    model: 'synthetic-note-search',
    async run(_prompt, tools) {
      await tools.get('complete_with_function')!.invoke({
        function: 'searchRestaurantNotes', input: { query: '苏州 大闸蟹', limit: 1 },
      });
    },
  });
  try {
    const task = await f.tasks.submit(principal, { requestId: 'pa-note-search', message: '只读搜索苏州大闸蟹餐厅线索。' });
    await f.worker.runOne();
    const pending = await f.tasks.get(principal, task.id);
    assert.equal(pending.state, 'input-required');
    const request = pending.result as { capability: string; taskId: string; requestId: string };
    assert.equal(request.capability, 'xiaohongshu.notes.search');
    assert.equal(request.taskId, task.id);
    const pa = new PARequests(f.tasks);
    const response = {
      status: 'available', observedAt: iso(Date.now()), evidence: 'synthetic',
      notes: [{ title: '苏州合成蟹庄', url: 'https://www.xiaohongshu.com/explore/synthetic001' }],
    };
    await assert.rejects(pa.respond({ ...principal, owner: 'other' }, task.id, { requestId: request.requestId, response }), /unavailable/);
    await assert.rejects(pa.respond(principal, task.id, { requestId: request.requestId, response: { ...response, evidence: 'provider' } }));
    await pa.respond(principal, task.id, { requestId: request.requestId, response });
    await f.worker.runOne();
    const result = await f.tasks.get(principal, task.id);
    assert.equal(result.state, 'completed', JSON.stringify(result));
    assert.deepEqual(result.result, { ...response, elapsedMs: (result.result as { elapsedMs: number }).elapsedMs,
      execution: (result.result as { execution: unknown }).execution });
  } finally {
    await f.close();
  }
});

test('a dining day trip uses read-only sources and one PA task through reviewed save and readback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eigos-dining-'));
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    const day1 = dateAt(1), day2 = dateAt(2), observations = [dateAt(-3), dateAt(-2)];
    const dayStart = (date: string) => Date.parse(date + 'T09:00:00+08:00');
    const restaurant = '阳澄湖合成验收蟹庄', dish = '大闸蟹', address = '苏州合成验收地址';
    const bounds = { title: '苏州自驾吃蟹（合成验收）', start: iso(dayStart(day1)), end: iso(dayStart(day2) + 9 * hour), timeZone: 'Asia/Shanghai', durationMinutes: 150 };
    const endpoint = 'http://127.0.0.1:18060/mcp', xiaohongshu = join(directory, 'notes.json');
    await writeFile(xiaohongshu, JSON.stringify({ owner: principal.owner, active: true, expiresAt: iso(Date.now() + hour), endpoint }), { mode: 0o600 });
    const searches: string[] = [], reads: Recorded[] = [];
    const fakeNotes: typeof fetch = async (target, init) => {
      assert.equal(String(target), endpoint);
      assert.equal(init?.redirect, 'error');
      if (init?.method === 'GET') return new Response(null, { status: 405 });
      if (init?.method === 'DELETE') return new Response(null, { status: 200 });
      const packet = JSON.parse(String(init?.body));
      if (packet.method.startsWith('notifications/')) return new Response(null, { status: 202 });
      const result = packet.method === 'initialize'
        ? { protocolVersion: packet.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture-xhs', version: '1' } }
        : (() => {
          assert.equal(packet.method, 'tools/call');
          assert.equal(packet.params.name, 'search_feeds');
          searches.push(packet.params.arguments.keyword);
          return { content: [{ type: 'text', text: JSON.stringify({
            feeds: [{ id: 'synthetic001', xsecToken: 'PRIVATE_XHS_TOKEN', noteCard: { displayTitle: restaurant } }],
          }) }] };
        })();
      return Response.json({ jsonrpc: '2.0', id: packet.id, result });
    };
    const driver: AgentDriver = {
      model: 'synthetic-dining-decisions',
      async run(_prompt, tools) {
        const invoke = (tool: string, input: unknown) => tools.get(tool)!.invoke(input),
          read = (name: string, input: unknown) => invoke('evaluate_function', { function: name, input });
        const notes = await read('searchRestaurantNotes', { query: '苏州 阳澄湖 大闸蟹 餐厅' }) as { notes: { title: string; url: string }[] };
        assert.equal(notes.notes[0]!.title, restaurant);
        assert(!JSON.stringify(notes).includes('PRIVATE_XHS_TOKEN'));
        const history = await read('readWeatherHistory', { city: '苏州', startDate: observations[0], endDate: observations[1] }) as { days: { minC: number }[] };
        assert(history.days.some(item => item.minC < 10));
        const forecast = await read('readWeather', { city: '苏州', mode: 'forecast' }) as { days: { date: string; daytime: string }[] };
        const chosen = forecast.days.find(item => item.daytime === '晴')!.date;
        const home = { address: '合成出发点' }, destination = { address };
        const out = await read('estimateMapRoute', { mode: 'driving', origin: home, destination }) as { routes: { durationSeconds: number }[] };
        const back = await read('estimateMapRoute', { mode: 'driving', origin: destination, destination: home }) as typeof out;
        const plan = await invoke('apply_action', { action: 'PrepareSchedulePlan', input: bounds }) as ObjectRef;
        const slots = await read('findScheduleSlots', { plan }) as { slots: { start: string; end: string }[] };
        const slot = slots.slots.find(item => item.start.startsWith(chosen));
        assert(slot);
        const start = iso(Date.parse(slot.start) + out.routes[0]!.durationSeconds * 1000);
        const end = iso(Date.parse(slot.end) - back.routes[0]!.durationSeconds * 1000);
        const proof = await read('readDiningAvailability', { restaurant: notes.notes[0]!.title, address, dish, start, end }) as { requestId: string };
        const scene = await invoke('create_scenario', { requestId: 'dining-proposal', name: '推荐自驾午餐方案' }) as { id: string };
        const stage = (action: string, input: Record<string, unknown>) => invoke('apply_action', { scenarioId: scene.id, action, input: { ...input, plan } });
        const drive = await stage('SaveScheduleActivity', { id: 'outbound', name: '去程自驾', start: slot.start, end: start }) as ObjectRef;
        const meal = await stage('StageDiningActivity', { id: 'meal', name: restaurant, start, end, requestId: proof.requestId, predecessors: [drive] }) as ObjectRef;
        await stage('SaveScheduleActivity', { id: 'inbound', name: '返程自驾', start: end, end: slot.end, predecessors: [meal] });
        await invoke('complete_with_function', { scenarioId: scene.id, function: 'readSchedulePlan', input: { plan } });
      },
    };
    const amap = await testConnection(directory);
    const amapFetch = fakeAmap(reads, { durationSeconds: 1800, forecastCity: '苏州市',
      forecasts: [{ date: day1, dayweather: '小雨', nightweather: '阴', daytemp: '13', nighttemp: '7' },
        { date: day2, dayweather: '晴', nightweather: '多云', daytemp: '15', nighttemp: '6' }] });
    const active = f = await fixture(driver, undefined, undefined, undefined, { amap, amapFetch, xiaohongshu, xiaohongshuFetch: fakeNotes });
    const task = await active.tasks.submit(principal, { requestId: 'suzhou-dining-fixture', message: '想找天气适合的一天自驾去苏州吃大闸蟹。只准备内部计划。' });
    const pa = new PARequests(active.tasks);
    const answer = async (capability: string, reply: () => Record<string, unknown>) => {
      await active.worker.runOne();
      const waiting = await active.tasks.get(principal, task.id);
      assert.equal(waiting.state, 'input-required', JSON.stringify(waiting));
      assert(waiting.result, waiting.error ?? 'Missing pending PA request');
      const request = waiting.result as { taskId: string; requestId: string; capability: string };
      assert.equal(request.taskId, task.id);
      assert.equal(request.capability, capability);
      const response = reply();
      await pa.respond(principal, task.id, { requestId: request.requestId, response });
      return { requestId: request.requestId, response };
    };
    await answer('weather.history', () => ({
      status: 'available', city: '苏州', observedAt: iso(Date.now()), sourceUrl: 'https://example.com/weather',
      evidence: 'synthetic', kind: 'station_observation', complete: false, days: [{ date: observations[0], minC: 6.4 }],
    }));
    await answer('calendar.freebusy', () => ({ ...calendarAnswer(bounds),
      windows: [{ start: iso(dayStart(day1)), end: iso(dayStart(day1) + 4 * hour) },
        { start: iso(dayStart(day2)), end: iso(dayStart(day2) + 4 * hour) }],
      busy: [{ start: iso(dayStart(day1)), end: iso(dayStart(day1) + 4 * hour) }],
    }));
    const diningReply = (ttlMs: number) => {
      const observedAt = Date.now();
      return { status: 'available', observedAt: iso(observedAt), expiresAt: iso(observedAt + ttlMs),
        sourceUrl: 'https://example.com/restaurant/menu', sourceKind: 'restaurant_menu', evidence: 'synthetic' };
    };
    const { requestId: staleId } = await answer('dining.availability', () => diningReply(-1000));
    const { requestId: receiptId, response: supply } = await answer('dining.availability', () => diningReply(hour));
    assert.notEqual(receiptId, staleId);
    await active.worker.runOne();
    const proposal = await active.tasks.get(principal, task.id);
    assert.equal(proposal.state, 'completed', JSON.stringify(proposal));
    const result = proposal.result as { plan: { ref: ObjectRef }; scenarioId: string; activities: { properties: Record<string, unknown> }[] };
    assert.equal(result.activities.length, 3);
    const live = new Objects(active.db, active.model, active.access);
    assert.equal((await live.follow(result.plan.ref, 'activities')).length, 0);
    const review = await new Scenarios(active.db).inspect(active.access, active.model, result.scenarioId);
    const proposalArgs = { plan: result.plan.ref, scenarioId: result.scenarioId, revision: review.revision };
    await active.db.query(`UPDATE ${active.db.schema}.pa_requests SET response=$2 WHERE id=$1`, [receiptId, { ...supply, expiresAt: iso(Date.now() - 1000) }]);
    await assert.rejects(active.capabilities.actions.apply(active.access, active.model, 'CommitSchedulePlan', proposalArgs, 'expired-proof'), /current availability evidence/);
    await active.db.query(`UPDATE ${active.db.schema}.pa_requests SET response=$2 WHERE id=$1`, [receiptId, supply]);
    await active.capabilities.actions.apply(active.access, active.model, 'CommitSchedulePlan', proposalArgs, 'confirm-suzhou-dining');
    const saved = await live.follow(result.plan.ref, 'activities');
    assert.equal(saved.length, 3);
    const meal = saved.find(item => item.properties.name === restaurant)!;
    assert.equal((meal.properties.dining as Record<string, unknown>).requestId, receiptId);
    assert.equal((meal.properties.dining as Record<string, unknown>).taskId, task.id);
    assert.equal((await live.read(result.plan.ref)).properties.state, 'confirmed');
    assert.deepEqual(searches, ['苏州 阳澄湖 大闸蟹 餐厅']);
    assert(reads.some(call => call.name === 'maps_weather'));
    assert(reads.filter(call => call.name === 'maps_direction_driving').length >= 2);
    assert.equal(active.provider.calls.length, 0);
    assert.equal((await active.db.query(`SELECT count(*)::int AS count FROM ${active.db.schema}.external_operations`)).rows[0]!.count, 0);
    assert.equal((await active.db.query(`SELECT count(*)::int AS count FROM ${active.db.schema}.action_effects`)).rows[0]!.count, 0);
  } finally {
    await f?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
