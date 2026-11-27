import assert from 'node:assert/strict';
import { test } from 'node:test';
import { measureScenarioRebase } from '../scripts/benchmarks/scenario-rebase.js';

test('rebase of 10000 edited objects uses the same SQL statement count as one object', async () => {
  const samples = await measureScenarioRebase();
  assert.equal(samples[0]!.statements, samples[1]!.statements);
  console.log(JSON.stringify({ bench: 'scenario-rebase', synthetic: true, samples }));
});
