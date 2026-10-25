import {parseArgs} from 'node:util';
import {readFileSync} from 'node:fs';
import {AgentConnector,AgentConnectorError} from '../dist/packages/agent-client/client.js';

// Device authorization is completed by the human at the configured provider.
// Each installation keeps its own rotating credential file; no token is printed.
try {
  const {positionals,values}=parseArgs({allowPositionals:true,options:{base:{type:'string'},credentials:{type:'string'},name:{type:'string'},profile:{type:'string'}}});
  const [command]=positionals;
  if(positionals.length!==1 || !['begin','finish','status','join'].includes(command) || !values.base || !values.credentials)throw new Error('Use begin, finish, status or join with base and credentials');
  const client=await AgentConnector.open({baseUrl:values.base,credentialPath:values.credentials,displayName:values.name??'EIGOS Personal Agent'});
  let result;
  if(command==='begin')result=await client.beginAuthorization();
  else if(command==='finish')result=await client.finishAuthorization();
  else if(command==='join') {
    if(!values.profile)throw new Error('Join requires an explicit member profile with consent');
    const raw=readFileSync(values.profile);if(raw.length>64000)throw new Error('Profile too large');const {consent,...profile}=JSON.parse(raw.toString('utf8'));if(consent!==true)throw new Error('Membership consent is required');
    result=await client.registerMembership(profile,true);
  }else result=await client.status();
  console.log(JSON.stringify({registrationId:client.registrationId,...result}));
}catch(error){console.error(JSON.stringify({error:error instanceof AgentConnectorError?error.code:'agent_enrollment_failed'}));process.exitCode=1;}
