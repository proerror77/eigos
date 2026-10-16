// Local synthetic evidence only; does not load .env, invoke Alipay, or contact a provider.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { JobStore } from '../packages/core/store.js';
import { TaskService } from '../packages/core/tasks.js';
import { SCOPES, type Principal } from '../packages/core/domain.js';
import { PILOT } from '../packages/capabilities/pilot/contracts.js';
import { AuditPilot } from '../packages/capabilities/pilot/service.js';
import { SimulatedProvider } from '../packages/capabilities/pilot/providers.js';
const out = resolve(process.argv[2] ?? 'output/csv-audit-pilot');
mkdirSync(out, { recursive: true });
const p: Principal = { issuer: 'simulation', subject: 'demo', tenant: 'synthetic', clientId: 'demo', scopes: [...SCOPES] };
const summary = [];
for (const fault of ['none', 'bad-once', 'bad-always'] as const) {
  const temp = mkdtempSync(join(tmpdir(), 'eigos-audit-demo-'));
  const store = new JobStore(join(temp, 'demo.sqlite')); let clock = Date.parse('2026-10-15T00:00:00Z');
  try {
    const provider = new SimulatedProvider(store, fault); const pilot = new AuditPilot(store, provider, () => clock);
    const tasks = new TaskService(store, { pilot });
    const task = tasks.submit(p, { service: PILOT, datasetId: 'duplicate-and-missing-v1', goal: '审计合成 CSV', requestId: 'demo' });
    tasks.reply(p, { taskId: task.id, requestId: 'approve', action: 'confirm_simulated_payment', quoteId: task.pilot!.quote.id, quoteDigest: task.pilot!.quoteDigest });
    for (let i = 0; i < 12; i++) { clock += 1000; pilot.tick(); }
    const result = tasks.get(p, task.id); const ledger = provider.query(result.pilot!.orderId)!;
    assert.equal(ledger.charges, 1); assert.equal(result.state, fault === 'bad-always' ? 'failed' : 'completed');
    assert.equal(result.pilot!.remediation, fault === 'bad-always' ? 'refunded' : 'none');
    const dir = join(out, fault); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'trace.json'), JSON.stringify({ environment: 'simulated', task: result, providerLedger: ledger }, null, 2) + '\n');
    if (result.pilot!.files) {
      writeFileSync(join(dir, 'report.json'), result.pilot!.files.json);
      writeFileSync(join(dir, 'report.md'), result.pilot!.files.markdown);
    }
    summary.push({ scenario: fault, task: result.state, payment: result.pilot!.payment, acceptance: result.pilot!.acceptance, remediation: result.pilot!.remediation, charges: ledger.charges, refunds: ledger.refunds });
  } finally { store.close(); rmSync(temp, { recursive: true, force: true }); }
}
writeFileSync(join(out, 'summary.json'), JSON.stringify({ environment: 'simulated', scenarios: summary }, null, 2) + '\n');
console.log(JSON.stringify({ environment: 'simulated', output: out, scenarios: summary }, null, 2));
