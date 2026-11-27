import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scenarioReviewActions } from '../packages/ontology/scenario-definition.js';
import { Access, businessGrants, setGrants } from '../packages/runtime/access.js';
import { Objects } from '../packages/runtime/objects.js';
import { initializeScenarioLifecycle, Scenarios } from '../packages/runtime/scenarios.js';
import { ontologyServices } from '../packages/runtime/services.js';
import { document, fixture, principal } from './fixture.js';

const reviewNames = Object.values(scenarioReviewActions) as string[];
const reviewer = { ...principal, owner: 'synthetic-reviewer' };
const stranger = { ...principal, owner: 'synthetic-uninvited' };

function reviewedRouteDefinition() {
  const definition = structuredClone(document);
  definition.actionTypes.push({
    apiName: 'MergeReviewedRoute', description: 'Apply the reviewed changes to Route objects',
    parameters: { type: 'object', additionalProperties: false,
      properties: { id: { type: 'string' }, revision: { type: 'integer' }, route: { type: 'string' } },
      required: ['id', 'revision', 'route'] },
    objectParameters: {}, submissionCriteria: [],
    rules: [{ op: 'applyScenario', scenario: { parameter: 'id' }, expectedRevision: { parameter: 'revision' }, objectTypes: ['Route'], linkTypes: [] }],
    result: { type: 'Route', id: { parameter: 'route' } },
  });
  return definition;
}

test('published Scenario review Actions retain the legacy receipt and govern rejection, resubmission and merge', async () => {
  const definition = reviewedRouteDefinition();
  const f = await fixture(undefined, undefined, undefined, definition);
  try {
    const { db, model, capabilities } = f;
    const grant = businessGrants(model).filter(item => item.permission !== 'apply_action' || !reviewNames.some(name => item.resource === 'Eigos/action/' + name));
    await setGrants(db, reviewer.owner, grant);
    await setGrants(db, stranger.owner, grant);
    const access = (actor = principal) => Access.load(db, actor);
    const scenarios = new Scenarios(db);
    const services = ontologyServices(db, f.metadata, capabilities, capabilities.functions, capabilities.effects, capabilities.actions);
    const legacy = (name: string, actor: typeof principal, input: unknown) => services.get(name)!.invoke(actor, input);
    const draft = await scenarios.create(await access(), model, { requestId: 'review-fixture', name: 'Review proposed route' });
    const reference = { type:'OntologyScenario', id: draft.id }, route = { type: 'Route', id: 'review-action-route' };
    const metadata = async () => (await new Objects(db, model, await access()).read(reference)).properties;
    assert.equal((await metadata()).reviewStatus, 'draft');
    const proposed = new Objects(db, await scenarios.view(await access(), model, draft.id), await access());
    await proposed.create(route, { id: route.id, name: 'Reviewed route' });
    const { revision } = await scenarios.inspect(await access(), model, draft.id);
    const submit = { id: draft.id, revision, reviewers: [reviewer.owner] };
    await assert.rejects(capabilities.actions.validate(await access(stranger), model, { action: scenarioReviewActions.submit, input: submit }), /Owned Scenario/);
    assert.deepEqual(await legacy('invite_scenario_reviewers', principal, submit),
      { id: draft.id, revision: revision + 1, reviewers: [reviewer.owner] });
    assert.equal((await metadata()).reviewStatus, 'in-review');

    const inspected = await scenarios.inspectReview(await access(reviewer), model, draft.id);
    const reviewed = { id: draft.id, revision: inspected.revision, snapshot: inspected.snapshot };
    await assert.rejects(capabilities.actions.validate(await access(stranger), model, { action: scenarioReviewActions.reject, input: reviewed }), /review is unavailable/);
    await capabilities.actions.validate(await access(reviewer), model, { action: scenarioReviewActions.reject, input: reviewed });
    await assert.rejects(legacy('reject_scenario_review', reviewer, { ...reviewed, snapshot: '0'.repeat(64) }), /review changed/);
    assert.deepEqual(await legacy('reject_scenario_review', reviewer, reviewed),
      { id: draft.id, revision: reviewed.revision, reviewer: reviewer.owner, rejected: true });
    assert.equal((await metadata()).reviewStatus, 'rejected');
    await assert.rejects(legacy('approve_scenario_review', reviewer, reviewed), /already has a review decision/);
    await assert.rejects(capabilities.actions.apply(await access(), model, 'MergeReviewedRoute',
      { id: draft.id, revision: reviewed.revision, route: route.id }, 'rejected-merge'), /rejected Scenario/);
    assert.equal((await metadata()).state, 'open');
    await assert.rejects(new Objects(db, model, await access()).read(route), /unavailable/);

    await legacy('invite_scenario_reviewers', principal, { ...submit, revision: reviewed.revision });
    const next = await scenarios.inspectReview(await access(reviewer), model, draft.id);
    assert.equal((await metadata()).reviewStatus, 'in-review');
    assert.deepEqual(await legacy('approve_scenario_review', reviewer, { id: draft.id, revision: next.revision, snapshot: next.snapshot }),
      { id: draft.id, revision: next.revision, reviewer: reviewer.owner, approved: true });
    assert.equal((await metadata()).reviewStatus, 'approved');
    // Reconstruct the old storage shape: the decision existed before the metadata fields were backfilled.
    await db.query(`UPDATE ${db.schema}.scenarios SET review_status=NULL,reviewed_revision=NULL WHERE id=$1`, [draft.id]);
    await initializeScenarioLifecycle(db);
    assert.equal((await metadata()).reviewStatus, 'approved');
    await capabilities.actions.apply(await access(), model, 'MergeReviewedRoute',
      { id: draft.id, revision: next.revision, route: route.id }, 'approved-merge');
    assert.equal((await new Objects(db, model, await access()).read(route)).properties.name, 'Reviewed route');
    assert.equal((await metadata()).state, 'merged');
    assert.equal((await metadata()).reviewStatus, 'approved');
    const { rows } = await db.query(`SELECT owner,action,count(*)::int AS count FROM ${db.schema}.actions
      WHERE action=ANY($1::text[]) GROUP BY owner,action ORDER BY action`, [reviewNames]);
    assert.deepEqual(rows, [
      { owner: reviewer.owner, action: scenarioReviewActions.approve, count: 1 },
      { owner: reviewer.owner, action: scenarioReviewActions.reject, count: 1 },
      { owner: principal.owner, action: scenarioReviewActions.submit, count: 2 },
    ]);
  } finally { await f.close(); }
});

test('reciprocal reviewer approvals acquire owner locks consistently', async () => {
  const f = await fixture();
  try {
    const { db, model, capabilities } = f;
    await setGrants(db, reviewer.owner, businessGrants(model));
    const actors = [principal, reviewer];
    const scenarios = new Scenarios(db);
    const reviews = await Promise.all(actors.map(async (owner, index) => {
      const proposer = await Access.load(db, owner), reviewerActor = actors[1 - index]!;
      const draft = await scenarios.create(proposer, model, { requestId: 'reciprocal', name: 'Synthetic reciprocal review' });
      const graph = new Objects(db, await scenarios.view(proposer, model, draft.id), proposer);
      await graph.create({ type: 'Route', id: 'route-' + index }, { id: 'route-' + index, name: 'Synthetic route' });
      const { revision } = await scenarios.inspect(proposer, model, draft.id);
      await capabilities.actions.apply(proposer, model, scenarioReviewActions.submit,
        { id: draft.id, revision, reviewers: [reviewerActor.owner] }, 'reciprocal-submit');
      const approver = await Access.load(db, reviewerActor);
      return { approver, review: await scenarios.inspectReview(approver, model, draft.id) };
    }));
    await Promise.all(reviews.map(({ approver, review }) => capabilities.actions.apply(approver, model, scenarioReviewActions.approve,
      { id: review.id, revision: review.revision, snapshot: review.snapshot }, 'reciprocal-approve')));
    const { rows: [count] } = await db.query(`SELECT count(*)::int AS n FROM ${db.schema}.scenario_approvals WHERE decision='approved'`);
    assert.equal(count!.n, 2);
  } finally { await f.close(); }
});

test('approval and the exact owner-authorized merge commit or roll back together', async () => {
  const f = await fixture(undefined,undefined,undefined,reviewedRouteDefinition());
  try {
    const { db,model,capabilities } = f, actions = capabilities.actions;
    const grants = businessGrants(model);
    await setGrants(db,reviewer.owner,grants);
    const owner = () => Access.load(db,principal), approver = () => Access.load(db,reviewer);
    const scenarios = new Scenarios(db);
    const draft = await scenarios.create(await owner(),model,{requestId:'atomic-approval',name:'Synthetic route'});
    const ref = {type:'Route',id:'atomic-review-route'};
    const staged = new Objects(db,await scenarios.view(await owner(),model,draft.id),await owner());
    await staged.create(ref,{id:ref.id,name:'Reviewed route'});
    const initial = (await scenarios.inspect(await owner(),model,draft.id)).revision;
    await actions.apply(await owner(),model,scenarioReviewActions.submit,{id:draft.id,revision:initial,reviewers:[reviewer.owner]},'ordinary-invite');
    const ordinary = await scenarios.inspectReview(await approver(),model,draft.id);
    const review = (item: typeof ordinary) => ({id:draft.id,revision:item.revision,snapshot:item.snapshot});
    await assert.rejects(actions.apply(await approver(),model,scenarioReviewActions.approveAndMerge,review(ordinary),'unbound-approval'),/No owner-authorized merge/);
    const state = async () => (await scenarios.inspect(await owner(),model,draft.id)).state;
    const merge = {action:'MergeReviewedRoute',input:{id:draft.id,revision:ordinary.revision+1,route:ref.id}};
    const submit = {id:draft.id,revision:ordinary.revision,reviewers:[reviewer.owner],merge};
    await assert.rejects(actions.apply(await owner(),model,scenarioReviewActions.submitForMerge,
      {...submit,merge:{...merge,input:{...merge.input,revision:0}}},'wrong-authorization'),/revision|greater than/i);
    await actions.apply(await owner(),model,scenarioReviewActions.submitForMerge,submit,'bound-invite');
    const reviewed = review(await scenarios.inspectReview(await approver(),model,draft.id));
    const live = new Objects(db,model,await owner());
    const withoutMerge = grants.filter(g=>!(g.resource==='Eigos/action/MergeReviewedRoute' && g.permission==='apply_action'));
    await setGrants(db,principal.owner,withoutMerge);
    const approve = async () => actions.apply(await approver(),model,scenarioReviewActions.approveAndMerge,reviewed,'atomic-approved');
    await assert.rejects(approve(),/Permission|unavailable/);
    assert.equal(await state(),'open');
    await assert.rejects(live.read(ref),/unavailable/);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${db.schema}.scenario_approvals WHERE scenario_id=$1`,[draft.id])).rows[0]!.n,0);
    await setGrants(db,principal.owner,grants);
    assert.deepEqual(await approve(),{type:'OntologyScenario',id:draft.id});
    assert.deepEqual(await approve(),{type:'OntologyScenario',id:draft.id});
    assert.equal((await live.read(ref)).properties.name,'Reviewed route');
    const { rows } = await db.query(`SELECT owner,action FROM ${db.schema}.actions WHERE action=ANY($1::text[]) ORDER BY action`,
      [[scenarioReviewActions.approveAndMerge,'MergeReviewedRoute']]);
    assert.deepEqual(rows,[{owner:reviewer.owner,action:scenarioReviewActions.approveAndMerge},{owner:principal.owner,action:'MergeReviewedRoute'}]);
  } finally { await f.close(); }
});
