import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { RelayStore } from '../packages/relay/store.js';
import { PostgresRelayStore } from '../packages/relay/postgres-store.js';
import { importRelaySnapshot } from '../packages/relay/postgres-import.js';
import { RelayClient, repointRelayClient } from '../packages/agent-transport/client.js';
import { createRelayApp } from '../apps/relay/app.js';
import { readRelayConfig } from '../apps/relay/config.js';

const digest = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const secretsDigest = (path: string) => { const c = JSON.parse(readFileSync(path,'utf8')); return digest(JSON.stringify([c.secret,c.signingKey,c.encryptionKey,c.signedCard,c.registrationId])); };
async function listen(store: RelayStore | PostgresRelayStore, path: string): Promise<{ server:Server; url:string; stop:()=>void }> {
  const server = createServer(); server.listen(0,'127.0.0.1'); await once(server,'listening');
  const address=server.address(); assert(address && typeof address !== 'string'); const url=`http://127.0.0.1:${address.port}`;
  const config=readRelayConfig({EIGOS_RELAY_AUTH_MODE:'development',EIGOS_RELAY_DEV_TOKEN:'x'.repeat(32),EIGOS_RELAY_PUBLIC_URL:url,EIGOS_RELAY_DATABASE_PATH:path});
  const app=createRelayApp(config,{store,verifyOwner:async()=>({issuer:'fixture',tenant:'test',subject:'owner'})});server.on('request',app.app);
  return {server,url,stop:app.stop};
}

test('offline Relay repoint preserves keys and queued messages, fails closed, and recovers a partial local update', { skip: process.env.EIGOS_TEST_PG_LOCAL !== '1' }, async () => {
  const dir=mkdtempSync(join(tmpdir(),'eigos-relay-repoint-')), source=join(dir,'relay.sqlite'), aPath=join(dir,'a.json'), bPath=join(dir,'b.json');
  const ca=process.env.EIGOS_TEST_PG_CA_FILE, ssl=ca?{ca:readFileSync(ca,'utf8'),rejectUnauthorized:true}:false;
  const pgClient=new pg.Client({ssl}), pool=new pg.Pool({ssl,max:4}); await pgClient.connect();
  const schema=`eigos_relay_repoint_${randomUUID().replaceAll('-','').slice(0,16)}`;
  let imported=false, oldServer:Awaited<ReturnType<typeof listen>>|undefined, targetServer:Awaited<ReturnType<typeof listen>>|undefined, oldStore:RelayStore|undefined, targetStore:PostgresRelayStore|undefined;
  try {
    oldStore=new RelayStore(source); oldServer=await listen(oldStore,source);
    const a=await RelayClient.open({baseUrl:oldServer.url,credentialPath:aPath,displayName:'A'}), b=await RelayClient.open({baseUrl:oldServer.url,credentialPath:bPath,displayName:'B'});
    const aId=a.agentId,bId=b.agentId,oldUrl=oldServer.url, messageId=randomUUID(),localMessageId=randomUUID();let contactId='';
    try { await a.register('synthetic-owner'); await b.register('synthetic-owner'); const contact=await a.requestContact(bId); contactId=contact.id; await b.respondContact(contact.id,'accept'); assert.equal((await a.send(bId,contact.id,{message:'local'},{id:localMessageId})).status,'queued'); assert.deepEqual((await b.poll()).map(item=>item.content),[{message:'local'}]); assert.equal((await a.send(bId,contact.id,{message:'retained'},{id:messageId})).status,'queued'); }
    finally { a.close();b.close();oldServer.stop();oldServer.server.close();await once(oldServer.server,'close');oldServer=undefined;oldStore.close();oldStore=undefined; }
    const sqlite=new DatabaseSync(source);sqlite.exec('PRAGMA journal_mode=DELETE');sqlite.close();
    const sourceDigest=digest(readFileSync(source)); await importRelaySnapshot(pgClient,source,schema,sourceDigest);imported=true;
    targetStore=new PostgresRelayStore(pool,schema);targetServer=await listen(targetStore,source);const newUrl=targetServer.url;
    const common={oldUrl,newUrl,targetSchema:schema,expectedSourceDigest:sourceDigest,targetDatabase:pgClient};
    const aSecrets=secretsDigest(aPath),bSecrets=secretsDigest(bPath);
    let sentCredentials=0;
    const countingFetch: typeof fetch = async (input,init) => { if(new Headers(init?.headers).has('Authorization')) sentCredentials++; return fetch(input,init); };
    await assert.rejects(repointRelayClient({...common,credentialPath:aPath,agentId:aId,fetch:countingFetch,verifyDestinationBinding:async()=>false}),/binding has not been verified/);
    assert.equal(sentCredentials,0);
    await assert.rejects(repointRelayClient({...common,credentialPath:aPath,agentId:aId,expectedSourceDigest:'0'.repeat(64),verifyDestinationBinding:async()=>true}),/receipt or node identity/);
    await assert.rejects(repointRelayClient({...common,credentialPath:aPath,agentId:aId,verifyDestinationBinding:async()=>true,fetch:async()=>new Response(JSON.stringify({signedCard:'wrong',state:'active',expiresAt:Date.now()+60000}))}),/health response is invalid/);
    const versionA=randomUUID(),versionB=randomUUID();
    const switchedFetch: typeof fetch = async (input,init) => { const response=await fetch(input,init);const headers=new Headers(response.headers);headers.set('X-EIGOS-Relay-Worker-Version',String(input).endsWith('/health')?versionA:versionB);return new Response(response.body,{status:response.status,statusText:response.statusText,headers}); };
    await assert.rejects(repointRelayClient({...common,credentialPath:aPath,agentId:aId,fetch:switchedFetch,verifyDestinationBinding:async()=>true}),/Worker version changed/);
    writeFileSync(aPath+'.repoint.tmp','unrelated',{mode:0o600});
    await assert.rejects(repointRelayClient({...common,credentialPath:aPath,agentId:aId,verifyDestinationBinding:async()=>true}),/Unrecognized Relay migration temporary file/);
    assert(existsSync(aPath+'.repoint.tmp'));unlinkSync(aPath+'.repoint.tmp');
    symlinkSync(join(dir,'missing'),aPath+'.repoint.tmp');
    await assert.rejects(repointRelayClient({...common,credentialPath:aPath,agentId:aId,verifyDestinationBinding:async()=>true}),/Unrecognized Relay migration temporary file/);
    assert(lstatSync(aPath+'.repoint.tmp').isSymbolicLink());unlinkSync(aPath+'.repoint.tmp');
    const original=readFileSync(aPath,'utf8'), changed=JSON.parse(original);changed.registrationId=randomUUID();const changedText=JSON.stringify(changed);
    await assert.rejects(repointRelayClient({...common,credentialPath:aPath,agentId:aId,verifyDestinationBinding:async()=>{writeFileSync(aPath,changedText);return true;}}),/credentials changed/);
    assert.equal(digest(readFileSync(aPath)),digest(changedText));writeFileSync(aPath,original);
    await assert.rejects(repointRelayClient({...common,credentialPath:aPath,agentId:aId,verifyDestinationBinding:async()=>{const d=new DatabaseSync(aPath+'.sqlite');d.prepare("UPDATE node_meta SET value='unrelated' WHERE key='identity'").run();d.close();return true;}}),/Node state changed/);
    const reset=new DatabaseSync(aPath+'.sqlite');assert.equal(reset.prepare("SELECT value FROM node_meta WHERE key='identity'").get()?.value,'unrelated');reset.prepare("UPDATE node_meta SET value=? WHERE key='identity'").run(JSON.stringify([oldUrl,aId]));reset.close();
    const stillOld=await RelayClient.open({baseUrl:oldUrl,credentialPath:aPath,displayName:'A'});
    await assert.rejects(repointRelayClient({...common,credentialPath:aPath,agentId:aId,verifyDestinationBinding:async()=>true}),/already open/);stillOld.close();
    const version = randomUUID();
    const fetchWithVersion: typeof fetch = async (input,init) => { const response=await fetch(input,init); const headers=new Headers(response.headers); headers.set('X-EIGOS-Relay-Worker-Version',version); return new Response(response.body,{status:response.status,statusText:response.statusText,headers}); };
    const bound=async (value:{origin:string;schema:string;sourceDigest:string;workerVersion:string|null})=>Object.isFrozen(value)&&value.origin===newUrl&&value.schema===schema&&value.sourceDigest===sourceDigest&&value.workerVersion===version;
    let bindingChecks=0;
    await assert.rejects(repointRelayClient({...common,credentialPath:aPath,agentId:aId,fetch:fetchWithVersion,verifyDestinationBinding:async value=>{bindingChecks++;return bindingChecks<=2&&await bound(value);}}),/binding has not been verified/);
    assert.equal(bindingChecks,3);
    await assert.rejects(RelayClient.open({baseUrl:newUrl,credentialPath:aPath,displayName:'A'}),/migration requires recovery/);
    assert.deepEqual(await repointRelayClient({...common,credentialPath:aPath,agentId:aId,fetch:fetchWithVersion,verifyDestinationBinding:bound}),{status:'migrated',recovered:true});
    assert.deepEqual(await repointRelayClient({...common,credentialPath:aPath,agentId:aId,fetch:fetchWithVersion,verifyDestinationBinding:bound}),{status:'already-migrated',recovered:false});
    const bState=new DatabaseSync(bPath+'.sqlite');bState.prepare("UPDATE node_meta SET value=? WHERE key='identity'").run(JSON.stringify([newUrl,bId]));bState.close();
    const staged=JSON.parse(readFileSync(bPath,'utf8'));staged.baseUrl=newUrl;writeFileSync(bPath+'.repoint.tmp',JSON.stringify(staged),{mode:0o600});
    const changing = {...common,credentialPath:bPath,agentId:bId,fetch:fetchWithVersion,verifyDestinationBinding:bound};
    changing.verifyDestinationBinding = async value => { const ok=await bound(value);changing.targetSchema='invalid\"; DROP SCHEMA public';changing.expectedSourceDigest='0'.repeat(64);changing.newUrl='https://attacker.invalid';changing.agentId=aId;changing.fetch=async()=>new Response('bad',{status:500});changing.verifyDestinationBinding=async()=>false;return ok; };
    assert.deepEqual(await repointRelayClient(changing),{status:'migrated',recovered:true});
    assert(!existsSync(bPath+'.repoint.tmp'));
    assert.equal(secretsDigest(aPath),aSecrets);assert.equal(secretsDigest(bPath),bSecrets);
    const newA=await RelayClient.open({baseUrl:newUrl,credentialPath:aPath,displayName:'A'}),newB=await RelayClient.open({baseUrl:newUrl,credentialPath:bPath,displayName:'B'});
    try { assert.deepEqual((await newB.poll()).map(item=>item.content),[{message:'local'},{message:'retained'}]);assert.equal((await newA.receipt(aId,messageId)).status,'received');newB.markHandled(aId,localMessageId);newB.markHandled(aId,messageId);assert.equal((await newA.deliver(messageId)).id,messageId); assert.deepEqual(await newB.poll(),[]);assert.equal((await pgClient.query(`SELECT count(*)::int AS n FROM "${schema}".relay_messages WHERE id=$1`,[messageId])).rows[0].n,1);await newB.respondContact(contactId,'revoke');await assert.rejects(newA.send(bId,contactId,{message:'after-revoke'}),/CONTACT_NOT_ACCEPTED/); }
    finally {newA.close();newB.close();}
  } finally {
    if(oldServer){oldServer.stop();oldServer.server.close();await once(oldServer.server,'close');}oldStore?.close();
    if(targetServer){targetServer.stop();targetServer.server.close();await once(targetServer.server,'close');}if(targetStore)await targetStore.close();else await pool.end();
    if(imported)await pgClient.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await pgClient.end();rmSync(dir,{recursive:true,force:true});
  }
});
