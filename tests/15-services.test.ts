import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { fixture, principal } from './fixture.js';
import { createApp } from '../apps/gateway/app.js';
import { readConfig } from '../packages/core/config.js';
import { Objects } from '../packages/runtime/objects.js';
import { memberGrants, setGrants } from '../packages/runtime/access.js';
import { createCapabilities } from '../packages/capabilities/index.js';
import { Scenarios } from '../packages/runtime/scenarios.js';
import { SemanticSearch } from '../packages/runtime/semantic.js';
import type { VersionedFunction } from '../packages/runtime/functions.js';

test('HTTP and MCP expose object sets, materialization, history and reviewed definitions', async()=>{
  const f=await fixture(),token='synthetic-service-token-'.repeat(3);
  const config=readConfig({DATABASE_URL:process.env.EIGOS_TEST_DATABASE_URL,EIGOS_AUTH_MODE:'development',EIGOS_DEV_TOKEN:token});
  const app=createApp(config,f.db,f.source), server=app.app.listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));
  const address=server.address();assert(address&&typeof address!=='string');
  const url=`http://127.0.0.1:${address.port}`;
  const client=new Client({name:'ontology-client',version:'1'});
  try{
    const ref={type:'Route',id:'gateway-route'};
    await new Objects(f.db,f.model,f.access).create(ref,{id:ref.id,name:'Gateway route'});
    await client.connect(new StreamableHTTPClientTransport(new URL(url+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
    const tools=await client.listTools();assert(tools.tools.some(tool=>tool.name==='ontology_aggregate_set'));
    const call=async(name:string,input:Record<string,unknown>)=>{
      const response=await client.callTool({name:'ontology_'+name,arguments:input});assert(!response.isError,JSON.stringify(response));
      return JSON.parse((response.content as {text:string}[])[0]!.text);
    };
    const set={op:'query',query:{type:'Route'}};
    const saved=await call('save_set',{requestId:'gateway-set',name:'Routes',mode:'dynamic',set});
    assert(saved.id);
    const aggregate=await call('aggregate_set',{set,metrics:{total:{op:'count'}}});assert(JSON.stringify(aggregate).includes('1'));
    const snapshot=await call('materialize',{requestId:'gateway-materialize',name:'Routes',types:['Route']});
    assert.equal((await call('read_materialization',{id:snapshot.id})).items.length,1);
    assert.equal((await call('edit_history',{object:ref})).items.length,1);
    const denied=await fetch(url+'/ontology/services/create_branch',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({ontology:'Eigos',name:'Denied'})});
    assert.equal(denied.status,403);
    await setGrants(f.db,principal.owner,[...memberGrants(f.model),{resource:'Eigos',permission:'manage_definition'}]);
    const branch=await call('create_branch',{ontology:'Eigos',name:'Reviewed definition'});
    assert.equal(branch.state,'draft');
    const prepared=await call('prepare_branch',{id:branch.id,revision:branch.revision});
    assert(prepared.candidate||prepared.release);
    assert((await call('function_versions',{})).length>0);
  }finally{await client.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await f.close();}
});

test('HTTP and MCP semantic reads use the selected Scenario and reject closed or foreign views', async () => {
  const f = await fixture(), token = 'synthetic-semantic-token-'.repeat(3);
  const config = readConfig({
    DATABASE_URL: process.env.EIGOS_TEST_DATABASE_URL,
    EIGOS_AUTH_MODE: 'development',
    EIGOS_DEV_TOKEN: token,
  });
  const embedding: VersionedFunction = {
    definition: {
      apiName: 'EmbedRouteFixture', description: 'Deterministic route embedding for protocol tests', version: '1',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      returns: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
    },
    implementationId: 'embed-route-fixture-1',
    handler: ({ text }) => text === 'rail' ? [1, 0] : [0, 1],
  };
  const extensions = { functions: [embedding] };
  const server = createApp(config, f.db, f.source, undefined, extensions).app.listen(0, '127.0.0.1');
  const client = new Client({ name: 'semantic-client', version: '1' });
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    const url = 'http://127.0.0.1:' + address.port;
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    const doc = structuredClone(f.model.document);
    doc.functionTypes.push(embedding.definition);
    const capabilities = createCapabilities(f.db, f.source, extensions);
    const model = await f.metadata.publish(doc, capabilities, f.publisher);
    await setGrants(f.db, principal.owner, memberGrants(model));
    const live = new Objects(f.db, model, f.access);
    const edited = { type: 'Route', id: 'edited-route' };
    const removed = { type: 'Route', id: 'removed-route' };
    const untouched = { type: 'Route', id: 'untouched-route' };
    for (const ref of [edited, removed, untouched]) {
      await live.create(ref, { id: ref.id, name: ref === untouched ? 'street' : 'rail' });
    }
    const semantic = new SemanticSearch(f.db, capabilities.functions);
    const name = 'RouteMeaning';
    await semantic.configure(f.publisher, model, { name, type: 'Route', property: 'name', embeddingFunction: embedding.definition.apiName, dimensions: 2 });
    await semantic.index(f.access, model, { name, objects: [edited, removed, untouched] });

    const scenarios = new Scenarios(f.db);
    const { id: scenarioId } = await scenarios.create(f.access, model, { requestId: 'semantic-scope', name: 'Draft route changes' });
    const proposed = new Objects(f.db, await scenarios.view(f.access, model, scenarioId), f.access);
    await proposed.edit(edited, 1, { name: 'renamed in draft' });
    await proposed.remove(removed, 1);
    const search = { name, text: 'rail' };
    const post = (service: string, input: object) => fetch(url + '/ontology/services/' + service, {
      method: 'POST', headers, body: JSON.stringify(input),
    });
    const refs = (result: { items: { object: { ref: typeof edited } }[] }) =>
      result.items.map(item => item.object.ref.id).sort();
    const liveResponse = await post('semantic_search', search);
    assert.equal(liveResponse.status, 200);
    assert.deepEqual(refs(await liveResponse.json()), [edited.id, removed.id, untouched.id]);
    const scopedResponse = await post('semantic_search', { ...search, scenarioId });
    assert.equal(scopedResponse.status, 200, await scopedResponse.clone().text());
    assert.deepEqual(refs(await scopedResponse.json()), [untouched.id]);

    await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers } }));
    const call = async (service: string, input: Record<string, unknown>) => {
      const response = await client.callTool({ name: 'ontology_' + service, arguments: input });
      assert(!response.isError, JSON.stringify(response));
      return JSON.parse((response.content as { text: string }[])[0]!.text);
    };
    assert.deepEqual(refs(await call('semantic_search', { ...search, scenarioId })), [untouched.id]);
    assert.equal((await call('semantic_status', { name, scenarioId })).currentAuthorizedObjects, 1);
    assert.equal((await call('semantic_status', { name })).currentAuthorizedObjects, 3);
    const other = await scenarios.create(f.publisher, model, { requestId: 'foreign-semantic-scope', name: 'Foreign scenario' });
    assert.equal((await post('semantic_search', { ...search, scenarioId: other.id })).status, 404);
    const diff = await scenarios.inspect(f.access, model, scenarioId);
    await scenarios.discard(f.access, model, scenarioId, diff.revision);
    assert.equal((await post('semantic_search', { ...search, scenarioId })).status, 409);
  } finally {
    await client.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await f.close();
  }
});
