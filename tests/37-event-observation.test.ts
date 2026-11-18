import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventObservation } from '../packages/runtime/event-observation.js';
import { fixture, principal } from './fixture.js';
import { memberGrants, setGrants, Access } from '../packages/runtime/access.js';
import { Objects } from '../packages/runtime/objects.js';
import { ontologyServices } from '../packages/runtime/services.js';
import { ObservationInterests } from '../packages/runtime/observation-interests.js';
import { addProcessLogs } from '../packages/ontology/process-definition.js';

test('event silence is measured from phase entry or new evidence, never from a reconciliation tick', () => {
  const startedAt = new Date('2030-01-01T00:00:00Z');
  const at = (seconds: number) => new Date(startedAt.getTime() + seconds * 1000);
  const inspect = (now: number, evidence: number | null) =>
    eventObservation({
      startedAt,
      now: at(now),
      lastObservedAt: evidence === null ? null : at(evidence),
      maxSilenceSeconds: 60,
    });
  assert.equal(inspect(59, null).status, 'waiting');
  assert.equal(inspect(60, null).reason, 'no_source_evidence');
  assert.equal(inspect(60, -10).reason, 'no_source_evidence');
  assert.deepEqual(inspect(70, 35).nextReviewAt, at(95));
  assert.deepEqual(inspect(95, 35), { status: 'stranded', reason: 'source_silent', nextReviewAt: at(95) });
  assert.equal(inspect(95, 200).reason, 'invalid_evidence_time');
});

test('an authorized event-only interest survives a new reconciler and advances on committed business evidence without polling a supplier', async () => {
  const f = await fixture();
  try {
    const definition = structuredClone(f.model.document);
    definition.objectTypes.find((type) => type.apiName === 'Route')!.properties.phase = {
      description: 'Observed route phase',
      schema: { type: 'string', enum: ['planned', 'arrived'] },
      required: false,
    };
    definition.objectTypes.find((type) => type.apiName === 'Route')!.properties.providerAt = {
      description: 'Original receipt time',
      schema: { type: 'string', format: 'date-time' },
      required: false,
    };
    addProcessLogs(definition, [{ type: 'Route', property: 'phase' }]);
    const model = await f.metadata.publish(definition, f.capabilities, f.publisher);
    await setGrants(f.db, principal.owner, memberGrants(model));
    const graph = new Objects(f.db, model, await Access.load(f.db, principal));
    const object = { type: 'Route', id: 'event-observation' };
    await graph.create(object, { id: object.id, name: 'Synthetic route', phase: 'planned' });
    const services = ontologyServices(
      f.db,
      f.metadata,
      f.capabilities,
      f.capabilities.functions,
      f.capabilities.effects,
      f.capabilities.actions,
    );
    const started = (await services.get('start_observation_interest')!.invoke(principal, {
      requestId: 'wait-for-arrival',
      object,
      deadline: new Date(Date.now() + 60 * 86400000).toISOString(),
      phases: [
        {
          name: 'Wait for committed arrival',
          process: 'RoutePhaseLog',
          complete: ['arrived'],
          wait: { maxSilenceSeconds: 150 },
        },
      ],
    })) as { id: string };
    const fresh = (await services.get('start_observation_interest')!.invoke(principal, {
      requestId: 'wait-for-receipt',
      object,
      deadline: new Date(Date.now() + 60 * 86400000).toISOString(),
      phases: [
        {
          name: 'Wait for a provider receipt',
          process: 'RoutePhaseLog',
          complete: ['arrived'],
          evidenceProperty: 'providerAt',
          wait: { maxSilenceSeconds: 150 },
        },
      ],
    })) as { id: string };
    const providerAt = new Date().toISOString();
    await graph.edit(object, 1, { providerAt });
    const afterSameState = (await services.get('observation_interests')!.invoke(principal, { object })) as {
      items: { id: string; lastObservedAt: string | Date | null; lastState: string }[];
    };
    const evidence = afterSameState.items.find((row) => row.id === fresh.id)!;
    assert.equal(evidence.lastState, 'planned');
    assert.equal(new Date(evidence.lastObservedAt!).toISOString(), providerAt);
    await services.get('cancel_observation_interest')!.invoke(principal, { id: fresh.id });
    await graph.edit(object, 2, { phase: 'arrived' });
    await f.db.query(`UPDATE ${f.db.schema}.observation_interests SET next_scan=now() WHERE id=$1`, [started.id]);
    assert(await new ObservationInterests(f.db).scanOne());
    const result = (await services.get('observation_interests')!.invoke(principal, { object })) as {
      items: { id: string; status: string; lastState: string }[];
    };
    const interest = result.items.find((item) => item.id === started.id)!;
    assert.equal(interest.status, 'completed');
    assert.equal(interest.lastState, 'arrived');
    assert.equal((await f.db.query(`SELECT 1 FROM ${f.db.schema}.scheduled_actions`)).rowCount, 0);
  } finally {
    await f.close();
  }
});
