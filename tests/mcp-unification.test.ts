import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JobStore } from '../packages/core/store.js';
import { createExecutionCatalog } from '../packages/capabilities/catalog.js';
import { ONTOLOGY_READ_GUIDANCE, resolveOntologyMcpRead, parseMcpReadModule } from '../packages/ontology/mcp-read.js';
import { catalogReadDefinition } from '../packages/ontology/catalog-read-definition.js';
import { meituanReadDefinition } from '../packages/ontology/meituan-read-definition.js';
import { didiFixture } from './fixtures/didi.js';
import { meituanPrimitiveFixture } from './fixtures/meituan-agent.js';
import { owner } from './backend-fixture.js';

test('All configured vendor MCP programs use independent definitions and common planning guidance',()=>{
  const store=new JobStore(':memory:'),didi=didiFixture(),meituan=meituanPrimitiveFixture();let shopifyCalls=0;
  try{
    const catalog=createExecutionCatalog({store,didi:{...didi.binding,connector:didi.connector},meituan:meituan.reader,shopifyCatalog:{merchants:[{id:'fixture',name:'Synthetic merchant',shopId:'gid://shopify/Shop/123',domain:'fixture.myshopify.com'}],connector:{evidenceKind:'fixture',invoke:async()=>{shopifyCalls++;throw new Error('No constructor reads allowed');}}}});
    for(const ref of [{id:'ride.estimate.query',version:'1'},{id:'commerce.catalog.query',version:'2'},{id:'geo.search',version:'1'},{id:'address.book.read',version:'1'},{id:'delivery.quote',version:'2'}]){
      const program=catalog.agentProgram(ref,owner);assert(program);assert.equal(program.guidance,ONTOLOGY_READ_GUIDANCE);
      for(const id of program.actionIds){const definition=program.definition(store.ontology,id);assert(definition.read?.mcp);assert(definition.read.module?.digest);assert.equal(definition.read.effect,'read');}
      assert.deepEqual(catalog.bindings(ref,owner),[],'No eager legacy MCP adapter may be registered');
      assert.deepEqual(catalog.discoverySources(ref,owner),[],'No pre-model MCP discovery recipe may remain');
    }
    assert.equal(didi.calls.length,0);assert.equal(meituan.calls.length,0);assert.equal(shopifyCalls,0);
  }finally{store.close();didi.close();}
});

test('Nested catalog parameters are read from independent JSON with typed scalar preservation',()=>{
  const binding=catalogReadDefinition.actions.find(a=>a.id==='SearchPublicCatalog')!.mcp;
  const resolved=resolveOntologyMcpRead(binding,{query:'coffee',limit:2},{country:'US'},()=>assert.fail(),{merchant:{shopId:'gid://shopify/Shop/123'}});
  assert.deepEqual(resolved.args,{query:'coffee',context:{address_country:'US'},pagination:{limit:2},filters:{shops:['gid://shopify/Shop/123']}});
  assert.equal(resolved.tool,'search_catalog');
  const changed=structuredClone(catalogReadDefinition);changed.version='2';
  const pagination=changed.actions[0]!.mcp.arguments.pagination;assert(pagination);assert.equal(pagination.from,'object');
  if(pagination.from==='object')pagination.fields.limit={from:'literal',value:1};
  const next=parseMcpReadModule(changed).actions[0]!.mcp;
  assert.deepEqual(resolveOntologyMcpRead(next,{query:'coffee',limit:2},{country:'US'},()=>assert.fail(),{merchant:{shopId:'gid://shopify/Shop/123'}}).args.pagination,{limit:1});
});

test('Meituan service and category lookups come from ontology data, never a quote recipe',()=>{
  const binding=meituanReadDefinition.actions.find(a=>a.id==='EstimateMeituanDelivery')!.mcp;
  const source={address:'synthetic-only'};
  const resolve=(service:string,category:string)=>resolveOntologyMcpRead(binding,{}, {goodsName:'合成物品',weightKg:2,service,category},d=>d.name==='book'?{}:{address:source});
  assert.deepEqual(resolve('ordinary','文件').args.goods,{goodsName:'合成物品',goodsWeight:2,goodTypes:[4],goodTypeNames:['文件']});
  assert.equal(resolve('express','餐饮').args.service_type,'4033');
  assert.throws(()=>resolve('unsupported','文件'),/lookup value/);
});
