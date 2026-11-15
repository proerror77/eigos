import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentEvaluationCases, evaluateAgentCase } from './agent-evaluation.js';
import { harnessFixture } from './harness-fixture.js';

for (const name of agentEvaluationCases) {
  test(`Agent evaluation observes real MCP tools and durable effects for ${name}`, async () => {
    const harness = await harnessFixture();
    try {
      const result = await evaluateAgentCase(name, input => ({
        model: harness.driver.model,
        // Only the recorded model fixture receives fixed arguments. Native runs receive the original user prompt.
        run(_prompt, tools, signal) {
          const request = 'route' in input ? { route: input.route } : { message: JSON.stringify({ planning: input.plan }) };
          return harness.driver.run(JSON.stringify({ userRequest: request }), tools, signal);
        },
      }));
      assert.equal(result.passed, true, JSON.stringify(result.checks.filter(check => !check.passed)));
    } finally { await harness.close(); }
  });
}

test('Agent evaluation rejects a completed-looking run with no observed business operation', async () => {
  const result = await evaluateAgentCase('didi-quote-retry', () => ({
    model: 'text-only-test',
    async run(_prompt, tools) {
      await tools.get('complete_with_aggregate')!.invoke({
        set: { op: 'query', query: { type: 'RideRequest' } }, metrics: { value: { op: 'count' } },
      });
    },
  }));
  assert.equal(result.state, 'completed');
  assert.equal(result.passed, false);
  assert.equal(result.checks.find(check => check.id === 'one-committed-estimate-action')?.passed, false);
});
