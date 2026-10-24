import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createMeituanPrimitiveServer } from '../packages/capabilities/meituan-mcp.js';
import { digest } from '../packages/core/delegation.js';
import { LocalMeituanPrimitives } from '../packages/capabilities/meituan-primitives.js';
import { meituanPrimitiveFixture } from './fixtures/meituan-agent.js';

test('Meituan MCP exposes only four atomic read tools and the independent module definition', async () => {
  const f = meituanPrimitiveFixture(), server = createMeituanPrimitiveServer(f.reader), client = new Client({ name: 'fixture', version: '1' });
  const [a,b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  try {
    const tools = await client.listTools(); assert.deepEqual(tools.tools.map(t => t.name).sort(), ['ontology_module','search_poi','get_address_list','get_address_info','delivery_preview'].sort());
    assert(tools.tools.every(t => t.annotations?.readOnlyHint === true));
    const definition = await client.callTool({ name: 'ontology_module', arguments: {} }); assert(!definition.isError); assert.equal(f.calls.length, 0);
    for (const name of ['submit_order','create_order','pay','cancel_order','confirm_auth']) await client.callTool({ name, arguments: {} }).then(result => assert(result.isError), () => {});
    assert.equal(f.calls.length, 0);
    await client.callTool({ name: 'get_address_list', arguments: {} }); assert.deepEqual(f.calls.map(c=>c.tool), ['get_address_list']);
    await client.callTool({ name: 'get_address_info', arguments: { address_id: 'private-a' } }); assert.deepEqual(f.calls.map(c=>c.tool), ['get_address_list','get_address_info']);
    const invalid = await client.callTool({ name:'get_address_info',arguments:{address_id:'private-a',pay:true} }); assert(invalid.isError); assert.equal(f.calls.length,2);
  } finally { await client.close(); await server.close(); }
});

test('The actual CLI bridge issues one business command per read and never hydrates a quote implicitly', async () => {
  const directory = mkdtempSync(join(tmpdir(),'eigos-atomic-cli-')), log = join(directory,'calls.jsonl'), oldPath=process.env.PATH;
  const sender={address:'合成甲',houseNumber:'1',lat:31.1,lng:121.1,name:'甲',cityId:1,phone:'13800001111'},recipient={...sender,address:'合成乙',lat:31.2};
  try {
    writeFileSync(join(directory,'pt-passport'), '#!'+process.execPath+'\nprocess.stdout.write("synthetic-cli-token")\n',{mode:0o700});
    writeFileSync(join(directory,'paotui.js'), `const fs=require('fs');const tool=process.argv[2];fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({tool,args:process.argv.slice(3)})+'\\n');const value=tool==='get_address_list'?{addresses:[]}:tool==='get_address_info'?{phone:'13800001111'}:tool==='search_poi'?{pois:[{name:'合成公开地点',address:'合成地址',city:'北京市'}]}:{_previewTotal:'12.50',_deliveryFee:'12.50'};console.log(JSON.stringify({status:'ok',...value}));`);
    process.env.PATH=directory+':'+oldPath;
    const reader=new LocalMeituanPrimitives(directory), signal=AbortSignal.timeout(10000);
    await assert.rejects(reader.invoke('create_order',{},signal)); assert.throws(()=>readFileSync(log));
    await reader.invoke('delivery_preview',{sender,recipient,goods:{goodsName:'文件',goodsWeight:1,goodTypes:[4],goodTypeNames:['文件']},business_type:1,service_type:'1003'},signal);
    assert.deepEqual(readFileSync(log,'utf8').trim().split('\n').map(x=>JSON.parse(x).tool),['delivery_preview']);
    await reader.invoke('get_address_info',{address_id:'private-a'},signal);
    const calls=readFileSync(log,'utf8').trim().split('\n').map(x=>JSON.parse(x));assert.deepEqual(calls.map(c=>c.tool),['delivery_preview','get_address_info']);assert.deepEqual(calls[1].args,['--address-id','private-a']);
    await assert.rejects(reader.invoke('get_address_info',{address_id:'private-a'},signal,{accountBinding:digest('different-token-context')}));
    assert.equal(readFileSync(log,'utf8').trim().split('\n').length,2,'Account mismatch must fail before a business CLI call');
  } finally { if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;rmSync(directory,{recursive:true,force:true}); }
});
