import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { fixture, principal } from './fixture.js';
import { createApp } from '../apps/gateway/app.js';
import { readConfig } from '../packages/core/config.js';
import { Objects } from '../packages/runtime/objects.js';
import { memberGrants, setGrants } from '../packages/runtime/access.js';

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
