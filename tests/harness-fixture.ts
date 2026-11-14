import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HarnessAgent } from '../packages/runtime/harness.js';

/** Synthetic model decisions, sent through the production Harness MCP transport. */
export async function harnessFixture() {
  const directory=await mkdtemp(join(tmpdir(),'eigos-harness-fixture-'));
  const binary=join(directory,'model.mjs'), credentialFile=join(directory,'credential.json');
  const payload=Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url');
  await writeFile(credentialFile,JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:`fixture.${payload}.unsigned`}}),{mode:0o600});
  await writeFile(binary,`#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Client, StreamableHTTPClientTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/client'))};
const patch=JSON.parse(await readFile(process.argv[process.argv.indexOf('--patch')+1],'utf8'));
const config=patch.flatMap(item=>item.insert??[]).find(item=>item.id==='eigos-ontology').config;
for await(const line of createInterface({input:process.stdin})) {
 const packet=JSON.parse(line);let result={};
 try {
  if(packet.method==='initialize') result={serverInfo:{name:'deepseek-harness-sdk-runtime'}};
  if(packet.method==='session/prompt') {
   const client=new Client({name:'synthetic-model',version:'1'});
   await client.connect(new StreamableHTTPClientTransport(new URL(config.url),{requestInit:{headers:config.headers}}));
   const call=async(name,args)=>{const response=await client.callTool({name,arguments:args});if(response.isError)throw new Error(JSON.stringify(response));return JSON.parse(response.content[0].text);};
   const catalogue=await call('describe_ontology',{});
   if(!catalogue.objects.some(type=>type.apiName==='SchedulePlanStateLog'))throw new Error('Process log missing from Ontology discovery');
   const task=JSON.parse(packet.params.contentBlocks[0].text.split('\\n').at(-1));
   if(task.userRequest.route) {
    await call('complete_with_action',{action:{interface:{type:'RideInquiry',implementation:'RideRequest',action:'estimate'},input:task.userRequest.route},read:{function:'readRideEstimates',resultParameter:'request'}});
   } else {
    const input=JSON.parse(task.userRequest.message).planning;
    const plan=await call('apply_action',{interface:{type:'SchedulablePlan',implementation:'SchedulePlan',action:'prepare'},input});
    if(!plan.waitingForPA) {
     const scene=await call('create_scenario',{requestId:'harness-scenario',name:'MCP scheduling proposal'});
     const found=await call('evaluate_function',{scenarioId:scene.id,function:'findScheduleSlots',input:{plan}});
     await call('apply_action',{scenarioId:scene.id,action:'SaveScheduleActivity',input:{plan,id:'meeting',name:'MCP meeting',...found.slots[0]}});
     const logs=await call('query_ontology',{scenarioId:scene.id,queries:[{type:'SchedulePlanStateLog',where:{processId:plan.id}}]});
     if(logs[0].items.length!==1||logs[0].items[0].properties.newState!=='prepared')throw new Error('Scenario leaked proposed transitions');
     await call('complete_with_function',{scenarioId:scene.id,function:'readSchedulePlan',input:{plan}});
    }
   }
   await client.close();
  }
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:packet.id,result})+'\\n');
 } catch(error) {process.stderr.write(String(error));process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:packet.id,error:{code:-32000,message:String(error)}})+'\\n');}
}
`,{mode:0o700});
  return {driver:new HarnessAgent({binary,credentialFile,model:'synthetic-mcp-decisions',reasoningEffort:'low'}),
    close:()=>rm(directory,{recursive:true,force:true})};
}
