// Reusable synthetic database created by the actual pre-RollingGo revision.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { JobStore } from '../packages/core/store.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { currentKernelImplementation } from '../packages/ontology/definition-store.js';
import { CURRENT_KERNEL_VERSION } from '../packages/ontology/seed-definition.js';
test('a parent-created v22 database opens and retains active and task-pinned releases with RollingGo disabled', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('./fixtures/history/rollinggo-parent-v22.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(
    fixture.parentRevision,
    'e6ce615ecf84a587ffc493813645bcfa772f6e9f',
  );
  const directory = mkdtempSync(join(tmpdir(), 'rollinggo-v22-open-')),
    path = join(directory, 'tasks.sqlite');
  writeFileSync(
    path,
    gunzipSync(Buffer.from(fixture.sqliteGzipBase64, 'base64')),
  );
  try {
    const store = new JobStore(path);
    try {
      const catalog = createExecutionCatalog({ store });
      assert.equal(
        catalog
          .summaries(fixture.owner)
          .some((c) => c.ref.id === 'hotel.search.query'),
        false,
      );
      assert.deepEqual(store.definitions.active().ref, fixture.release);
      assert.equal(
        store.definitions.resolve(fixture.release).model.ref.version,
        '22',
      );
      const job = store.get(fixture.owner, fixture.taskId);
      assert.deepEqual(job.delegation!.ontologyRelease, fixture.release);
      assert.equal(
        store.ontologyForJob(fixture.owner, job).model.ref.version,
        '22',
      );
      assert.equal(
        store
          .ontologyForJob(fixture.owner, job)
          .read(fixture.owner, { type: 'ServiceRequest', id: job.id })
          .properties.originalGoal,
        'Prepare a synthetic task brief',
      );
      const before = store.definitions.namespace();
      assert.throws(() => store.definitions.installRollingGoReadonly(before.active, before.generation + 1), /changed/);
      const installed = store.definitions.installRollingGoReadonly(before.active, before.generation);
      assert.equal(installed.generation, before.generation + 1);
      assert.equal(store.definitions.active().model.ref.digest, '2c39527a5973ae4b09b402f382ef192d13f1fca0f5cf3424bcd410b8c3c0a127');
      assert.equal(store.definitions.active().model.action('SearchRollingGoHotels').read?.effect, 'read');
      assert.deepEqual(store.definitions.installRollingGoReadonly(installed.active, installed.generation), installed);
      assert.deepEqual(store.get(fixture.owner, fixture.taskId).delegation!.ontologyRelease, fixture.release);
      assert.equal(store.ontologyForJob(fixture.owner, job).model.ref.version, '22');
      assert.equal(store.definitions.legacy().model.ref.version, '15');
      const facts = store.definitions.installBusinessFacts(installed.active, installed.generation);
      assert.equal(store.definitions.active().model.ref.digest, '496938a2cf4a6661acab90171d6c3988c890364dee7d4f62c3575b2e2c70d644');
      assert.deepEqual(store.definitions.installBusinessFacts(facts.active, facts.generation), facts);
      assert.equal(store.ontologyForJob(fixture.owner, job).model.ref.version, '22');
      const personal = store.definitions.installPersonalContext(facts.active, facts.generation);
      assert.deepEqual(store.definitions.installPersonalContext(personal.active, personal.generation), personal);
      const readContract = store.definitions.installSingleReadContract(personal.active, personal.generation);
      assert.equal(store.definitions.active().model.ref.digest, currentKernelImplementation().ref.digest);
      assert.deepEqual(store.definitions.installSingleReadContract(readContract.active, readContract.generation), readContract);
      assert.equal(store.ontologyForJob(fixture.owner, job).model.ref.version, '22');
      assert.equal(CURRENT_KERNEL_VERSION, '26');
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
