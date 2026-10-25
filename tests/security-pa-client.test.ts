import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {securityGatewayFixture} from './fixtures/security-gateway.js';

test('separate Python PA process uses v2 task identity and preserves denial without legacy fallback',async()=>{
  const f=await securityGatewayFixture(),run=promisify(execFile),script=resolve('integrations/grok/eigos-delegate/scripts/eigos_a2a.py');
  try {
    const a=f.install(),b=f.install();for(const x of [a,b]){await f.post('/members/security/grants',f.control(f.grantInput(x.id)),f.memberHeaders);f.qualify(x.id);}
    const config=join(f.directory,'pa.json'),tokenFile=join(f.directory,'bearer'),inputFile=join(f.directory,'input.json');writeFileSync(tokenFile,a.token,{mode:0o600});
    const cli=(...args:string[])=>run('python3',[script,'--config',config,...args],{timeout:30000,maxBuffer:1048576});
    await cli('configure','--card-url',f.base+'/.well-known/agent-card.json','--security-mode','foundation','--token-file',tokenFile,'--allow-loopback-http');
    const own=await f.post('/tasks',{service:'eigos.delegate',requestId:randomUUID(),goal:'Scoped independent PA input'},{authorization:'Bearer '+a.token});assert.equal(own.status,200);
    const task=JSON.parse((await cli('get','--task-id',own.value.id)).stdout);assert.equal(task.metadata.view,'eigos.task.v2');assert.ok(!('delegation' in task.metadata));
    writeFileSync(inputFile,JSON.stringify({object:{type:'ServiceRequest',id:own.value.id}}),{mode:0o600});
    const query=JSON.parse((await cli('query','--task-id',own.value.id,'--input-file',inputFile)).stdout);assert.equal(query.version,2);assert.equal(query.items[0].properties.originalGoal,'Scoped independent PA input');
    const other=await f.post('/tasks',{service:'eigos.delegate',requestId:randomUUID(),goal:'PRIVATE_OTHER_INSTALLATION'},{authorization:'Bearer '+b.token});
    await assert.rejects(cli('get','--task-id',other.value.id),error=>{assert.ok(!JSON.stringify(error).includes('PRIVATE_OTHER_INSTALLATION'));return true;});
    const before=readFileSync(config,'utf8');writeFileSync(tokenFile,'invalid',{mode:0o600});await assert.rejects(cli('configure','--card-url',f.base+'/.well-known/agent-card.json','--security-mode','foundation','--token-file',tokenFile,'--allow-loopback-http'));assert.equal(readFileSync(config,'utf8'),before);
    assert.ok(!readFileSync(config,'utf8').includes(a.token));
  }finally{await f.close();}
});
