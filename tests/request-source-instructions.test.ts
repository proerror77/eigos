import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setup } from './fixtures/paotui-agent.js';
import { owner, principal } from './backend-fixture.js';
import { paotuiInputs, validatePaotuiGoodsName, validatePaotuiRequest } from '../packages/capabilities/paotui-current-inputs.js';
import { groundRequirements } from '../packages/coordinator/requirements.js';
import { readOntologyRequest } from '../packages/ontology/execution-projection.js';
import { restoreOriginalDeliverableInstruction, submissionDeliverableInstructionId } from '../packages/core/request-instructions.js';
import { scheduleTaskRecovery } from '../packages/core/task-recovery.js';
import type { Job } from '../packages/core/domain.js';
import type { Delegation } from '../packages/core/delegation.js';

const goal = '请先读取本人保存的地址并准备配送报价';
const deliverable = '寄送一份文件，重量1公斤，使用普通送。返回报价，不能下单或付款。';
const mass = { id: 'weight', kind: 'quantity', strength: 'hard', expected: { amount: '1', unit: 'kg' } };
function facts(request: ReturnType<typeof readOntologyRequest>) {
  const fields = paotuiInputs(request).fields;
  assert.equal(fields.weightKg!.value, 1); assert.equal(fields.service!.value, 'ordinary'); assert.equal(fields.category!.value, '文件');
  assert.equal(validatePaotuiGoodsName(request, '一份文件'), '一份文件');
  const grounded = groundRequirements(request, JSON.stringify([{ requirement: mass, messageId: submissionDeliverableInstructionId(request.id), quote: '重量1公斤' }]));
  validatePaotuiRequest(grounded);
  assert.equal(grounded.requirements[0]!.provenance.messageId, submissionDeliverableInstructionId(request.id));
}
function legacy(f: ReturnType<typeof setup>): Job {
  // Model the previously persisted omission without changing any existing
  // immutable instruction: only the original submitted field was stored.
  const job = f.b.submit({ goal });
  job.deliverable = deliverable; job.delegation!.request.requestedDeliverable = deliverable;
  scheduleTaskRecovery(job, 'validation_stalled', 'Original submitted field is missing from source instructions', { automatic: false });
  f.store.save(owner, job); return job;
}

test('native submit exposes both original fields to fact extraction, quoted grounding and ontology without inventing a reply', () => {
  const f = setup(); try {
    const input = { service: 'eigos.delegate', goal, deliverable, requestId: randomUUID() };
    const job = f.b.tasks.submit(principal, input), request = readOntologyRequest(f.store.ontology, owner, job.id);
    assert.deepEqual(f.b.tasks.submit(principal, input), job, 'submission retry cannot append a source instruction');
    assert.equal(job.messages.length, 1); assert.equal(request.revision, 1);
    assert.deepEqual(request.messages, [
      { id: input.requestId, text: goal, receivedAt: job.createdAt },
      { id: submissionDeliverableInstructionId(job.id), text: deliverable, receivedAt: job.createdAt },
    ]);
    facts(request);
    const instructions = f.store.ontology.query(owner, { type: 'RequestInstruction' }).items;
    assert.equal(instructions.length, 2); assert.deepEqual(instructions.map(i => i.properties.sequence).sort(), [0, 1]);
    assert.equal(f.calls.length, 0);
  } finally { f.store.close(); }
});

test('a later owner correction supersedes submitted deliverable facts while retaining their exact source', () => {
  const f = setup(); try {
    const job = f.b.submit({ goal, deliverable });
    const amended = f.b.tasks.amend(principal, { taskId: job.id, requestId: randomUUID(), expectedRevision: job.revision!, answer: '重量改为500克' });
    const request = readOntologyRequest(f.store.ontology, owner, job.id), fields = paotuiInputs(request).fields;
    assert.equal(request.messages.length, 3); assert.equal(amended.messages.length, 2);
    assert.equal(fields.weightKg!.value, 0.5); assert.equal(fields.weightKg!.source.messageIndex, 2);
    assert.equal(fields.service!.source.messageId, submissionDeliverableInstructionId(job.id));
    assert.equal(fields.category!.source.messageId, submissionDeliverableInstructionId(job.id));
    assert.equal(validatePaotuiGoodsName(request, '一份文件'), '一份文件');
    assert.equal(request.messages[1]!.text, deliverable);
  } finally { f.store.close(); }
});

test('technical resume restores only omitted original source, preserves the existing immutable instruction and is idempotent', () => {
  const f = setup(); try {
    const job = legacy(f), original = f.store.ontology.query(owner, { type: 'RequestInstruction' }).items[0]!;
    const input = { taskId: job.id, requestId: randomUUID(), expectedRevision: job.revision! };
    const resumed = f.b.tasks.resume(principal, input);
    assert.deepEqual(f.b.tasks.resume(principal, input), resumed);
    assert.equal(resumed.revision, job.revision! + 1); assert.equal(resumed.delegation!.request.revision, 1);
    assert.deepEqual(resumed.messages, job.messages); assert.deepEqual(f.store.ontology.read(owner, original.ref), original);
    const request = readOntologyRequest(f.store.ontology, owner, job.id); facts(request);
    assert.equal(request.messages[1]!.receivedAt, job.createdAt);
    assert.equal(resumed.delegation!.events.filter(e => e.event === 'original_submission_instruction_restored').length, 1);
    scheduleTaskRecovery(resumed, 'worker_timeout', 'Another technical pause', { automatic: false }); f.store.save(owner, resumed);
    const again = f.b.tasks.resume(principal, { taskId: job.id, requestId: randomUUID(), expectedRevision: resumed.revision! });
    assert.equal(again.delegation!.request.messages.length, 2);
    assert.equal(again.delegation!.events.filter(e => e.event === 'original_submission_instruction_restored').length, 1);
    assert.equal(f.store.ontology.query(owner, { type: 'RequestInstruction' }).items.length, 2); assert.equal(f.calls.length, 0);
  } finally { f.store.close(); }
});

test('source omission repair refuses historical execution, later instructions and mismatched original evidence', () => {
  const f = setup(); try {
    const original = legacy(f);
    const changes: [string, (job: Job) => void][] = [
      ['later instruction', j => { j.delegation!.request.messages.push({ id: randomUUID(), text: '重量改为500克', receivedAt: j.updatedAt }); }],
      ['later chat', j => { j.messages.push({ id: randomUUID(), role: 'user', text: '补充说明', at: j.updatedAt }); }],
      ['request revision', j => { j.delegation!.request.revision = 2; }],
      ['goal text', j => { j.delegation!.request.messages[0]!.text = 'changed'; }],
      ['original timestamp', j => { j.delegation!.request.messages[0]!.receivedAt = '2026-01-01T00:00:00.000Z'; }],
      ['different stored field', j => { j.deliverable = 'other'; }],
      ['agent', j => { j.delegation!.agent = {} as NonNullable<Delegation['agent']>; }],
      ['plan', j => { j.delegation!.plan = {} as NonNullable<Delegation['plan']>; }],
      ['agent history', j => { j.delegation!.agentHistory = [{} as NonNullable<Delegation['agent']>]; }],
      ['plan history', j => { j.delegation!.planHistory = [{} as NonNullable<Delegation['plan']>]; }],
      ['resolution', j => { j.delegation!.resolution = {} as NonNullable<Delegation['resolution']>; }],
      ['suspended agent', j => { j.delegation!.suspendedAgent = {} as NonNullable<Delegation['suspendedAgent']>; }],
    ];
    for (const [name, change] of changes) {
      const job = structuredClone(original); change(job); const before = structuredClone(job);
      assert.equal(restoreOriginalDeliverableInstruction(job, false), undefined, name); assert.deepEqual(job, before, name);
    }
    const withIntents = structuredClone(original);
    assert.equal(restoreOriginalDeliverableInstruction(withIntents, true), undefined); assert.deepEqual(withIntents, original);
  } finally { f.store.close(); }
});
