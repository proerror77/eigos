import { flightAction, type FlightInput, type FlightData } from '../packages/capabilities/rollinggo-flight/contracts.js';
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
import { flightInput, flightData, airportData } from './fixtures/rollinggo-flight.js';
const cases: { input: FlightInput; data: FlightData }[] = [
  { input: flightInput, data: flightData },
  { input: { kind: 'airports', keyword: 'Hangzhou' }, data: airportData },
  { input: { ...flightInput, tripType: 'ROUND_TRIP', retDate: '2099-01-05' }, data: { kind: 'flights', flights: [] } },
];
for (const { input, data } of cases) test(`${flightAction(input)} completes through the task model with source evidence and no business writes`, async () => {
  const store = new JobStore(':memory:');
  let calls = 0;
  const catalog = createExecutionCatalog({
    store,
    rollinggoFlight: {
      keyFile: '/synthetic/key',
      keySha256: 'a'.repeat(64),
      evidenceKind: 'fixture',
      connector: {
        search: async (args, signal) => {
          signal.throwIfAborted();
          assert.deepEqual(args, input);
          calls++;
          return {
            data,
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
          'flight.search.query',
          input,
        ),
        capabilityRef: { id: 'flight.search.query', version: '1' },
      },
      evidence: evidence(),
    }),
    plan: async () => {
      throw new Error('No legacy plan');
    },
    act: async (ctx, _signal, access) => {
      observeTaskContext(access);
      access.session.call('describe_ontology', {
        actions: [flightAction(input)],
      });
      access.session.call('query_ontology', { object: ctx.state.scope });
      const ref = ctx.state.observations[0];
      if (ref) {
        access.session.call('query_ontology', { object: ref });
        access.session.call('evaluate_ontology', {
          function: 'rollingGoFlightSearchStatus',
          object: ref,
        });
      }
      const decision = {
        kind: ref ? ('complete' as const) : ('execute' as const),
        requestRevision: ctx.request.revision,
        message: 'Synthetic flight search choice',
        steps: ref
          ? []
          : [
              {
                id: 'search',
                action: flightAction(input),
                argumentsJson: JSON.stringify({ scope: ctx.state.scope }),
                dependsOn: [],
                inputRefs: [],
              },
            ],
        completionJson: ref
          ? JSON.stringify({
              observation: ref,
              rationale: 'Return the observed flight reference prices',
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
      goal: 'Search Taipei flights only',
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
            'rollingGoFlightAnswer' in job.artifact.data.result,
        );
        const fares = store.ontology.query(owner, { type: 'FlightFare' }).items;
        if (input.kind === 'airports') { assert.equal(store.ontology.query(owner, { type: 'Airport' }).items.length, 1); return; }
        if (data.kind !== 'flights' || !data.flights.length) { assert.equal(fares.length, 0); return; }
        assert.equal(fares.length, 1);
        assert.equal(fares[0]!.properties.amountUnit, 'unknown');
        assert.equal(store.ontology.related(owner, fares[0]!.ref, 'outboundSegments', { remaining: 1000 })!.length, 1);
        assert.equal(store.ontology.evaluate(owner, { function: 'businessFactStatus', object: fares[0]!.ref }).status, 'known');
        return;
      }
      await b.run();
    }
    assert.fail('Task did not finish');
  } finally {
    store.close();
  }
});
