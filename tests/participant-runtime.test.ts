import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readParticipantRuntime, participantDeploymentSettings } from '../packages/capabilities/free-booking/runtime-config.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-participant-runtime-'));
  const taskDatabasePath = join(directory, 'tasks.sqlite'), file = join(directory, 'browser.json');
  const config = { port: 3443, bindingId: 'synthetic-owned-account', attendeeRef: 'a'.repeat(64), taskDatabasePath, databasePath: join(directory, 'queue.sqlite'), evidenceDirectory: join(directory, 'evidence'), workerTokenFile: join(directory, 'worker-token'), operatorTokenFile: join(directory, 'operator-token') };
  for (const path of [config.workerTokenFile, config.operatorTokenFile]) writeFileSync(path, randomBytes(32).toString('hex'), { mode: 0o600 });
  writeFileSync(file, JSON.stringify(config));
  return { directory, taskDatabasePath, file, config, close: () => rmSync(directory, { recursive: true, force: true }) };
}
test('resident updates retain the exact participant account, private credentials and original task database', () => {
  const f = fixture(); try {
    const first = participantDeploymentSettings({ EIGOS_FREE_BOOKING_BROWSER_CONFIG: f.file }, {}, f.taskDatabasePath);
    assert.equal(first.EIGOS_FREE_BOOKING_BRIDGE_URL, 'http://127.0.0.1:3443');
    assert.equal(first.EIGOS_FREE_BOOKING_TOKEN_FILE, f.config.workerTokenFile);
    assert.equal(first.EIGOS_FREE_BOOKING_ATTENDEE_SHA256, f.config.attendeeRef);
    assert.deepEqual(participantDeploymentSettings({}, first, f.taskDatabasePath), first);
    assert.deepEqual(participantDeploymentSettings({ EIGOS_FREE_BOOKING_BRIDGE_URL: '' }, first, f.taskDatabasePath), {});
    assert.throws(() => participantDeploymentSettings({ EIGOS_FREE_BOOKING_ATTENDEE_SHA256: 'b'.repeat(64) }, first, f.taskDatabasePath), /binding differs/);
    assert.throws(() => participantDeploymentSettings({}, first, join(f.directory, 'another.sqlite')), /resident task database/);
  } finally { f.close(); }
});
test('incomplete, remote and conflicting managed source settings fail before a resident restart', () => {
  const f = fixture(); try {
    assert.deepEqual(participantDeploymentSettings({}, {}, f.taskDatabasePath), {});
    assert.throws(() => participantDeploymentSettings({ EIGOS_FREE_BOOKING_BRIDGE_URL: 'http://127.0.0.1:3443' }, {}, f.taskDatabasePath));
    const source = participantDeploymentSettings({ EIGOS_FREE_BOOKING_BROWSER_CONFIG: f.file }, {}, f.taskDatabasePath);
    delete source.EIGOS_FREE_BOOKING_BROWSER_CONFIG;
    assert.deepEqual(participantDeploymentSettings({}, source, f.taskDatabasePath), source);
    assert.throws(() => participantDeploymentSettings({ ...source, EIGOS_FREE_BOOKING_BRIDGE_URL: 'https://example.com' }, {}, f.taskDatabasePath));
    writeFileSync(f.config.operatorTokenFile, 'invalid');
    assert.throws(() => participantDeploymentSettings({ EIGOS_FREE_BOOKING_BROWSER_CONFIG: f.file }, {}, f.taskDatabasePath), /credentials/);
    writeFileSync(f.file, JSON.stringify({ ...f.config, databasePath: f.taskDatabasePath }));
    assert.throws(() => readParticipantRuntime(f.file, f.taskDatabasePath), /separate source queue/);
  } finally { f.close(); }
});
