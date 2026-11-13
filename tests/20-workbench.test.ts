import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fixture,principal} from './fixture.js';
import {createApp} from '../apps/gateway/app.js';
import {readConfig} from '../packages/core/config.js';
import {Applications} from '../packages/runtime/applications.js';
import {Objects} from '../packages/runtime/objects.js';
import {setGrants,memberGrants,Access} from '../packages/runtime/access.js';
import {OntologyClient} from '../packages/sdk/client.js';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const modelFile=Buffer.from('solid test\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid test\n');

test('workbench renders relationship conflicts and passes the selected Scenario to semantic reads', async () => {
  const buttons = new Map<string, () => Promise<void>>();
  const controls: { value: string; placeholder?: string }[] = [];
  const tables: { headers: string[]; rows: unknown[][]; click?: (index: number) => Promise<void> }[] = [];
  const requests: { path: string; input: Record<string, unknown> }[] = [];
  const node = () => ({ append() {}, replaceChildren() {} });
  const scenarioId = 'scenario-ui-fixture';
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
      requests.push({ path, input: { ...input } });
      if (path.startsWith('/ontology/scenarios?')) return { items: [{ id: scenarioId, name: 'Proposal' }] };
      if (path.startsWith('/ontology/scenarios/')) return {
        name: 'Proposal', revision: 2, objects: [],
        links: [
          { type: 'RequestRoute', from: { id: 'request' }, to: { id: 'route' }, removed: false, conflict: true },
          { type: 'RequestRoute', from: { id: 'resolved' }, to: { id: 'route' }, removed: true, conflict: false },
        ],
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
    request = uiRequest;
    ({ state, renderScenarios, renderObjects, semanticDialog });
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
