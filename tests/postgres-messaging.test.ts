import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {securityFixture} from './fixtures/security.js';
import {importPostgresPrimaryFixture} from './fixtures/postgres-primary.js';
import {relayFixture} from './fixtures/relay.js';
import {ownerKey,type Principal} from '../packages/core/domain.js';
import {digest} from '../packages/core/delegation.js';
import {MESSAGING_SCOPES,MessagingError,type CommunicationGrant} from '../packages/agent-messaging/contracts.js';
import {AgentMessagingService} from '../packages/agent-messaging/service.js';
import {PostgresAgentMessagingService,postgresMessagingNodeId} from '../packages/postgres/messaging-service.js';
import {installPostgresMessagingStorage,assertPostgresMessagingStorageSchema,POSTGRES_MESSAGING_NODE_SCHEMA_V1} from '../packages/postgres/messaging-schema.js';
import {openPostgresRelayNode,PostgresRelayNodeStore,relayNodeWrappingKey,importPostgresRelayNodeSnapshot,postgresRelayNodeSnapshotDigest,validateRelayNodeSnapshot} from '../packages/postgres/relay-node-store.js';
import {readRelayNodeSnapshot} from '../packages/agent-transport/client.js';

const local={skip:process.env.EIGOS_TEST_PG_LOCAL!=='1'};
test('the protocol has no filesystem dependency and PG messaging excludes the legacy SQLite node and process execution',async()=>{
  const bundles=await Promise.all(['../packages/postgres/messaging-service.ts','../packages/agent-transport/async-client.ts'].map(path=>build({entryPoints:[fileURLToPath(new URL(path,import.meta.url))],bundle:true,write:false,metafile:true,platform:'browser',format:'esm',external:['node:*'],logLevel:'silent'})));
  for(const [index,result] of bundles.entries()){
    const imports=Object.values(result.metafile.outputs).flatMap(output=>output.imports.map(value=>value.path));
    for(const path of ['node:sqlite','node:child_process',...(index===1?['node:fs','node:fs/promises']:[])])assert(!imports.includes(path),`Durable Relay protocol cannot load ${path}`);
    assert(!Object.hasOwn(result.metafile.inputs,'packages/agent-transport/client.ts'));assert(!Object.hasOwn(result.metafile.inputs,'packages/relay/files.ts'));
  }
});

test('complete offline node export validates original encrypted receipts and refuses active/partial or changed identities',async()=>{
  const f=await relayFixture();try{
    const a=await f.client('offline-a'),b=await f.client('offline-b'),contact=await f.connect(a,b),sent=await a.send(b.agentId,contact,{text:'synthetic private migration canary'});
    await b.poll();b.retainInboxMessage(a.agentId,sent.id);assert(!JSON.stringify(a).includes('\"d\":'));
    await assert.rejects(readRelayNodeSnapshot({credentialPath:join(f.directory,'offline-a.json'),expectedAgentId:a.agentId}),/already open/);
    a.close();b.close();const snapshot=await readRelayNodeSnapshot({credentialPath:join(f.directory,'offline-a.json'),expectedAgentId:a.agentId}),expected={baseUrl:f.baseUrl,agentId:a.agentId,digest:digest(snapshot)};
    await validateRelayNodeSnapshot(snapshot,expected);assert.equal(snapshot.outbox.length,1);assert.equal(snapshot.outbox[0]!.receipt!.id,sent.id);
    await assert.rejects(validateRelayNodeSnapshot({...snapshot,outbox:[]},expected),/complete digest/);
    const forged=structuredClone(snapshot);forged.outbox[0]!.receipt!.digest='0'.repeat(64);await assert.rejects(validateRelayNodeSnapshot(forged,{...expected,digest:digest(forged)}),/receipt differs/);
    await assert.rejects(validateRelayNodeSnapshot(snapshot,{...expected,agentId:b.agentId}),/AGENT_IDENTITY_MISMATCH/);
    const source=new DatabaseSync(join(f.directory,'offline-a.json.sqlite'));try{source.exec('CREATE TABLE synthetic_unreviewed_node_state(value TEXT)');}finally{source.close();}
    await assert.rejects(readRelayNodeSnapshot({credentialPath:join(f.directory,'offline-a.json'),expectedAgentId:a.agentId}),/complete schema/);
  }finally{await f.close();}
});

async function fixture(legacy=false){
  const f=securityFixture(Date.now,{unified:true}),relay=await relayFixture();let target:Awaited<ReturnType<typeof importPostgresPrimaryFixture>>|undefined,service:PostgresAgentMessagingService|undefined;
  try{
    const sourceStore=f.jobs.createMessagingStore();
    const actor=(subject:string)=>{
      const p:Principal={...f.principal,subject,scopes:[...MESSAGING_SCOPES]},member=f.members.login(p);f.members.apply(member.id,{displayName:subject,locale:'en',timezone:'UTC',consent:true},false);f.members.authorize(p);
      const id=randomUUID(),credential='c'.repeat(43),token=`synthetic-communication-${randomUUID()}`;
      f.members.agents.create({registrationId:id,displayName:subject},credential);f.members.agents.bind(id,credential,p,member.id,token,Date.now()+3600000,Date.now(),true);
      return {p,member,id,token,owner:ownerKey(p)};
    };
    const a=actor('alice'),b=actor('bob'),sourceDirectory=join(f.directory,'original-communication-nodes');
    const enrollment={issueCommunication:async(_owner:string,_tenant:string,agentId:string,expiresAt:number)=>({accessToken:'fixture-owner',agentId,expiresAt})};
    let original:undefined|{ga:CommunicationGrant;gb:CommunicationGrant;request:{action:string;endpointId:string;text:string;requestId:string};sent:Record<string,any>;snapshots:Awaited<ReturnType<typeof readRelayNodeSnapshot>>[]};
    if(legacy){
      const old=new AgentMessagingService(sourceStore,f.members,{relayUrl:relay.baseUrl,nodeDirectory:sourceDirectory,enrollment,checkIdentity:facts=>f.jobs.security.identityGeneration(facts)});
      try{
        const approve=(value:typeof a)=>old.approve(value.member.id,{installationId:value.id,displayName:value.member.displayName,scopes:MESSAGING_SCOPES,visibility:'members',expiresAt:new Date(Date.now()+3600000).toISOString(),custodyConsent:true});
        const ga=approve(a),gb=approve(b),ia=old.identity(a.p,a.token),ib=old.identity(b.p,b.token),contact=await old.execute(ia,{action:'contact.request',endpointId:gb.id,requestId:randomUUID()}) as Record<string,any>;
        await old.execute(ib,{action:'contact.respond',contactId:contact.contactId,decision:'accept',requestId:randomUUID()});
        const request={action:'send',endpointId:gb.id,text:'legacy original ciphertext and metadata',requestId:randomUUID()},sent=await old.execute(ia,request) as Record<string,any>;await old.execute(ib,{action:'list'});await old.close();
        const grants=[sourceStore.grant(ga.id),sourceStore.grant(gb.id)],snapshots=[];
        for(const grant of grants)snapshots.push(await readRelayNodeSnapshot({credentialPath:join(sourceDirectory,grant.id+'.json'),expectedAgentId:grant.agentId!}));
        original={ga:grants[0]!,gb:grants[1]!,request,sent,snapshots};
      }finally{await old.close();}
    }
    target=await importPostgresPrimaryFixture(f);const t=target,q=`"${t.schema}"`;
    // Explicit migration administrator step, never service startup/request DDL.
    await t.database.run(client=>t.publisher.withManagement(client,()=>installPostgresMessagingStorage(client)));
    await t.database.run(client=>assertPostgresMessagingStorageSchema(client,t.schema));
    const wrappingKey=await relayNodeWrappingKey(randomBytes(32)),nodeImportDigests=new Map<string,string>(),expectedImports=new Map<string,{agentId:string;importDigest:string}>();
    if(original)for(const [index,snapshot] of original.snapshots.entries()){
      const grant=index?original.gb:original.ga,nodeId=postgresMessagingNodeId(grant.id),importDigest=digest(snapshot);nodeImportDigests.set(nodeId,importDigest);expectedImports.set(nodeId,{agentId:grant.agentId!,importDigest});
      await importPostgresRelayNodeSnapshot({database:t.database,publisher:t.publisher,nodeId,baseUrl:relay.baseUrl,wrappingKey,snapshot,expectedAgentId:grant.agentId!,expectedSnapshotDigest:importDigest});
    }
    const options={database:t.database,publisher:t.publisher,members:t.members,relayUrl:relay.baseUrl,wrappingKey,enrollment,nodeImportDigests};
    service=new PostgresAgentMessagingService(options);
    const approve=async(value:typeof a)=>service!.approve(value.member.id,{installationId:value.id,displayName:value.member.displayName,scopes:MESSAGING_SCOPES,visibility:'members',expiresAt:new Date(Date.now()+3600000).toISOString(),custodyConsent:true});
    const ga=original?.ga??await approve(a),gb=original?.gb??await approve(b),ia=await service.identity(a.p,a.token),ib=await service.identity(b.p,b.token);
    await service.assertNodeMigrations(expectedImports);
    const execute=async(identity:typeof ia,input:unknown)=>await service!.execute(identity,input) as Record<string,any>;
    const connect=async()=>{const contact=await execute(ia,{action:'contact.request',endpointId:gb.id,requestId:randomUUID()});await execute(ib,{action:'contact.respond',contactId:contact.contactId,decision:'accept',requestId:randomUUID()});return contact.contactId as string;};
    return {f,t,q,relay,a,b,ga,gb,ia,ib,options,wrappingKey,original,expectedImports,execute,connect,get service(){return service!;},restart:async()=>{await service!.close();service=new PostgresAgentMessagingService(options);return {ia:await service.identity(a.p,a.token),ib:await service.identity(b.p,b.token)};},
      close:async()=>{try{await service?.close();await t.close();}finally{f.close();await relay.close();}}};
  }catch(error){try{await service?.close();await target?.close();}finally{f.close();await relay.close();}throw error;}
}

test('actual legacy communication grants, original keys and retained messages migrate together without replacing the endpoint or request',local,async()=>{
  const x=await fixture(true);try{
    const original=x.original!;assert.equal((await x.service.assertNodeMigrations(x.expectedImports)).imported,2);
    await assert.rejects(x.service.assertNodeMigrations(new Map()),/complete source inventory/);
    const received=await x.execute(x.ib,{action:'read',messageId:original.sent.messageId});assert.equal(received.text,original.request.text);assert.equal(received.senderEndpointId,original.ga.id);
    const repeated=await x.execute(x.ia,original.request);assert.equal(repeated.messageId,original.sent.messageId);assert.equal(repeated.conversationId,original.sent.conversationId);
    assert.equal((await x.service.store.grant(original.ga.id)).agentId,original.ga.agentId);assert.equal((await x.service.store.grant(original.gb.id)).agentId,original.gb.agentId);
    for(const [nodeId,pin] of x.expectedImports){const state=await PostgresRelayNodeStore.verifyExisting({database:x.t.database,publisher:x.t.publisher,nodeId,baseUrl:x.relay.baseUrl,wrappingKey:x.wrappingKey,expectedAgentId:pin.agentId,expectedImportDigest:pin.importDigest});assert.equal(state.agentId,pin.agentId);}
  }finally{await x.close();}
});

test('actual PG messaging uses separate communication approval, encrypted durable Relay and original idempotent message/reply receipts',local,async()=>{
  const x=await fixture();try{
    assert.equal(Number((await x.t.client.query(`SELECT count(*) AS n FROM ${x.q}.security_grants`)).rows[0].n),0,'Communication must not issue or require task/source/Agent data grants');
    await assert.rejects(x.execute(x.ia,{action:'send',endpointId:x.gb.id,text:'no implicit contact',requestId:randomUUID()}),/CONTACT_REQUIRED/);
    await x.connect();const request={action:'send',endpointId:x.gb.id,text:'  PG private-canary communication\n',requestId:randomUUID()},sent=await x.execute(x.ia,request),again=await x.execute(x.ia,request);assert.equal(again.messageId,sent.messageId);
    await assert.rejects(x.execute(x.ia,{...request,text:'changed request'}),/CONFLICT/);
    const inbox=await x.execute(x.ib,{action:'list'});assert.equal(inbox.items.length,1);assert.equal(inbox.items[0].messageId,sent.messageId);
    const read=await x.execute(x.ib,{action:'read',messageId:sent.messageId});assert.equal(read.text,request.text);
    await x.execute(x.ib,{action:'mark_read',messageId:sent.messageId,requestId:randomUUID()});assert.equal((await x.execute(x.ia,{action:'status',messageId:sent.messageId})).state,'read');
    const reply=await x.execute(x.ib,{action:'reply',messageId:sent.messageId,text:'PG encrypted response',requestId:randomUUID()});assert.equal(reply.conversationId,sent.conversationId);assert.equal(reply.inReplyTo,sent.messageId);
    assert.equal((await x.execute(x.ia,{action:'status',messageId:sent.messageId})).state,'replied');
    const fresh=await x.restart();await x.execute(fresh.ia,{action:'list'});assert.equal((await x.execute(fresh.ia,{action:'read',messageId:reply.messageId})).text,'PG encrypted response');
    const metadata=JSON.stringify((await x.t.client.query(`SELECT body FROM ${x.q}.messaging_messages`)).rows),encrypted=JSON.stringify((await x.t.client.query(`SELECT envelope FROM ${x.q}.eigos_relay_node_outbox`)).rows);
    assert(!metadata.includes('private-canary'));assert(!encrypted.includes('private-canary'));
    const keys=(await x.t.client.query(`SELECT credentials FROM ${x.q}.eigos_relay_node_state`)).rows;assert.equal(keys.length,2);assert(keys.every(row=>!row.credentials.includes('"signingKey"')&&!row.credentials.includes('"d":')));
    assert.equal(Number((await x.t.client.query(`SELECT count(*) AS n FROM ${x.q}.jobs`)).rows[0].n),0,'Communication creates no business tasks');
  }finally{await x.close();}
});

test('actual PG messaging denies forged identity/scopes and revoked contacts, and restored membership cannot revive old communication permission',local,async()=>{
  const x=await fixture();try{
    await assert.rejects(x.execute({...x.ia},{action:'find'}),/MESSAGING_AUTHORIZATION_REQUIRED/);
    const onlyRead=await x.service.identity({...x.a.p,scopes:['messaging:read']},x.a.token);await assert.rejects(x.execute(onlyRead,{action:'send',endpointId:x.gb.id,text:'not approved by OAuth',requestId:randomUUID()}),/MESSAGING_AUTHORIZATION_REQUIRED/);
    const contact=await x.connect(),sent=await x.execute(x.ia,{action:'send',endpointId:x.gb.id,text:'old contact',requestId:randomUUID()});await x.execute(x.ib,{action:'list'});
    await x.execute(x.ib,{action:'contact.respond',contactId:contact,decision:'revoke',requestId:randomUUID()});await assert.rejects(x.execute(x.ib,{action:'read',messageId:sent.messageId}),/CONTACT_REQUIRED/);
    const connection=(await x.t.members.connections(x.a.member.id)).find(value=>value.clientId===x.a.p.clientId)!;
    const target={ownerKey:x.a.owner,kind:'connection' as const,targetId:x.a.p.clientId};
    await x.t.publisher.coordinate(target,()=>x.t.members.block(x.a.member.id,connection.id,true));await assert.rejects(x.execute(x.ia,{action:'find'}));
    await x.t.publisher.coordinate(target,()=>x.t.members.block(x.a.member.id,connection.id,false),true);
    const renewed=await x.service.identity(x.a.p,x.a.token);await assert.rejects(x.execute(renewed,{action:'find'}),/MESSAGING_AUTHORIZATION_REQUIRED/);
    await x.service.revoke(x.a.member.id,x.ga.id,x.ga.revision);await assert.rejects(x.service.revoke(x.a.member.id,x.ga.id,x.ga.revision),/CONFLICT/);
    await assert.rejects(x.service.approve(x.b.member.id,{installationId:x.a.id,displayName:'wrong member',scopes:MESSAGING_SCOPES,visibility:'private',expiresAt:new Date(Date.now()+3600000).toISOString(),custodyConsent:true}));
  }finally{await x.close();}
});

test('complete PG node import retains the original identity, paging cursors, exact ciphertext and receipts and supports independent readback',local,async()=>{
  const x=await fixture();try{
    const a=await x.relay.client('migration-old-a'),b=await x.relay.client('migration-old-b'),contact=await x.relay.connect(a,b),sent=await a.send(b.agentId,contact,{text:'synthetic imported original envelope'});await b.poll();b.retainInboxMessage(a.agentId,sent.id);a.close();b.close();
    const snapshots=await Promise.all([readRelayNodeSnapshot({credentialPath:join(x.relay.directory,'migration-old-a.json'),expectedAgentId:a.agentId}),readRelayNodeSnapshot({credentialPath:join(x.relay.directory,'migration-old-b.json'),expectedAgentId:b.agentId})]);
    const options=(index:number)=>({database:x.t.database,publisher:x.t.publisher,nodeId:`synthetic-old-node-${index}`,baseUrl:x.relay.baseUrl,wrappingKey:x.wrappingKey,expectedAgentId:index===0?a.agentId:b.agentId});
    for(const [index,snapshot] of snapshots.entries()){
      const expectedAgentId=index?b.agentId:a.agentId,args={...options(index),expectedAgentId,snapshot,expectedSnapshotDigest:digest(snapshot)};
      const result=await importPostgresRelayNodeSnapshot(args);assert.equal(result.status,'imported');assert.equal((await importPostgresRelayNodeSnapshot(args)).status,'already-imported');
      assert.equal((await postgresRelayNodeSnapshotDigest(args)).digest,args.expectedSnapshotDigest);
      const node=await openPostgresRelayNode({...args,displayName:'same original node',expectedImportDigest:args.expectedSnapshotDigest,createIfMissing:false,assertCurrent:()=>x.t.database.run(client=>x.t.publisher.withManagement(client,async()=>{}))});try{assert.equal(node.agentId,expectedAgentId);if(index===0)assert.equal((await node.outbox())[0]!.id,sent.id);else assert.deepEqual((await node.readRetainedMessage(a.agentId,sent.id)).content,{text:'synthetic imported original envelope'});}finally{await node.close();}
    }
    await assert.rejects(PostgresRelayNodeStore.open({...options(3),expectedAgentId:a.agentId,displayName:'must not replace old keys',createIfMissing:true}),/complete authorized credential/);
    const bad=await relayNodeWrappingKey(randomBytes(32));await assert.rejects(PostgresRelayNodeStore.open({...options(0),expectedAgentId:a.agentId,displayName:'bad host key',wrappingKey:bad}),/cannot be authenticated/);
    await assert.rejects(x.t.database.run(client=>client.query(`UPDATE ${x.q}.eigos_relay_node_outbox SET envelope='replacement' WHERE node_id='synthetic-old-node-0'`)),/Immutable Relay node history/);
    await assert.rejects(x.t.database.run(client=>client.query(`DELETE FROM ${x.q}.eigos_relay_node_state WHERE node_id='synthetic-old-node-0'`)),/Immutable Relay node history/);
  }finally{await x.close();}
});

test('PG messaging rejects incomplete metadata and the read-only schema reader rejects extra indexes and altered guards',local,async()=>{
  const x=await fixture();try{
    await x.service.prepareEndpoint(x.ga.id);const id=postgresMessagingNodeId(x.ga.id);
    await x.t.database.run(async client=>{await client.query(`CREATE INDEX synthetic_unreviewed_node_index ON ${x.q}.eigos_relay_node_outbox(recipient)`);});
    await assert.rejects(x.t.database.run(client=>assertPostgresMessagingStorageSchema(client,x.t.schema)),/index inventory/);
    await x.t.database.run(client=>client.query(`DROP INDEX ${x.q}.synthetic_unreviewed_node_index`));
    await x.t.database.run(client=>client.query(`ALTER TABLE ${x.q}.eigos_relay_node_inbox DISABLE TRIGGER eigos_relay_node_inbox_immutable`));
    await assert.rejects(x.t.database.run(client=>assertPostgresMessagingStorageSchema(client,x.t.schema)),/trigger/);
    await x.t.database.run(client=>client.query(`ALTER TABLE ${x.q}.eigos_relay_node_inbox ENABLE TRIGGER eigos_relay_node_inbox_immutable`));
    await x.t.database.run(async client=>{
      await assertPostgresMessagingStorageSchema(client,x.t.schema);
      await client.query('SET LOCAL search_path TO pg_catalog');
      await assertPostgresMessagingStorageSchema(client,x.t.schema);
      const expected=POSTGRES_MESSAGING_NODE_SCHEMA_V1.sequences.find(name=>name.includes('outbox'))!,other=POSTGRES_MESSAGING_NODE_SCHEMA_V1.sequences.find(name=>name.includes('inbox'))!;
      await client.query(`ALTER TABLE ${x.q}.eigos_relay_node_outbox ALTER COLUMN __eigos_rowid SET DEFAULT nextval('${x.t.schema}.${other}'::regclass)`);
      await assert.rejects(assertPostgresMessagingStorageSchema(client,x.t.schema),/default/);
      await client.query(`ALTER TABLE ${x.q}.eigos_relay_node_outbox ALTER COLUMN __eigos_rowid SET DEFAULT nextval('${x.t.schema}.${expected}'::regclass)`);
      await assertPostgresMessagingStorageSchema(client,x.t.schema);
    });
    const grant=(await x.t.client.query(`SELECT body FROM ${x.q}.messaging_grants WHERE id=$1`,[x.ga.id])).rows[0].body;
    await x.t.client.query(`UPDATE ${x.q}.messaging_grants SET body=$2 WHERE id=$1`,[x.ga.id,'{}']);await assert.rejects(x.execute(x.ia,{action:'find'}));
    await x.t.client.query(`UPDATE ${x.q}.messaging_grants SET body=$2 WHERE id=$1`,[x.ga.id,grant]);
    const before=Number((await x.t.client.query(`SELECT count(*) AS n FROM ${x.q}.messaging_requests`)).rows[0].n);
    await assert.rejects(x.service.store.prepare(x.ga.id,randomUUID(),{action:'synthetic'},()=>{throw new Error('abort complete metadata transaction');}),/abort complete/);
    assert.equal(Number((await x.t.client.query(`SELECT count(*) AS n FROM ${x.q}.messaging_requests`)).rows[0].n),before);
    assert.equal((await x.t.client.query(`SELECT agent_id FROM ${x.q}.eigos_relay_node_state WHERE node_id=$1`,[id])).rowCount,1);
  }finally{await x.close();}
});
