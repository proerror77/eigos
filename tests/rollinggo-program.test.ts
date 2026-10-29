// Synthetic model and source; validates the shared task execution path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { JobStore } from '../packages/core/store.js';
import {
  backend,
  interpretation,
  evidence,
  observeTaskContext,
  acknowledgeReads,
  syntheticGoalReview,
  owner,
} from './backend-fixture.js';
import { digest } from '../packages/core/delegation.js';
import type { Reasoner } from '../packages/coordinator/coordinator.js';
const input = {
  originQuery: 'Taipei hotel',
  place: 'Taipei Taiwan',
  placeType: 'city',
  checkInParam: { checkInDate: '2099-01-01', stayNights: 1, adultCount: 2 },
  localeParam: { currency: 'USD', language: 'en' },
  size: 3,
};
test('hotel search completes through the task model with source evidence and no business writes', async () => {
  const store = new JobStore(':memory:');
  let calls = 0;
  const catalog = createExecutionCatalog({
    store,
    rollinggo: {
      keyFile: '/synthetic/key',
      keySha256: 'a'.repeat(64),
      evidenceKind: 'fixture',
      connector: {
        search: async (args, signal) => {
          signal.throwIfAborted();
          assert.deepEqual(args, input);
          calls++;
          return {
            hotels: [
              {
                hotelId: 1,
                name: 'Synthetic Taipei Hotel',
                price: { hasPrice: true, currency: 'USD', lowestPrice: 80 },
              },
            ],
            observedAt: new Date().toISOString(),
            priceKind: 'reference',
            providerExpiry: 'unknown',
          };
        },
      },
    },
  });
  const model: Reasoner = {
    reviewGoal: syntheticGoalReview,
    ground: async (request, _caps, _signal, access) => ({
      decision: {
        ...interpretation(
          observeTaskContext(access) ?? request,
          'hotel.search.query',
          input,
        ),
        capabilityRef: { id: 'hotel.search.query', version: '1' },
      },
      evidence: evidence(),
    }),
    plan: async () => {
      throw new Error('No legacy plan');
    },
    act: async (ctx, _signal, access) => {
      observeTaskContext(access);
      access.session.call('describe_ontology', {
        actions: ['SearchRollingGoHotels'],
      });
      access.session.call('query_ontology', { object: ctx.state.scope });
      const ref = ctx.state.observations[0];
      if (ref) {
        access.session.call('query_ontology', { object: ref });
        access.session.call('evaluate_ontology', {
          function: 'rollingGoSearchStatus',
          object: ref,
        });
      }
      const decision = {
        kind: ref ? ('complete' as const) : ('execute' as const),
        requestRevision: ctx.request.revision,
        message: 'Synthetic hotel search choice',
        steps: ref
          ? []
          : [
              {
                id: 'search',
                action: 'SearchRollingGoHotels',
                argumentsJson: JSON.stringify({ scope: ctx.state.scope }),
                dependsOn: [],
                inputRefs: [],
              },
            ],
        completionJson: ref
          ? JSON.stringify({
              observation: ref,
              rationale: 'Return the observed hotel reference prices',
            })
          : '',
      };
      acknowledgeReads(access);
      return {
        decision,
        evidence: { ...evidence(), decisionDigest: digest(decision) },
      };
    },
  };
  const b = backend(catalog, model, store);
  try {
    const submitted = b.submit({
      goal: 'Search Taipei hotels only',
      executionEnvironment: 'sandbox',
    });
    for (let i = 0; i < 10; i++) {
      const job = store.get(owner, submitted.id);
      if (!['submitted', 'working'].includes(job.state)) {
        assert.equal(
          job.state,
          'completed',
          JSON.stringify({
            state: job.state,
            feedback: job.delegation?.groundingFeedback,
            events: job.delegation?.events,
            actionFeedback: job.delegation?.agent?.feedback,
          }),
        );
        assert.equal(calls, 1);
        assert.ok(
          job.artifact?.data.result &&
            'rollingGoAnswer' in job.artifact.data.result,
        );
        return;
      }
      await b.run();
    }
    assert.fail('Task did not finish');
  } finally {
    store.close();
  }
});
