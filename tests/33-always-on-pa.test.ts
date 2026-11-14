import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Worker } from '../apps/worker/worker.js';
import { createCapabilities } from '../packages/capabilities/index.js';
import { Access } from '../packages/runtime/access.js';
import { ScheduledActions, ScheduledActionRunner } from '../packages/runtime/scheduled-actions.js';
import { fakeAmap, testConnection } from './amap-fixture.js';
import { fixture, principal } from './fixture.js';

async function eventually(predicate: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return;
    await delay(50);
  }
  assert.fail('Server worker did not process the queued action');
}

test('remote EIGOS processes a due journey while a model task is busy and delivers only its current typed notice', async () => {
  const f = await fixture(), folder = await mkdtemp(join(tmpdir(), 'eigos-travel-pa-'));
  let finish!: () => void, markStarted!: () => void;
  const interactive = new Promise<void>(resolve => { finish = resolve; });
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  let running: Promise<void> | undefined;
  let worker: Worker | undefined;
  try {
    const calendar = join(folder, 'calendar.json'), travelPA = join(folder, 'recipient.json'), keyFile = join(folder, 'recipient.key');
    await writeFile(calendar, JSON.stringify({ owner: principal.owner, calendarIds: ['selected'], clientId: 'test-client',
      clientSecret: 'test-secret', refreshToken: 'test-refresh' }), {mode:0o600});
    await writeFile(keyFile, 'test-credential-00000000', {mode:0o600});
    await writeFile(travelPA, JSON.stringify({ owner: principal.owner, keyFile,
      endpoint: 'https://api2.cursor.sh/automations/webhook/0e5eaab2-4dc9-4a1e-b2e5-74ff95c08c52' }), {mode:0o600});

    const at = (minutes: number) => new Date(Date.now() + minutes * 60000).toISOString();
    const input = { origin: {calendarId:'selected',eventId:'origin'}, destination: {calendarId:'selected',eventId:'destination'},
      mode:'driving', monitorUntil: at(120) };
    let cancelled = false, destinationIn = 60, tokenCalls = 0, eventReads = 0, lost = false;
    const posted: { headers: Headers; body: Record<string, any> }[] = [];
    const capabilities = createCapabilities(f.db, f.source, {}, undefined, undefined, {
      amap: await testConnection(folder), amapFetch: fakeAmap([], {durationSeconds:1500, condition:'晴'}),
      calendar, calendarFetch: async (target, init) => {
        const url = new URL(String(target));
        if (url.origin === 'https://oauth2.googleapis.com') {
          tokenCalls++;
          assert.equal(init?.method, 'POST');
          assert.equal(new URLSearchParams(String(init?.body)).get('scope'), 'https://www.googleapis.com/auth/calendar.events.readonly');
          return Response.json({access_token:'synthetic-read-only-token',expires_in:3600,scope:'https://www.googleapis.com/auth/calendar.events.readonly'});
        }
        eventReads++;
        assert.equal(url.origin,'https://www.googleapis.com');
        assert(!init?.method || init.method === 'GET');
        const id = url.pathname.split('/').at(-1);
        assert(id === 'origin' || id === 'destination');
        if (id === 'destination' && cancelled) return Response.json({id,status:'cancelled'});
        const start = id === 'origin' ? -60 : destinationIn;
        return Response.json({ id, etag:'source-revision',status:'confirmed',summary:'Private title must not be sent',
          location: id === 'origin' ? '上海出发地点' : '上海到达地点',
          start:{dateTime:at(start)},end:{dateTime:at(start+20)} });
      },
      travelPA, travelPAFetch: async (target, init) => {
        assert.match(String(target), /^https:\/\/api2\.cursor\.sh\/automations\/webhook\//);
        posted.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
        if (lost) throw new Error('Network reset after dispatch');
        return Response.json({success:true,runUuid:'8e690fdf-c2c8-4ff4-b930-a889c63c181a'});
      },
    });
    const schedules = new ScheduledActions(f.db, f.metadata);
    const runner = new ScheduledActionRunner(f.db, f.metadata, f.tasks, capabilities.actions);
    worker = new Worker(f.tasks, { run: async () => { markStarted(); await interactive; return { done: true }; } }, schedules, runner);
    const access = () => Access.load(f.db, principal);
    const apply = async (action: string, args: Record<string, unknown>, id: string) =>
      capabilities.actions.apply(await access(), f.model, action, args, id);
    const firstInteractive = await f.tasks.submit(principal,{requestId:'interactive',message:'Interactive model task'});
    running = worker.run();
    await Promise.race([started, delay(5000, undefined, {ref:false}).then(() => assert.fail('Interactive worker did not start'))]);
    const ref = await apply('StartCalendarJourney', input, 'bounded-journey');

    const effectStatus = async () => (await f.db.query('SELECT id,state,payload FROM ' + f.schema + '.action_effects ORDER BY created_at')).rows;
    const checked = (step: number) => eventually(async () => (await f.db.query(
      "SELECT 1 FROM " + f.schema + ".tasks WHERE input ? 'scheduledAction' AND execution_step=$1 AND state='submitted'",[step])).rowCount === 1);
    const makeDue = async () => {
      const recheck = await f.db.query("UPDATE " + f.schema + ".tasks SET available_at=now()-interval '1 second' WHERE input ? 'scheduledAction' AND state='submitted'");
      assert.equal(recheck.rowCount,1);
    };
    await checked(1);
    assert.equal((await f.tasks.get(principal, firstInteractive.id)).state,'working');
    assert.equal((await f.db.query('SELECT 1 FROM ' + f.schema + '.pa_requests')).rowCount,0);
    assert.equal(tokenCalls,1);
    assert.equal(eventReads,2);
    assert.equal((await effectStatus()).length,0);
    assert.equal(posted.length,0);

    destinationIn = 37;
    await makeDue();
    await eventually(async () => (await effectStatus()).length === 1);
    const saved = (await effectStatus())[0]!;
    assert.equal(saved.payload.object.type,'CalendarJourney');
    await capabilities.effects.runOne();
    assert.equal(posted.length,1);
    assert.deepEqual(posted[0]!.body.object,ref);
    assert.equal(posted[0]!.body.version,2);
    assert.equal(posted[0]!.body.operation,'update');
    assert.match(posted[0]!.body.text,/该准备出发/);
    assert.equal(posted[0]!.headers.get('Idempotency-Key'),saved.id);
    assert(!JSON.stringify(posted[0]!.body).includes('Private title'));
    assert(!JSON.stringify(posted[0]!.body).includes('@'));
    assert.equal((await effectStatus())[0]!.state,'completed');
    const receipt = (await f.db.query('SELECT state,result FROM ' + f.schema + '.external_operations WHERE operation_key=$1',[saved.id])).rows[0]!;
    assert.equal(receipt.state,'confirmed');
    assert.equal(receipt.result.runId,'8e690fdf-c2c8-4ff4-b930-a889c63c181a');
    assert(Number.isFinite(Date.parse(receipt.result.acceptedAt)));

    // A later appointment returns the timer to EIGOS and withdraws the former due notice.
    destinationIn = 60;
    await checked(2);
    await makeDue();
    await eventually(async () => (await effectStatus()).length === 2);
    await capabilities.effects.runOne();
    assert.equal(posted[1]!.body.operation,'withdraw');
    assert.equal(posted[1]!.body.version,3);
    assert.equal(posted[1]!.body.calendar.reminder,null);

    // Cancel after a new update was queued, before the PA received it.
    destinationIn = 37;
    await checked(3);
    await makeDue();
    await eventually(async () => (await effectStatus()).length === 3);
    cancelled = true;
    await checked(4);
    await makeDue();
    await eventually(async () => (await effectStatus()).length === 4);
    await capabilities.effects.runOne();
    assert.equal(posted.length,2);
    assert.equal((await effectStatus())[2]!.state,'canceled');
    lost = true;
    await capabilities.effects.runOne();
    assert.equal(posted[2]!.body.operation,'withdraw');
    assert.equal(posted[2]!.body.version,5);
    assert.equal(posted[2]!.body.calendar.reminder,null);
    const failed = (await effectStatus())[3]!;
    assert.equal(failed.state,'failed');
    await capabilities.effects.retry(await access(),failed.id);
    await capabilities.effects.runOne();
    assert.equal(posted.length,3);
    assert.equal((await effectStatus())[3]!.state,'failed');
    assert.equal(eventReads,10);
    finish();
    await eventually(async () => (await f.tasks.get(principal, firstInteractive.id)).state === 'completed');
  } finally {
    finish();
    worker?.stop();
    await running;
    await rm(folder,{recursive:true,force:true});
    await f.close();
  }
});
