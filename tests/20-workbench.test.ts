import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fixture,principal} from './fixture.js';
import {createApp} from '../apps/gateway/app.js';
import {readConfig} from '../packages/core/config.js';
import {Applications} from '../packages/runtime/applications.js';
import {Objects} from '../packages/runtime/objects.js';
import {Scenarios} from '../packages/runtime/scenarios.js';
import {setGrants,memberGrants,Access} from '../packages/runtime/access.js';
import {OntologyClient} from '../packages/sdk/client.js';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import express from 'express';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { jwtVerifier } from '../apps/gateway/auth.js';

const modelFile=Buffer.from('solid test\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid test\n');

test('workbench renders relationship conflicts, manages Scenario reviews and scopes queries', async () => {
  const buttons = new Map<string, () => Promise<void>>();
  const controls: { value: string; placeholder?: string }[] = [];
  const tables: { headers: string[]; rows: unknown[][]; click?: (index: number) => Promise<void> }[] = [];
  const requests: { path: string; input: Record<string, unknown> }[] = [];
  const node = () => ({ append() {}, replaceChildren() {}, close() {} });
  const scenarioId = 'scenario-ui-fixture';
  let scenarioRevision = 2;
  let reviewers: string[] = [];
  const processRule = { id: 'process-rule-fixture', revision: 2, name: 'Late trip', enabled: true,
    process: { type: 'EventTripStateLog', to: 'authorized', dwellSeconds: 7200 }, workflow: 'workflow-fixture' };
  const context = {
    document: { querySelector: node, querySelectorAll: () => [] },
    sessionStorage: { getItem: () => null },
    window: { addEventListener() {} },
    uiElement: (_tag: string, attributes: Record<string, unknown> = {}) => {
      const control = { ...node(), value: '', ...attributes };
      controls.push(control);
      return control;
    },
    uiSelect: (_options: unknown, value: string) => {
      const control = { ...node(), value };
      controls.push(control);
      return control;
    },
    uiButton: (label: string, action: () => Promise<void>) => { buttons.set(label, action); return node(); },
    uiTable: (headers: string[], rows: unknown[][], click?: (index: number) => Promise<void>) => {
      tables.push({ headers, rows, click });
      return node();
    },
    uiNode: node,
    uiRequest: async (path: string, input: Record<string, unknown>) => {
      requests.push({ path, input: JSON.parse(JSON.stringify(input ?? {})) });
      if (path.startsWith('/ontology/scenarios?')) return { items: [{ id: scenarioId, name: 'Proposal' }] };
      if (path.startsWith('/ontology/scenarios/')) return {
        name: 'Proposal', revision: scenarioRevision, objects: [], review: { canInvite: true, reviewers },
        links: [
          { type: 'RequestRoute', from: { id: 'request' }, to: { id: 'route' }, removed: false, conflict: true },
          { type: 'RequestRoute', from: { id: 'resolved' }, to: { id: 'route' }, removed: true, conflict: false },
        ],
      };
      if (path === '/ontology/services/invite_scenario_reviewers') {
        reviewers = input.reviewers as string[];
        return { revision: ++scenarioRevision };
      }
      if (path === '/ontology/services/rebase_scenario') return { revision: ++scenarioRevision };
      if (path === '/ontology/services/pending_scenario_reviews') return {
        items: [{ id: scenarioId, name: 'Hotel replan', revision: 3, approved: false, conflicts: false }],
      };
      if (path === '/ontology/services/inspect_scenario_review') return {
        id: scenarioId, name: 'Hotel replan', revision: 3, snapshot: 'review-snapshot', objects: [{
          ref: { type: 'SchedulePlan', id: 'plan' }, editedFields: ['state'],
          before: { state: 'prepared' }, after: { state: 'confirmed' },
        }], links: [], evidence: [],
      };
      if (path === '/ontology/services/rules') return {
        items: [{id:'object-rule-fixture', name:'Open trip', query:{type:'EventTrip'}, enabled:false}, processRule],
      };
      return { items: [] };
    },
  };
  const source = await readFile(new URL('../apps/workbench/app.js', import.meta.url), 'utf8');
  const workbench = runInNewContext(source + `
    element = uiElement;
    select = uiSelect;
    button = uiButton;
    table = uiTable;
    surface = heading = field = empty = modal = uiNode;
    notice = () => {};
    request = uiRequest;
    ({ state, renderScenarios, renderObjects, semanticDialog, renderRules, renderProcesses });
  `, context);
  workbench.state.model = {
    objectTypes: [{ apiName: 'Route', displayName: 'Route', primaryKey: 'id', titleProperty: 'name',
      properties: { id: { schema: { type: 'string' } }, name: { schema: { type: 'string' } } } }],
    functionTypes: [{ apiName: 'Embed', version: '1', returns: { type: 'array', items: { type: 'number' } } }],
  };
  workbench.state.scenario = scenarioId;
  await workbench.renderScenarios();
  await tables[0]!.click!(0);
  const links = tables.find(table => table.headers[0] === '关系')!;
  assert.equal(links.headers[4], '冲突');
  assert.equal(links.rows[0]![4], '需要处理');
  assert.equal(links.rows[1]![4], '无');
  await buttons.get('邀请审阅')!();
  controls.find(control => control.placeholder === '每行一个审阅身份')!.value = 'reviewer-1\nreviewer-2\nreviewer-1';
  await buttons.get('保存审阅人')!();
  assert.deepEqual(requests.find(item => item.path === '/ontology/services/invite_scenario_reviewers')?.input,
    { id: scenarioId, revision: 2, reviewers: ['reviewer-1', 'reviewer-2'], _ontology: 'Eigos' });
  await buttons.get('同步正式数据')!();
  assert.deepEqual(requests.find(item => item.path === '/ontology/services/rebase_scenario')?.input,
    { id: scenarioId, revision: 3, _ontology: 'Eigos' });

  await workbench.renderObjects();
  controls.find(control => control.value === 'text')!.value = 'semantic';
  controls.find(control => control.placeholder === '语义索引名称')!.value = 'RouteMeaning';
  controls.find(control => control.placeholder === '搜索对象名称或属性值')!.value = 'rail';
  await buttons.get('查询')!();
  assert.deepEqual(requests.at(-1), {
    path: '/ontology/services/semantic_search',
    input: { name: 'RouteMeaning', text: 'rail', scenarioId, _ontology: 'Eigos' },
  });
  workbench.semanticDialog('Route');
  await buttons.get('检查索引')!();
  assert.equal(requests.at(-1)!.input.scenarioId, scenarioId);
  workbench.state.scenario = null;
  await buttons.get('查询')!();
  assert.equal(Object.hasOwn(requests.at(-1)!.input, 'scenarioId'), false);

  await workbench.renderRules();
  const rules = tables.find(table => table.headers[0] === '规则')!;
  assert.equal(rules.rows[0]![1], 'EventTrip');
  assert.equal(rules.rows[1]![1], 'EventTripStateLog · 任意 → authorized · 7200 秒');
  await buttons.get('停用')!();
  assert.deepEqual(requests.find(item => item.path === '/ontology/services/save_rule')?.input,
    { ...processRule, enabled:false, _ontology:'Eigos' });

  await workbench.renderProcesses();
  await tables.find(table => table.headers[0] === '方案')!.click!(0);
  assert.equal(tables.find(table => table.headers[1] === '字段')?.rows[0]?.[3], 'confirmed');
  await buttons.get('批准此版本')!();
  assert.deepEqual(requests.find(item => item.path === '/ontology/services/approve_scenario_review')?.input,
    { id: scenarioId, revision: 3, snapshot: 'review-snapshot', _ontology: 'Eigos' });
});

test('workbench serves guarded assets and normal HTTP model, media and SDK scenario operations',async()=>{
  const f=await fixture(),token='workbench-test-token-'.repeat(3);
  const config=readConfig({DATABASE_URL:process.env.EIGOS_TEST_DATABASE_URL,EIGOS_AUTH_MODE:'development',EIGOS_DEV_TOKEN:token});
  const server=createApp(config,f.db,f.source).app.listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));
  const address=server.address();assert(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
  const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
  try{
    const html=await fetch(base+'/workbench/');assert.equal(html.status,200);assert((await html.text()).includes('Ontology 工作台'));assert(html.headers.get('content-security-policy')?.includes("object-src 'none'"));
    assert.equal((await fetch(base+'/workbench/app.js')).status,200);
    assert.equal(html.headers.get('permissions-policy'),'geolocation=(self)');
    assert.equal((await fetch(base+'/workbench/task-location.js')).status,200);
    assert.equal((await fetch(base+'/ontology/media',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:modelFile})).status,401);
    const uploaded=await fetch(base+'/ontology/media',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/octet-stream','X-Asset-Name':'Triangle','X-Asset-Format':'stl'},body:modelFile});
    assert.equal(uploaded.status,200);const ref=await uploaded.json() as {type:string;id:string};
    const file=await fetch(base+'/ontology/media/'+ref.id,{headers});assert.equal(file.status,200);assert.deepEqual(Buffer.from(await file.arrayBuffer()),modelFile);
    const annotation=await fetch(base+'/ontology/actions',{method:'POST',headers,body:JSON.stringify({requestId:'measure',action:'AnnotateGeometry',input:{id:'measure',asset:ref,name:'Distance',note:'Test measurement',kind:'measurement',points:[[0,0,0],[3,4,0]]}})});
    assert.equal(annotation.status,200);
    assert.equal((await new Objects(f.db,f.model,f.access).read({type:'GeometryAnnotation',id:'measure'})).properties.distance,5);
    const client=new OntologyClient({baseUrl:base,token});
    assert((await client.describe()).objectTypes.some(type=>type.apiName==='OntologyScenario'));
    const session=await client.openSession(300),scenario=await client.createScenario({requestId:'sdk-temporary',name:'SDK temporary',kind:'temporary',sessionId:session.id});
    assert.equal((await scenario.inspect()).name,'SDK temporary');await client.service('close_scenario_session',{sessionId:session.id});await assert.rejects(scenario.inspect());
    assert.equal((await fetch(base + '/workbench/scenario-evaluation.js')).status, 200);
    assert.equal((await fetch(base + '/workbench/scenario-trial-form.js')).status, 200);
    const options = await client.service<{actions:string[]; functions:string[]}>('scenario_trial_options', {});
    assert(options.actions.includes('SaveScheduleActivity'));
    assert(options.functions.includes('validateSchedule'));
    assert(!options.actions.includes('CommitSchedulePlan'));
    assert(!options.functions.includes('SaveScheduleActivity'));
    const a = await client.createScenario({ requestId: 'sdk-compare-a', name: 'First' });
    const b = await client.createScenario({ requestId: 'sdk-compare-b', name: 'Second' });
    const comparison = await client.compareScenarios({ scenarios: [{ id: a.id, revision: 1 }, { id: b.id, revision: 1 }] });
    assert.deepEqual(comparison.scenarios.map(row => row.name), ['First', 'Second']);
    const list=await client.service<{items:unknown[]}>('workflows',{});assert.deepEqual(list.items,[]);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await f.close();}
});

test('media registration rejects invalid formats and incomplete measurements',async()=>{
  const f=await fixture();try{
    const app=new Applications(f.db);
    await assert.rejects(app.upload(f.access,f.model,f.capabilities.actions,Buffer.from('not a model'),{name:'bad',format:'glb'}),/GLB/);
    const ref=await app.upload(f.access,f.model,f.capabilities.actions,modelFile,{name:'triangle',format:'stl',units:'m'});
    await assert.rejects(f.capabilities.actions.apply(f.access,f.model,'AnnotateGeometry',{id:'bad',asset:ref,name:'Bad',note:'',kind:'measurement',points:[[0,0,0]]},'bad-measure'),/two positions/);
    await setGrants(f.db,'another',memberGrants(f.model));
    await assert.rejects(app.download(await Access.load(f.db,{owner:'another',scopes:principal.scopes}),f.model,ref.id),/unavailable/);
  }finally{await f.close();}
});

test('bundled domains exercise reusable metadata, nested coordinate search and derived counts',async()=>{
  const f=await fixture();try{
    assert(f.model.document.sharedProperties?.length);assert(f.model.document.valueTypes?.length);assert(f.model.document.structTypes?.length);
    const graph=new Objects(f.db,f.model,f.access),request={type:'RideRequest',id:'counted'};
    await graph.create(request,{id:request.id,name:'Counted',status:'requested',requestedAt:new Date().toISOString()});
    assert.equal((await graph.read(request)).properties.estimateCount,0);
    const result=await graph.query({type:'RideRequest',filter:{op:'eq',property:'estimateCount',value:0}});assert.equal(result.items.length,1);
    const views=new Applications(f.db);await views.saveView(f.access,f.model,{type:'RideRequest',title:'Inquiry',properties:['name','estimateCount'],links:['estimates'],actions:['EstimateRide'],revision:0});
    assert.deepEqual((await views.view(f.access,f.model,'RideRequest')).properties,['name','estimateCount']);
  }finally{await f.close();}
});

test('media bytes and registration are isolated by Ontology after source access is revoked',async()=>{
  const f=await fixture();try{
    const app=new Applications(f.db),asset=await app.upload(f.access,f.model,f.capabilities.actions,modelFile,{name:'Classified',format:'stl',units:'m'});
    await setGrants(f.db,'deployment',[{resource:'Eigos',permission:'manage_definition'},{resource:'Other',permission:'manage_definition'}]);
    const body=structuredClone(f.model.document);body.id='Other';
    const other=await f.metadata.publish(body,f.capabilities,await Access.load(f.db,{owner:'deployment',scopes:[]}));
    await setGrants(f.db,principal.owner,[...memberGrants(f.model),...memberGrants(other)]);
    await f.db.query(`INSERT INTO ${f.db.schema}.object_policies VALUES('Eigos','GeometryAsset',$1)`,[{read:{all:[{op:'equals',property:'name',value:'Allowed'}],any:[]},properties:{}}]);
    const access=await Access.load(f.db,principal);
    await assert.rejects(app.download(access,f.model,asset.id),/policy/);
    const input={id:asset.id,name:'Visible copy',format:'stl',contentHash:asset.id,byteLength:modelFile.length,units:'m'};
    await assert.rejects(f.capabilities.actions.apply(await Access.load(f.db,principal),other,'RegisterGeometry',input,'cross-ontology-hash'),/Uploaded model/);
    const uploaded=await app.upload(await Access.load(f.db,principal),other,f.capabilities.actions,modelFile,{name:'Visible copy',format:'stl',units:'m'});
    assert.equal(uploaded.id,asset.id);
    assert.deepEqual((await app.download(await Access.load(f.db,principal),other,asset.id)).bytes,modelFile);
  }finally{await f.close();}
});

test('content-addressed registrations survive publication and can be recreated after compensation',async()=>{
  const f=await fixture();try{
    const app=new Applications(f.db),metadata={name:'Reusable triangle',format:'stl',units:'m'};
    const ref=await app.upload(f.access,f.model,f.capabilities.actions,modelFile,metadata);
    const original=(await f.db.query(`SELECT request_id FROM ${f.db.schema}.actions WHERE owner=$1 AND action='RegisterGeometry' AND result->>'id'=$2`,[principal.owner,ref.id])).rows[0]!.request_id as string;
    await f.capabilities.actions.undo(f.access,f.model,original,'undo-upload');
    await assert.rejects(app.download(f.access,f.model,ref.id),/unavailable/);

    const action = f.model.action('RegisterGeometry');
    assert.equal(action.rules?.[0]?.op, 'createObject');
    assert.equal(action.submissionCriteria[0]?.function, 'verifyGeometryUpload');
    const scenarios = new Scenarios(f.db);
    const scene = await scenarios.create(f.access, f.model, { requestId: 'model-scene', name: 'Review geometry' });
    const view = await scenarios.view(f.access, f.model, scene.id);
    const params = { id: ref.id, contentHash: ref.id, byteLength: modelFile.length, ...metadata };
    await assert.rejects(f.capabilities.actions.apply(f.access, view, 'RegisterGeometry',
      { ...params, byteLength: 1 }, 'wrong-geometry-size'), /Uploaded model/);
    assert.deepEqual(await f.capabilities.actions.apply(f.access, view, 'RegisterGeometry', params, 'review-geometry'), ref);
    assert.equal((await new Objects(f.db, view, f.access).read(ref)).properties.contentHash, ref.id);
    await assert.rejects(app.download(f.access, f.model, ref.id), /unavailable/);

    assert.deepEqual(await app.upload(await Access.load(f.db,principal),f.model,f.capabilities.actions,modelFile,metadata),ref);
    assert.deepEqual((await app.download(await Access.load(f.db,principal),f.model,ref.id)).bytes,modelFile);
    assert.deepEqual(await app.upload(await Access.load(f.db,principal),f.model,f.capabilities.actions,modelFile,metadata),ref);
    assert.equal((await new Objects(f.db,f.model,await Access.load(f.db,principal)).query({type:'GeometryAsset'})).items.length,1);
    const body=structuredClone(f.model.document);body.version='next-upload-publication';
    const model=await f.metadata.publish(body,f.capabilities,f.publisher);
    assert.notEqual(model.release,f.model.release);
    assert.deepEqual(await app.upload(await Access.load(f.db,principal),model,f.capabilities.actions,modelFile,metadata),ref);
    assert.deepEqual((await app.download(await Access.load(f.db,principal),model,ref.id)).bytes,modelFile);
  }finally{await f.close();}
});

test('workbench account login preserves separate modeler and reviewer permissions', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const keys = await generateKeyPair('ES256');
  const jwks = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'workbench' }] });
  const audience = 'eigos-workbench-test', clientId = 'workbench-public-client';
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  let selected = '';
  const challenges = new Map<string, { subject: string; polled: boolean }>();
  const provider = express();
  provider.use(express.urlencoded({ extended: false }));
  const issuerServer = provider.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>(resolve => issuerServer.close(() => resolve())));
  await new Promise<void>(resolve => issuerServer.once('listening', resolve));
  const addr = issuerServer.address();
  assert(addr && typeof addr !== 'string');
  const issuer = 'http://127.0.0.1:' + addr.port + '/';
  const verify = jwtVerifier(issuer, audience, jwks);
  const sign = (subject: string) =>
    new SignJWT({ tenant_id: 'workbench-fixture', scope: 'ontology:read ontology:write',
      azp: subject === 'other-client' ? 'unrelated-client' : clientId })
      .setProtectedHeader({ alg: 'ES256', kid: 'workbench' }).setIssuer(issuer).setAudience(audience)
      .setSubject(subject).setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
  provider.post('/oauth/device/code', (req, res) => {
    assert.equal(req.body.client_id, clientId);
    assert.equal(req.body.audience, audience);
    assert(req.body.scope.split(' ').includes('ontology:read'));
    const deviceCode = 'device-' + challenges.size;
    challenges.set(deviceCode, { subject: selected, polled: false });
    res.json({ device_code: deviceCode, user_code: 'ABCD-WXYZ', verification_uri_complete: issuer + 'activate',
      expires_in: 180, interval: 5 });
  });
  provider.post('/oauth/token', async (req, res) => {
    const challenge = challenges.get(req.body.device_code);
    assert(challenge);
    assert.equal(req.body.client_id, clientId);
    assert.equal(req.body.grant_type, 'urn:ietf:params:oauth:grant-type:device_code');
    if (!challenge.polled) {
      challenge.polled = true;
      res.status(400).json({ error: 'slow_down' });
      return;
    }
    res.json({ access_token: await sign(challenge.subject), expires_in: 3600 });
  });
  const config = readConfig({
    DATABASE_URL: process.env.EIGOS_TEST_DATABASE_URL, EIGOS_AUTH_MODE: 'jwt',
    OAUTH_ISSUER: issuer, OAUTH_AUDIENCE: audience, OAUTH_JWKS_URL: issuer + 'jwks', OAUTH_WORKBENCH_CLIENT_ID: clientId,
  });
  const server = createApp(config, f.db, f.source, verify).app.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = 'http://127.0.0.1:' + address.port;
  assert.equal((await (await fetch(base + '/workbench/config')).json()).deviceLogin, true);
  const post = (path: string, body: unknown, headers = {}) => fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  async function login(subject: string) {
    selected = subject;
    const start = await post('/workbench/login/start', {});
    assert.equal(start.status, 200);
    assert.equal(start.headers.get('cache-control'), 'no-store');
    const cookie = start.headers.get('set-cookie')!;
    assert.match(cookie, /HttpOnly; SameSite=Strict/);
    const session = await start.json();
    assert.equal(session.expiresIn, 180);
    assert.equal(session.url, issuer + 'activate');
    const poll = () => post('/workbench/login/poll', { id: session.id }, { Cookie: cookie.split(';')[0]! });
    assert.equal((await post('/workbench/login/poll', { id: session.id })).status, 403);
    assert.equal((await poll()).status, 202);
    clock += 5001;
    const pending = await poll();
    assert.equal(pending.status, 202);
    assert.deepEqual(await pending.json(), { pending: true, interval: 10 });
    clock += 5001;
    assert.equal((await poll()).status, 202);
    clock += 5001;
    const finished = await poll();
    if (subject === 'other-client') {
      assert.equal(finished.status, 403);
      assert.equal((await finished.json()).accessToken, undefined);
      return '';
    }
    assert.equal(finished.status, 200);
    assert.equal(finished.headers.get('cache-control'), 'no-store');
    assert.equal((await poll()).status, 403);
    return (await finished.json()).accessToken as string;
  }
  const builderToken = await login('builder'), reviewerToken = await login('reviewer');
  await login('other-client');
  const who = async (token: string) => {
    const response = await fetch(base + '/identity', { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(response.status, 200);
    return (await response.json()).owner as string;
  };
  const builder = await who(builderToken), reviewer = await who(reviewerToken);
  assert.notEqual(builder, reviewer);
  const common = memberGrants(f.model);
  await setGrants(f.db, builder, [...common, { resource: 'Eigos', permission: 'edit_definition' }]);
  await setGrants(f.db, reviewer, [...common, { resource: 'Eigos', permission: 'manage_definition' }]);
  const builderClient = new OntologyClient({ baseUrl: base, token: builderToken });
  const reviewerClient = new OntologyClient({ baseUrl: base, token: reviewerToken });
  const draft = structuredClone(f.model.document);
  draft.objectTypes.find(type => type.apiName === 'Route')!.description = 'Reviewed in the workbench test';
  const branch = await builderClient.service<{id:string; revision:number}>('create_branch', {
    name: 'Workbench model proposal', ontology: 'Eigos', body: draft,
  });
  const prepared = await builderClient.service<{id:string; revision:number; release:string}>('prepare_branch', {
    id: branch.id, revision: branch.revision,
  });
  assert.equal((await f.metadata.active()).release, f.model.release);
  const review = { id: prepared.id, revision: prepared.revision, release: prepared.release };
  const denied = await post('/ontology/services/review_branch', review, { Authorization: 'Bearer ' + builderToken });
  assert.equal(denied.status, 403);
  const approved = await reviewerClient.service<{revision:number}>('review_branch', review);
  await reviewerClient.service('merge_branch', { ...review, revision: approved.revision });
  assert.equal((await f.metadata.active()).release, prepared.release);

  const scenario = await builderClient.createScenario({ name: 'Workbench Scenario', requestId: 'workbench-review' });
  const first = await scenario.inspect();
  assert.deepEqual(first.review, { reviewers: [], canInvite: true });
  await assert.rejects(reviewerClient.scenario(scenario.id).inspect(), /unavailable/);
  const invited = await scenario.inviteReviewers(first.revision, [reviewer]);
  const diff = await scenario.inspect();
  assert.equal(diff.revision, invited.revision);
  assert.deepEqual(diff.review, { reviewers: [reviewer], canInvite: true });
  await assert.rejects(scenario.rebase(first.revision), /changed/);
  assert.equal((await scenario.rebase(diff.revision)).revision, diff.revision);
  const offered = await reviewerClient.scenario(scenario.id).inspectReview();
  await reviewerClient.scenario(scenario.id).approveReview(offered.revision, offered.snapshot);
  assert.equal((await reviewerClient.pendingScenarioReviews()).items[0]?.approved, true);
});
