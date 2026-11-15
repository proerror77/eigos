import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { createApp } from '../apps/gateway/app.js';
import { configSchema } from '../packages/core/config.js';
import { digest } from '../packages/core/identity.js';
import {
  diningMiniProgramCapabilities as capabilities, diningReservationData,
} from '../packages/ontology/dining-reservations.js';
import type { ObjectRef } from '../packages/ontology/schema.js';
import { Objects } from '../packages/runtime/objects.js';
import { androidDiningMiniProgram, androidDiningReader, readDiningMiniProgramScreen } from '../packages/sdk/android-dining-miniprogram.js';
import { readDiningVisionScreen } from '../packages/sdk/android-dining-vision.js';
import { OntologyClient } from '../packages/sdk/client.js';
import { DiningMiniProgramPA } from '../packages/sdk/dining-miniprogram-pa.js';
import { fixture, principal } from './fixture.js';
import { startDiningTestMerchant } from './dining-web-fixture.js';

const miniProgram = { name: 'Dining Fixture', publisher: 'Synthetic test merchant', timeZone: 'Asia/Shanghai' };
const query = {
  restaurant: 'Dining Fixture', city: 'Shanghai', branch: 'Fixture Branch', partySize: 2,
  date: new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeZone: miniProgram.timeZone })
    .format(new Date(Date.now() + 86400000)),
};
const terms = { ...query, time: '19:00' };
const slotScreen = `<hierarchy rotation="0">
  <node package="com.tencent.mm" resource-id="identity" text="Dining Fixture"/>
  <node package="com.tencent.mm" resource-id="branch" content-desc="Fixture Branch"/>
  <node package="com.tencent.mm" resource-id="date" text="${query.date}"/>
  <node package="com.tencent.mm" resource-id="party" text="2人"/>
  <node package="com.tencent.mm" resource-id="slots">
    <node package="com.tencent.mm" text="19:00" enabled="true" clickable="true"/>
    <node package="com.tencent.mm" text="19:15" enabled="false" clickable="true"/>
  </node>
  <node package="com.android.systemui" text="22:00" enabled="true" clickable="true"/>
</hierarchy>`;
const screen = {
  identity: { id: 'identity', text: miniProgram.name }, branch: { id: 'branch' }, date: { id: 'date' },
  guests: { id: 'party' }, slots: { id: 'slots' }, noSlots: { text: 'No times available' },
};

test('the Android reader requires the exact visible branch, date, and party before claiming available times', () => {
  const config = androidDiningMiniProgram.parse({ adb: '/fake/adb', serial: 'fixture', androidUser: 0, miniProgram, screen });
  const input = { ...query, miniProgram };
  assert.deepEqual(readDiningMiniProgramScreen(slotScreen, config, input), ['19:00']);
  assert.equal(readDiningMiniProgramScreen(slotScreen, config, { ...input, branch: 'Different Branch' }), undefined);
  const full = slotScreen.replace('<node package="com.tencent.mm" text="19:00" enabled="true" clickable="true"/>',
    '<node package="com.tencent.mm" text="No times available"/>');
  assert.deepEqual(readDiningMiniProgramScreen(full, config, input), []);
  assert.equal(readDiningMiniProgramScreen(full.replace('No times available', 'Loading'), config, input), undefined);
});

test('the screenshot reader matches booking buttons to the queried branch and exact guest count', () => {
  const dateLabel = '11月20日';
  const config = { executable: '/fake/vision', programLabel: '搜索测试门店', branchPrefix: 'Fixture', bookingLabel: '立即预订' };
  const input = { ...query, city: '测试市', miniProgram, date: '2026-11-20' };
  const line = (text: string, x: number, y: number) => ({ text, x, y });
  const lines = [
    line('测试市｜搜索测试门店', 0.31, 0.08), line(`${dateLabel}星期五｜2人大厅`, 0.28, 0.22),
    line('Fixture Branch', 0.34, 0.33), line('19:00', 0.18, 0.41), line('立即预订', 0.18, 0.45),
    line('19:30', 0.41, 0.41), line('约满', 0.41, 0.45),
    line('Fixture Other Branch', 0.34, 0.52), line('19:45', 0.18, 0.59), line('立即预订', 0.18, 0.63),
  ];
  assert.deepEqual(readDiningVisionScreen(lines, config, input, dateLabel), ['19:00']);
  assert.equal(readDiningVisionScreen(lines, config, { ...input, partySize: 12 }, dateLabel), undefined);
  assert.equal(readDiningVisionScreen(lines, config, input, '11月21日'), undefined);
});

test('the original PA reads mini-program availability and recovers one synthetic reservation across a lost reply and replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eigos-miniprogram-test-'));
  const merchant = await startDiningTestMerchant(true);
  const diningMiniProgram = join(directory, 'connection.json'), adb = join(directory, 'adb');
  const testId = digest('synthetic mini program');
  let f: Awaited<ReturnType<typeof fixture>> | undefined, gateway: Server | undefined;
  let reservation: ObjectRef;
  try {
    await writeFile(diningMiniProgram, JSON.stringify({
      owner: principal.owner, restaurant: query.restaurant, city: query.city, branch: query.branch, miniProgram, testId,
    }), { mode: 0o600 });
    // This fixture exposes the Android CLI and accessibility tree without a WeChat account.
    await writeFile(adb, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] !== '-s' || args[1] !== 'fixture') process.exit(2);
const command = args.slice(2).join(' ');
if (command === 'shell am get-current-user') console.log('0');
else if (command === 'shell dumpsys activity activities') console.log('topResumedActivity=ActivityRecord{ u0 com.tencent.mm/.plugin.appbrand.ui.AppBrandUI1 t1}');
else if (command.startsWith('exec-out cat /data/local/tmp/eigos-dining-')) console.log(${JSON.stringify(slotScreen)});
else if (!command.startsWith('shell uiautomator dump /data/local/tmp/eigos-dining-') &&
         !command.startsWith('shell rm /data/local/tmp/eigos-dining-')) process.exit(2);
`, { mode: 0o700 });
    f = await fixture({
      model: 'synthetic-mini-program-agent',
      async run(prompt, tools) {
        if (prompt.includes('inspect mini-program slots')) {
          await tools.get('complete_with_function')!.invoke({ function: 'readDiningMiniProgramAvailability', input: query });
        } else {
          await tools.get('apply_action')!.invoke({ action: 'SubmitDiningTestReservation', input: { reservation } });
          await tools.get('complete_with_function')!.invoke({ function: 'readDiningReservation', input: { reservation } });
        }
      },
    }, undefined, undefined, undefined, { diningMiniProgram });
    const active = f;
    const token = randomUUID() + randomUUID();
    const { app } = createApp(configSchema.parse({
      DATABASE_URL: process.env.EIGOS_TEST_DATABASE_URL, EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token,
      PUBLIC_URL: 'http://127.0.0.1', EIGOS_DINING_MINIPROGRAM_CONNECTION_FILE: diningMiniProgram,
    }), active.db, active.source);
    const server = gateway = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => server.once('listening', resolve).once('error', reject));
    const client = new OntologyClient({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token });
    const options = {
      ontology: client,
      readAvailability: androidDiningReader(androidDiningMiniProgram.parse({ adb, serial: 'fixture', androidUser: 0, miniProgram, screen })),
      sandbox: { id: testId, origin: merchant.origin, privateDirectory: join(directory, 'journal'), timeZone: miniProgram.timeZone },
    };
    const pa = new DiningMiniProgramPA(options);
    const create = (message: string) => active.tasks.submit(principal, { requestId: randomUUID(), message });
    const next = async (taskId: string, capability: string) => {
      assert(await active.worker.runOne());
      const task = await active.tasks.get(principal, taskId);
      assert.equal(task.state, 'input-required', JSON.stringify(task));
      const request = z.object({ capability: z.string(), taskId: z.uuid() }).parse(task.result);
      assert.equal(request.capability, capability);
      assert.equal(request.taskId, taskId);
    };
    const finish = async (taskId: string) => {
      assert(await active.worker.runOne());
      const task = await active.tasks.get(principal, taskId);
      assert.equal(task.state, 'completed', JSON.stringify(task));
      return z.record(z.string(), z.unknown()).parse(task.result);
    };
    const inquiry = await create('inspect mini-program slots');
    await next(inquiry.id, capabilities.availability);
    await pa.answer(inquiry.id);
    const observation = await finish(inquiry.id);
    assert.deepEqual(observation.availableTimes, ['19:00']);
    assert.equal(observation.evidence, 'pa_reported');
    assert.equal(merchant.submissions, 0);

    reservation = await active.capabilities.actions.apply(active.access, active.model,
      'PrepareDiningMiniProgramTestReservation', terms, 'prepare-mini');
    const submit = await create('submit the synthetic mini-program order');
    await next(submit.id, capabilities.submitTest);
    const lost = new DiningMiniProgramPA({ ...options, ontology: {
      request: async <T>(path: string, payload?: unknown, signal?: AbortSignal) => {
        if (path.endsWith('/pa-response')) throw new Error('Synthetic PA acknowledgement lost');
        return client.request<T>(path, payload, signal);
      },
    } });
    await assert.rejects(lost.answer(submit.id), /acknowledgement lost/);
    assert.equal(merchant.submissions, 1);
    assert.equal(merchant.lostReplies, 1);

    // The restarted PA has the original local claim. It answers the waiting task without another submit.
    await new DiningMiniProgramPA(options).answer(submit.id);
    await next(submit.id, capabilities.lookupTest);
    merchant.flags.mismatched = true;
    await pa.answer(submit.id);
    assert.equal((await finish(submit.id)).state, 'unknown');

    // A different EIGOS task may read back the same reservation through the PA.
    merchant.flags.mismatched = false;
    const replay = await create('retry the same synthetic mini-program order');
    await next(replay.id, capabilities.lookupTest);
    await pa.answer(replay.id);
    assert.equal((await finish(replay.id)).state, 'confirmed');
    const objects = new Objects(active.db, active.model, active.access);
    const confirmed = diningReservationData.parse((await objects.read(reservation)).properties);
    assert.equal(confirmed.channel, 'miniprogram');
    assert.equal(confirmed.receipt?.bookingId, merchant.orders[0]?.bookingId);
    assert.equal(confirmed.receipt?.reference, reservation.id);
    assert.equal(confirmed.receipt?.verifiedBy, 'original-order-lookup');
    assert.equal(merchant.submissions, 1);
    assert.equal(merchant.orders.length, 1);
    assert.deepEqual(merchant.lookups, [reservation.id, reservation.id]);
    const dispatch = await active.db.query(`SELECT state,task_id FROM ${active.schema}.external_operations WHERE operation_key=$1`, [reservation.id]);
    assert.deepEqual(dispatch.rows, [{ state: 'confirmed', task_id: submit.id }]);
  } finally {
    if (gateway) await new Promise<void>(resolve => gateway!.close(() => resolve()));
    await f?.close();
    await merchant.close();
    await rm(directory, { recursive: true, force: true });
  }
});
