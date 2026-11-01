import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';

const usage = 'Usage: node scripts/business-postgres-preflight.mjs --snapshot /private/business.sqlite --authority /private/authority.json --policy-digest <reviewed-digest>';
let values;
try { ({ values } = parseArgs({ options: { help: { type: 'boolean' }, snapshot: { type: 'string' }, authority: { type: 'string' }, 'policy-digest': { type: 'string' } } })); }
catch { console.error(usage); process.exit(2); }
if (values.help) { console.log(usage); process.exit(0); }
if (!values.snapshot || !isAbsolute(values.snapshot) || !values.authority || !isAbsolute(values.authority) || !/^[a-f0-9]{64}$/.test(values['policy-digest'] ?? '')) { console.error(usage); process.exit(2); }
try {
  const { readRuntimeAuthority, runtimeAuthorityDigest } = await import('../dist/packages/core/runtime-authority.js');
  const { planBusinessSnapshot } = await import('../dist/packages/postgres/business-snapshot.js');
  const authority = readRuntimeAuthority(values.authority);
  const result = planBusinessSnapshot(values.snapshot, runtimeAuthorityDigest(authority), values['policy-digest']);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  // Internal metadata may contain private paths or facts. Report only the
  // audited fail-closed reasons, never raw driver or validation messages.
  const reason = error instanceof Error && /^(Snapshot |Business |A closed|Absolute snapshot|Invalid audit|Unsupported |NULL in required|Generated or hidden|WITHOUT ROWID)/.test(error.message) ? error.message : 'PRECHECK_FAILED';
  console.error(`Business preflight failed: ${reason}`); process.exitCode = 1;
}
