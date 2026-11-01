import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGoalContract } from '../packages/core/goal-contract.js';
import { DomainError } from '../packages/core/domain.js';
import { groundRequirements } from '../packages/coordinator/requirements.js';
import type { ServiceCapability, ServiceRequest } from '../packages/ontology/execution.js';

const release = { ontologyId: 'fixture', releaseId: 'fixture-release', digest: '0'.repeat(64) };
const capability: ServiceCapability = {
  ref: { id: 'fixture.read', version: '1' }, ontologyRef: { id: 'fixture', version: '1' },
  name: 'Synthetic read', description: 'Pure contract validation', tags: [], inputSchema: {}, ontology: {}, actions: [],
  predicates: [], verifierRef: { id: 'fixture.read', version: '1' },
  requirementRoles: [{ kind: 'location', role: 'origin', description: 'Origin' }],
  goalOutcomes: [{ predicate: 'fixture.quote', phase: 'quote', description: 'Read result' }],
};

function fixture() {
  const at = '2026-01-01T00:00:00Z', original = 'Read the public origin without placing an order', correction = 'Use the confirmed public origin';
  const request: ServiceRequest = {
    id: 'fixture-task', revision: 2, originalGoal: original,
    messages: [{ id: 'original', text: original, receivedAt: at }, { id: 'correction', text: correction, receivedAt: at }],
    requirements: [
      { id: 'route_origin', kind: 'location', role: 'origin', strength: 'hard', expected: { ref: 'public origin' }, provenance: { source: 'pa', interpretation: 'structured', messageId: 'original', receivedAt: at } },
      { id: 'read_only', kind: 'condition', strength: 'hard', expected: { predicate: 'fixture.read_only' }, provenance: { source: 'pa', interpretation: 'structured', messageId: 'original', receivedAt: at } },
    ],
  };
  const grounded = groundRequirements(request, JSON.stringify([{ requirement: {
    id: 'confirmed_origin', kind: 'location', role: 'origin', strength: 'hard', expected: { ref: 'confirmed public origin' },
  }, messageId: 'correction', quote: 'confirmed public origin' }]), [], capability.requirementRoles);
  const criterion = { id: 'route', description: 'Confirmed read-only route', predicate: 'fixture.quote', phase: 'quote' as const,
    messageId: 'correction', quote: correction, requirementIds: ['route_origin', 'read_only'] };
  return { grounded, criterion };
}

test('goal-contract feedback names the effective stable IDs after a same-role correction', () => {
  const { grounded, criterion } = fixture(), before = structuredClone(grounded);
  assert.deepEqual(grounded.requirements.map(r => r.id), ['read_only', 'route_origin']);
  assert.throws(() => createGoalContract(grounded, release, [{ ...criterion, requirementIds: ['confirmed_origin', 'read_only'] }], [capability]), (error: unknown) => {
    assert(error instanceof DomainError);
    assert.match(error.message, /^Goal criterion references an unknown or repeated requirement:/);
    const details = JSON.parse(error.message.slice(error.message.indexOf(':') + 1));
    assert.deepEqual(details, { criterionId: 'route', unknownRequirementIds: ['confirmed_origin'], repeatedRequirementIds: [], availableRequirementIds: ['read_only', 'route_origin'] });
    assert(!error.message.includes('confirmed public origin'), 'Feedback contains identifiers, not private requirement values');
    return true;
  });
  assert.deepEqual(grounded, before, 'Validation feedback cannot rewrite the caller contract');
  const valid = createGoalContract(grounded, release, [criterion], [capability]);
  assert.deepEqual(valid.criteria[0]!.requirementIds, ['route_origin', 'read_only']);
});

test('precise requirement feedback still rejects duplicates and omitted hard requirements', () => {
  const { grounded, criterion } = fixture();
  assert.throws(() => createGoalContract(grounded, release, [{ ...criterion, requirementIds: ['route_origin', 'route_origin', 'read_only'] }], [capability]), (error: unknown) => {
    assert(error instanceof DomainError);
    const details = JSON.parse(error.message.slice(error.message.indexOf(':') + 1));
    assert.deepEqual(details.repeatedRequirementIds, ['route_origin']);
    assert.deepEqual(details.unknownRequirementIds, []);
    return true;
  });
  assert.throws(() => createGoalContract(grounded, release, [{ ...criterion, requirementIds: ['route_origin'] }], [capability]), /Every fixed hard requirement/);
});
