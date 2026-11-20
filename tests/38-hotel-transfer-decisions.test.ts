import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp } from '../apps/gateway/app.js';
import { readConfig } from '../packages/core/config.js';
import {
  transferDecisionType, transferObservationSource, transferObservationType,
} from '../packages/ontology/hotel-transfer-decisions.js';
import type { ObjectRef } from '../packages/ontology/schema.js';
import { businessGrants, setGrants } from '../packages/runtime/access.js';
import { Indexing } from '../packages/runtime/indexing.js';
import { Objects } from '../packages/runtime/objects.js';
import { Scenarios } from '../packages/runtime/scenarios.js';
import { OntologyClient } from '../packages/sdk/client.js';
import { fixture, principal } from './fixture.js';
import { calendarAnswer, PlanningFixtureAgent } from './planning-fixture.js';
import { serviceProvider } from './service-fixture.js';

const minutesAfter = (time: string, minutes: number) => new Date(Date.parse(time) + minutes * 60_000).toISOString();

test('a second dated hotel Scenario review shows the first approved reason, independent result and confirmed lesson', async () => {
  const supplier = serviceProvider();
  const f = await fixture(new PlanningFixtureAgent(), supplier.resolve, undefined, undefined, undefined, {}, { sandbox: true });
  const reviewer = { ...principal, owner: 'hotel-transfer-reviewer' };
  const config = readConfig({
    DATABASE_URL: process.env.EIGOS_TEST_DATABASE_URL, EIGOS_AUTH_MODE: 'development',
    EIGOS_AGENT_SANDBOX_ENABLED: 'true', EIGOS_DEV_TOKEN: 'synthetic-transfer-test-'.repeat(3),
  });
  const { app } = createApp(config, f.db, f.source, async token => {
    if (token === 'transfer-owner') return principal;
    if (token === 'transfer-producer') return { ...principal, clientId: 'synthetic-arrival-feed' };
    if (token === 'transfer-reviewer') return reviewer;
    throw new Error('Unknown test identity');
  });
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const baseUrl = 'http://127.0.0.1:' + address.port;
    const ownerClient = new OntologyClient({ baseUrl, token: 'transfer-owner' });
    const producerClient = new OntologyClient({ baseUrl, token: 'transfer-producer' });
    const reviewerClient = new OntologyClient({ baseUrl, token: 'transfer-reviewer' });
    const graph = new Objects(f.db, f.model, f.access);
    const readGrants = businessGrants(f.model, true);
    await setGrants(f.db, reviewer.owner, readGrants);
    await setGrants(f.db, principal.owner, [...readGrants,
      { resource: 'Eigos/datasource/' + transferObservationSource, permission: 'ingest_source' }]);

    const start = new Date(Date.now() + 3 * 86_400_000);
    start.setUTCHours(5, 0, 0, 0);
    async function propose(dayOffset: number) {
      const from = minutesAfter(start.toISOString(), dayOffset * 1440);
      const date = from.slice(0, 10);
      const planning = { title: 'Synthetic hotel transfer ' + date, start: from, end: minutesAfter(from, 240),
        timeZone: 'Asia/Shanghai', durationMinutes: 40 };
      const task = await f.tasks.submit(principal, { requestId: 'hotel-transfer-' + date, message: JSON.stringify({ planning }) });
      assert.equal(await f.worker.runOne(), true);
      const waiting = await f.tasks.get(principal, task.id);
      assert.equal(waiting.state, 'input-required', JSON.stringify(waiting));
      const request = waiting.result as { requestId: string; capability: string };
      assert.equal(request.capability, 'calendar.freebusy');
      await ownerClient.request('tasks/' + task.id + '/pa-response',
        { requestId: request.requestId, response: calendarAnswer(planning) });
      assert.equal(await f.worker.runOne(), true);
      const ready = await f.tasks.get(principal, task.id);
      assert.equal(ready.state, 'completed', JSON.stringify(ready));
      const { plan, scenarioId, validation } = ready.result as { plan: { ref: ObjectRef }; scenarioId: string;
        validation: { valid: boolean; calendarEvidence: { evidence: string }[] } };
      assert.equal(validation.valid, true);
      assert.equal(validation.calendarEvidence[0]?.evidence, 'synthetic');

      const search = await f.capabilities.actions.resolve(f.access, f.model, {
        interface: { type: 'HotelSearch', implementation: 'RollingGoHotelSearch', action: 'search' },
        input: { place: '上海', checkIn: date, adults: 1, nights: 1, currency: 'CNY', limit: 3 },
      });
      const page = await f.capabilities.actions.apply(f.access, f.model, search.action, search.input, 'read-hotel-' + date);
      const offers = await graph.query({ type: 'HotelOffer', from: { object: page, link: 'results', as: 'ServiceSearchResult' } });
      assert.equal(offers.items[0]?.properties.checkIn, date);
      assert.equal((await graph.read(offers.items[0]!.ref)).properties.evidence, 'synthetic');
      const proposal = ownerClient.scenario(scenarioId);
      const view = await new Scenarios(f.db).view(f.access, f.model, scenarioId);
      await f.capabilities.actions.apply(f.access, view,
        'AttachPlanService', { plan: plan.ref, service: offers.items[0]!.ref }, 'select-hotel-' + date);
      await proposal.inviteReviewers((await proposal.inspect()).revision, [reviewer.owner]);
      return { date, plan: plan.ref, proposal, review: reviewerClient.scenario(scenarioId) };
    }

    const first = await propose(0);
    const firstReview = await first.review.inspectReview();
    const firstMemory = firstReview.decisionMemory;
    assert.ok(firstMemory);
    assert.deepEqual(firstMemory.prior, []);
    const judgment = {
      reason: 'Choose the later departure to reduce waiting at the hotel.',
      alternative: 'Leave earlier', rejectedBecause: 'More waiting before check-in',
      assumption: 'The transfer takes 25 minutes in this time slot.', expectedTravelMinutes: 25,
    };
    await assert.rejects(first.review.approveReview(firstReview.revision, firstReview.snapshot,
      { decision: { ...judgment, expectedTravelMinutes: 41 } }), /does not fit/);
    assert.equal((await reviewerClient.pendingScenarioReviews()).items[0]?.approved, false);
    assert.deepEqual(await graph.follow(first.plan, 'transferDecisions'), []);
    await first.review.approveReview(firstReview.revision, firstReview.snapshot, { decision: judgment });
    await first.review.approveReview(firstReview.revision, firstReview.snapshot, { decision: judgment });
    await assert.rejects(first.review.approveReview(firstReview.revision, firstReview.snapshot,
      { decision: { ...judgment, reason: 'A different reason after approval' } }), /original approval/);
    const saved = await graph.follow(first.plan, 'transferDecisions');
    assert.equal(saved.length, 1);
    const decision = saved[0]!;
    assert.equal(decision.ref.type, transferDecisionType);
    assert.equal(decision.properties.release, f.model.release);
    assert.equal(decision.properties.scenarioId, firstReview.id);
    assert.equal(decision.properties.scenarioRevision, firstReview.revision);
    assert.equal(decision.properties.reviewer, reviewer.owner);
    assert.deepEqual(decision.properties.judgment, { ...judgment, expectedBufferMinutes: 15 });
    assert.equal(decision.properties.result, undefined);
    await first.proposal.merge('CommitSchedulePlan', 'merge-first-itinerary', firstReview.revision, { plan: first.plan });

    const second = await propose(1);
    assert.notEqual(second.date, first.date);
    assert.deepEqual((await second.review.inspectReview()).decisionMemory?.prior, []);
    const observation = { type: transferObservationType, id: 'independent-arrival-' + first.date };
    const lesson = 'Budget ten more minutes for the same time slot.';
    const appliesWhen = 'Same Shanghai hotel and local departure hour';
    const outcome = { action: 'ReviewHotelTransferOutcome', requestId: 'confirm-transfer-result',
      input: { decision: decision.ref, revision: decision.revision, observation, assessment: 'refuted', lesson, appliesWhen } };
    await assert.rejects(ownerClient.apply(outcome), /unavailable|not found/i);

    const reading = { source: transferObservationSource, stream: 'synthetic-arrivals', offset: 1, mode: 'stream',
      observedAt: firstMemory.arriveBy, rows: [{
        id: observation.id, decisionId: decision.ref.id, departedAt: firstMemory.departure,
        arrivedAt: minutesAfter(firstMemory.departure, 35), observedAt: firstMemory.arriveBy, evidence: 'synthetic',
      }] };
    await assert.rejects(reviewerClient.service('submit_index', reading), /permission required: ingest_source/i);
    const producer = await producerClient.service<{ id: string }>('submit_index', reading);
    assert.equal(await new Indexing(f.db, f.metadata).runOne(), true);
    const receipt = await ownerClient.service<{ state: string }>('index_status', { id: producer.id });
    assert.equal(receipt.state, 'applied');
    await ownerClient.apply(outcome);
    await ownerClient.apply(outcome);
    assert.deepEqual((await graph.follow(decision.ref, 'observation')).map(item => item.ref), [observation]);

    const secondReview = await second.review.inspectReview();
    assert.deepEqual(secondReview.decisionMemory?.prior, [{
      decision: decision.ref, date: first.date, judgment, expectedBufferMinutes: 15,
      actualTravelMinutes: 35, actualBufferMinutes: 5, assessment: 'refuted', lesson, appliesWhen,
    }]);
    assert.equal((await reviewerClient.pendingScenarioReviews()).items.find(item => item.id === secondReview.id)?.approved, false);

    await setGrants(f.db, reviewer.owner, readGrants.filter(grant =>
      grant.resource !== 'Eigos/object/' + transferObservationType));
    assert.deepEqual((await second.review.inspectReview()).decisionMemory?.prior, []);
    await setGrants(f.db, reviewer.owner, readGrants);
    await second.proposal.inviteReviewers(secondReview.revision, [reviewer.owner]);
    await assert.rejects(second.review.approveReview(secondReview.revision, secondReview.snapshot, { decision: judgment }), /review changed/);
    const refreshed = await second.review.inspectReview();
    assert.equal(refreshed.decisionMemory?.prior[0]?.lesson, lesson);
    await second.review.approveReview(refreshed.revision, refreshed.snapshot, {
      decision: { ...judgment, reason: 'Use the observed longer travel time.', expectedTravelMinutes: 35 },
    });
    assert.equal((await graph.follow(second.plan, 'transferDecisions')).length, 1);
    await producerClient.service('submit_index', { ...reading, offset: 2, observedAt: minutesAfter(reading.observedAt, 1),
      rows: [{ ...reading.rows[0]!, arrivedAt: minutesAfter(firstMemory.departure, 36) }] });
    assert.equal(await new Indexing(f.db, f.metadata).runOne(), true);
    assert.deepEqual((await second.review.inspectReview()).decisionMemory?.prior, []);
    assert.deepEqual(supplier.flags.calls, ['RollingGo', 'RollingGo']);
    assert.equal(f.provider.flags.orderCreates, 0);
    assert.equal((await f.db.query('SELECT count(*)::int AS count FROM ' + f.db.schema + '.external_operations')).rows[0]?.count, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await f.close();
  }
});
