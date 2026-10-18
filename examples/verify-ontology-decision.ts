// Real model investigation and decision proposal against isolated synthetic data.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import { CodexExecutor, type RunEvidence } from '../packages/capabilities/executor.js';
import { OntologyPlanningSession } from '../packages/coordinator/planning-session.js';
import { reasonWithOntology } from '../packages/coordinator/reasoning-loop.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import { objectRefSchema } from '../packages/ontology/model.js';
import type { DecisionActionProposal } from '../packages/ontology/planning-contract.js';
import { digest } from '../packages/core/delegation.js';
import { drillCase } from '../tests/fixtures/ontology-drill.js';

if (!process.argv.includes('--live')) throw new Error('Pass --live to authorize real model verification');
const output = resolve(process.argv.find(a => a.startsWith('--output='))?.slice(9) ?? 'data/ontology-n2-decision-run');
mkdirSync(output, { recursive: true, mode: 0o700 });
const data = drillCase('QG-1'), db = new DatabaseSync(':memory:'), graph = new OntologyObjectStore(db, undefined, () => data.now);
data.request.originalGoal = '明确的合成数据评审：根据以下原始约束选择一份供进一步评审的报价，用系统支持的业务决策提案表达选择，保留角色身份及执行许可的未知项。只做比较和提案，不要求或声称真实购买、交付。原始约束：' + data.request.originalGoal;
data.batch.objects.find(o => o.ref.type === 'ServiceRequest' && o.ref.id === data.request.id)!.properties.originalGoal = data.request.originalGoal;
graph.ingest('synthetic-review', data.batch, data.source);
const session = new OntologyPlanningSession(graph, 'synthetic-review', data.request), call = session.call.bind(session);
const queries: { tool: string; input: unknown; output: unknown }[] = [], receipts: RunEvidence[] = [];
session.call = (tool, input) => { const output = call(tool, input); queries.push({ tool, input, output }); return output; };
const finalSchema = z.object({ decision: z.enum(['proposed', 'insufficient_evidence']), selectedOffer: objectRefSchema.nullable(), summary: z.string().min(1).max(6000) }).strict();
const before = graph.revision('synthetic-review');
let result: unknown, failure: string | undefined;
try {
  console.log(JSON.stringify({ scope: 'real-model-synthetic-proposal-only', asOf: data.asOf, state: 'started' }));
  const response = await reasonWithOntology(new CodexExecutor(process.env.EIGOS_CODEX_BIN ?? 'codex', 120000),
    `You are independently reviewing the owned synthetic request. Use the available definitions, object queries, relationships and functions to investigate it. If a candidate satisfies the fixed comparison constraints, express its selection through an applicable registered decision proposal. Inspect its returned changes and submission checks, and explain remaining limitations. This is a proposal-only exercise at ${data.asOf}; no operation may execute and no synthetic fact may be claimed as real supply, payment or fulfillment.`,
    z.toJSONSchema(finalSchema), session, new AbortController().signal, evidence => { receipts.push(evidence); });
  result = finalSchema.parse(response.output);
  const final = result as z.infer<typeof finalSchema>;
  assert.equal(final.decision, 'proposed'); assert(final.selectedOffer);
  const proposals = queries.filter(q => q.tool === 'propose_action' && (q.output as DecisionActionProposal).execution === 'proposal_only').map(q => q.output as DecisionActionProposal);
  const selected = proposals.find(p => digest(p.inputs.offer?.object) === digest(final.selectedOffer));
  assert(selected); assert.equal(selected.action, 'SelectOffer'); assert(selected.checks.every(c => c.result === 'pass'));
  assert.equal(selected.executionAllowed, false); assert.equal(graph.revision('synthetic-review'), before);
  assert(receipts.every(r => r.runtime === 'codex-exec' && r.threadId));
  console.log(JSON.stringify({ state: 'proposal_validated', modelRuns: receipts.length, reads: queries.length, action: selected.action, executionAllowed: selected.executionAllowed, selectedOffer: final.selectedOffer }));
} catch (error) { failure = error instanceof Error ? error.message : String(error); throw error; }
finally {
  writeFileSync(join(output, 'verification.json'), JSON.stringify({ scope: 'Real model, synthetic data, decision proposal only; no graph mutation or external effect', asOf: data.asOf, datasetDigest: digest(data.batch), model: graph.model.ref, result, failure, receipts, queries, beforeRevision: before, afterRevision: graph.revision('synthetic-review') }, null, 2), { mode: 0o600 });
  db.close();
}
