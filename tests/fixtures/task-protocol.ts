import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { jsonRpcHandler } from '@a2a-js/sdk/server/express';
import { AgentUser, A2AGateway, agentCard } from '../../apps/gateway/a2a.js';
import { createMcpServer } from '../../apps/gateway/mcp.js';
import type { TaskServicePort } from '../../packages/core/task-service-port.js';
import { readConfig } from '../../packages/core/config.js';
import type { Job, Principal } from '../../packages/core/domain.js';

/** Loopback protocol fixture with an explicitly supplied authenticated context.
 * Identity/token verification itself is covered by the production app tests. */
export async function taskProtocolFixture(tasks:TaskServicePort,principal:Principal) {
  const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert(address && typeof address!=='string');
  const base=`http://127.0.0.1:${address.port}`;
  const config=readConfig({EIGOS_AUTH_MODE:'development',EIGOS_DEV_TOKEN:'task-protocol-fixture-only-'.repeat(3),PUBLIC_URL:base,PORT:String(address.port),DATABASE_PATH:':memory:'});
  config.EIGOS_SECURITY_MODE=tasks.secured?'foundation':'legacy';
  const app=createMcpExpressApp({host:'127.0.0.1'});
  const handler=createMcpHandler(()=>createMcpServer(tasks,principal),{legacy:'stateless',maxSubscriptions:0});
  const http=toNodeHandler(handler);
  app.all('/mcp',async(req,res)=>{await http(req,res,req.body);});
  const gateway=new A2AGateway(tasks,agentCard(config,tasks.services()));
  app.use('/a2a',jsonRpcHandler({requestHandler:gateway,userBuilder:async()=>new AgentUser(principal)}));
  server.on('request',app);
  const client=new Client({name:'task-protocol-fixture',version:'1'});
  const close=async()=>{await client.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await handler.close();};
  try {await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp')));}
  catch(error){await close();throw error;}
  const call=(name:string,args:Record<string,unknown>)=>client.callTool({name,arguments:args});
  return {base,call,
    rpc:async(method:string,params:object)=>{
      const response=await fetch(base+'/a2a',{method:'POST',headers:{'Content-Type':'application/json','A2A-Version':'1.0'},
        body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method,params})});
      assert.equal(response.status,200);return response.json();
    },
    job:async(name:string,args:Record<string,unknown>)=>{
      const result=await call(name,args);assert(!result.isError,JSON.stringify(result));return(result.structuredContent as {result:Job}).result;
    },close};
}
