import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { serviceDrillDatasets, SERVICE_DRILL_QUESTIONS } from './fixtures/service-domain-drill.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import { serviceDomain } from '../packages/ontology/service-domains.js';
import type { DomainAssessment } from '../packages/ontology/domain-rules.js';

// Maintainer checks only. The drill protocol forbids participants from reading tests or expected answers.
test('eighteen frozen business drills contain the intended successes, failures and unresolved outcomes', () => {
  const now = Date.parse('2026-10-18T08:00:00Z');
  const expected = ['unknown', 'satisfied', 'unsatisfied', 'unknown', 'satisfied', 'unsatisfied', 'unknown', 'unsatisfied', 'satisfied', 'unknown', 'satisfied', 'unsatisfied', 'satisfied', 'unsatisfied', 'unknown', 'satisfied', 'unknown', 'unknown'];
  for (const [i, data] of serviceDrillDatasets(now).entries()) {
    const db = new DatabaseSync(':memory:'), graph = new OntologyObjectStore(db, undefined, () => now), definition = serviceDomain(SERVICE_DRILL_QUESTIONS[i]![1]);
    try {
      data.initialize(graph, data.id);
      const queryType = data.id === 'B02' ? definition.candidateType : definition.resultType;
      const items = graph.query(data.id, { type: queryType }).items;
      if (data.id === 'B02') items.sort((a, b) => Number(b.properties.feesComplete) - Number(a.properties.feesComplete));
      const values = items.map(item => graph.evaluate(data.id, { function: data.id === 'B02' ? definition.eligibleFunction : definition.outcomeFunction, object: item.ref }));
      assert(values.every(v => v.status === 'known'), `${data.id}: source projection must be valid before assessing its business meaning`);
      assert.equal((values[0]!.value as DomainAssessment).status, expected[i], data.id);
      if (data.id === 'B02') assert.equal((values[1]!.value as DomainAssessment).status, 'unknown');
      assert(!JSON.stringify(graph.query(data.id, { type: 'PatientProfile' })).includes('PRIVATE_'));
      assert.equal(graph.query('unrelated-owner', { type: queryType }).items.length, 0);
    } finally { db.close(); }
  }
});
