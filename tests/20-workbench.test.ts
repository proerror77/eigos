import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fixture,principal} from './fixture.js';
import {createApp} from '../apps/gateway/app.js';
import {readConfig} from '../packages/core/config.js';
import {Applications} from '../packages/runtime/applications.js';
import {Objects} from '../packages/runtime/objects.js';
import {setGrants,memberGrants,Access} from '../packages/runtime/access.js';
import {OntologyClient} from '../packages/sdk/client.js';

const modelFile=Buffer.from('solid test\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid test\n');

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
