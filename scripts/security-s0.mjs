import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildSecurityInventory } from '../packages/security/inventory.ts';
import { auditMigrationSnapshots } from '../packages/security/migration-audit.ts';

// Explicit snapshots only. Never reads .env, opens the resident DB by default,
// instantiates stores, alters schema, or enables the future permission system.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  const { values } = parseArgs({ options: { check: { type: 'boolean' }, output: { type: 'string' },
    'database-snapshot': { type: 'string' }, 'membership-snapshot': { type: 'string' } } });
  if (values['membership-snapshot'] && !values['database-snapshot']) throw new Error('Membership snapshot requires a task snapshot');
  const inventory = buildSecurityInventory(JSON.parse(readFileSync(resolve(root, 'packages/security/baseline.json'), 'utf8')), undefined, root);
  if (!inventory.passed) {
    console.error(JSON.stringify({ stage: 'S0', passed: false, issues: inventory.issues })); process.exitCode = 1;
  } else {
    const migration = values['database-snapshot'] ? auditMigrationSnapshots(values['database-snapshot'], values['membership-snapshot']) : undefined;
    const report = { inventory, ...(migration ? { migration } : {}) };
    if (values.output) writeFileSync(values.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ stage: 'S0', passed: true, enforcement: 'not_installed', counts: inventory.counts,
      snapshotInspected: !!migration, ...(migration ? { taskCount: migration.tasks.total, objectCount: migration.objects.total, migrationReady: false } : {}) }));
  }
} catch {
  // Snapshot paths, SQL/JSON errors and raw record contents can contain private data.
  console.error('S0 audit failed. Check explicit snapshot schemas, limits and output path; no migration or grants were applied.');
  process.exitCode = 1;
}
