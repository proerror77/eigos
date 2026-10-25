import {readFileSync,existsSync} from 'node:fs';
import {AgentConnector,AgentConnectorError} from '../dist/packages/agent-client/client.js';

// Private per-installation credentials stay in AgentConnector. The Python PA
// client receives only the same-origin application response, never a bearer.
try {
  const [credentialPath,baseUrl]=process.argv.slice(2);
  if(!credentialPath || !baseUrl || !existsSync(credentialPath))throw new Error('Existing Agent credential file required');
  const raw=readFileSync(0);if(raw.length>1024*1024)throw new Error('Request too large');
  const request=JSON.parse(raw.toString('utf8'));
  if(!['GET','POST'].includes(request.method) || typeof request.path!=='string' || !/^\/(?:a2a|mcp|security\/context|ontology\/(?:describe|query|evaluate|check-access)|tasks(?:\/[0-9a-f-]+(?:\/(?:reply|cancel|authorize|reconcile|artifacts\/[0-9a-f-]+))?)?)$/.test(request.path))throw new Error('Unsupported application endpoint');
  const client=await AgentConnector.open({baseUrl,credentialPath,displayName:'EIGOS Personal Agent'});
  const response=await client.fetch(request.path,{method:request.method,headers:{Accept:'application/json','Content-Type':'application/json','A2A-Version':'1.0'},...(request.method==='POST'?{body:JSON.stringify(request.body)}:{}),signal:AbortSignal.timeout(30000)});
  let bytes=0;const chunks=[];
  if(response.body)for await(const chunk of response.body){bytes+=chunk.byteLength;if(bytes>8*1024*1024)throw new Error('Response too large');chunks.push(chunk);}
  const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  console.log(JSON.stringify({status:response.status,body}));
}catch(error){console.error(JSON.stringify({error:error instanceof AgentConnectorError?error.code:'agent_request_failed'}));process.exitCode=1;}
