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
import { packageInput, packageResponse, hotelInput, hotelResponse, flightInput, flightResponse } from './fixtures/fliggy.js';
import { parseFliggyResponse, fliggyActions, type FliggyInput } from '../packages/capabilities/fliggy/contracts.js';
const cases: {input:FliggyInput,response:unknown}[] = [{input:packageInput,response:packageResponse},{input:hotelInput,response:hotelResponse},{input:flightInput,response:flightResponse},{input:{...hotelInput,kind:'marriottHotel'},response:hotelResponse},{input:{...packageInput,criteria:{keyword:'Empty synthetic search'}},response:{status:0,message:'empty',data:null}}];
for(const {input,response} of cases) test(`${fliggyActions[input.kind].action} completes a scoped partial source query`, async () => {
  const store = new JobStore(':memory:');
  let calls = 0;
  const catalog = createExecutionCatalog({
    store,
    fliggy: {
      mode: 'trial',
      evidenceKind: 'fixture',
      connector: {
        search: async (args, signal) => {
          signal.throwIfAborted();
          assert.deepEqual(args, input);
          calls++;
          return {
            data: parseFliggyResponse(input,response),
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
          'fliggy.travel.search',
          input,
        ),
        capabilityRef: { id: 'fliggy.travel.search', version: '1' },
      },
      evidence: evidence(),
    }),
    plan: async () => {
      throw new Error('No legacy plan');
    },
    act: async (ctx, _signal, access) => {
      observeTaskContext(access);
      access.session.call('describe_ontology', {
        actions: [fliggyActions[input.kind].action],
      });
      access.session.call('query_ontology', { object: ctx.state.scope });
      const ref = ctx.state.observations[0];
      if (ref) {
        access.session.call('query_ontology', { object: ref });
        access.session.call('evaluate_ontology', {
          function: 'fliggySearchStatus',
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
                action: fliggyActions[input.kind].action,
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
            'fliggyAnswer' in job.artifact.data.result,
        );
        const results = store.ontology.query(owner, { type: 'FliggyTravelOption' }).items;
        assert.equal(results.length, parseFliggyResponse(input,response).items.length);
        for(const option of results){
          assert.equal(option.properties.comparisonStatus,'unverified'); assert.equal(option.properties.commissionRate,'unknown');
          assert.equal(store.ontology.evaluate(owner,{function:'businessFactStatus',object:option.ref}).status,'known');
        }
        if(input.kind==='marriottPackage'){
          assert.equal(store.ontology.query(owner,{type:'TravelProduct'}).items.length,results.length);
          assert.equal(store.ontology.query(owner,{type:'ProductVariant'}).items.length,0,'Source itemId must not become a fabricated SKU');
          assert.equal(store.ontology.query(owner,{type:'RoomType'}).items.length,0,'Package prose cannot create room identities');
        }
        return;
      }
      await b.run();
    }
    assert.fail('Task did not finish');
  } finally {
    store.close();
  }
});
