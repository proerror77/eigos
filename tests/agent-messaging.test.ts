import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { relayFixture } from './fixtures/relay.js';
import { MemberStore } from '../packages/members/store.js';
import { MessagingStore } from '../packages/agent-messaging/store.js';
import { AgentMessagingService } from '../packages/agent-messaging/service.js';
import { MESSAGING_SCOPES, type MessagingIdentity } from '../packages/agent-messaging/contracts.js';
import { ownerKey, type Principal } from '../packages/core/domain.js';
import { RelayClient } from '../packages/agent-transport/client.js';

async function fixture(fetcher?: typeof fetch) {
  const relay = await relayFixture(), db = new DatabaseSync(join(relay.directory, 'authority.sqlite'));
  const members = new MemberStore(join(relay.directory, 'members.sqlite')), store = new MessagingStore(db);
  const options = { relayUrl: relay.baseUrl, nodeDirectory: join(relay.directory, 'nodes'),
    enrollment: { issueCommunication: async (_owner: string, _tenant: string, agentId: string, expiresAt: number) => ({ accessToken: 'fixture-owner', agentId, expiresAt }) }, ...(fetcher ? { fetch: fetcher } : {}) };
  let service = new AgentMessagingService(store, members, options);
  function actor(subject: string, tenant = 'fixture') {
    const p: Principal = { issuer: 'https://fixture.example', tenant, subject, clientId: 'connector', scopes: [...MESSAGING_SCOPES] };
    const member = members.login(p); members.apply(member.id, { displayName: subject, locale: 'en', timezone: 'UTC', consent: true }, false); members.authorize(p);
    const id = randomUUID(), credential = 'c'.repeat(43), token = 'token-' + randomUUID();
    members.agents.create({ registrationId: id, displayName: subject + ' PA' }, credential);
    members.agents.bind(id, credential, p, member.id, token, Date.now() + 600000, Date.now(), true);
    const identity = service.identity(p, token);
    const grant = service.approve(member.id, { installationId: id, displayName: subject + ' PA', scopes: MESSAGING_SCOPES,
      visibility: 'members', expiresAt: new Date(Date.now() + 3600000).toISOString(), custodyConsent: true });
    return { p, member, id, token, identity, grant };
  }
  const a = actor('Alice'), b = actor('Bob');
  const execute = async (identity: MessagingIdentity, input: unknown) => await service.execute(identity, input) as Record<string, any>;
  async function connect() {
    const contact = await execute(a.identity, { action: 'contact.request', endpointId: b.grant.id, requestId: randomUUID() });
    await execute(b.identity, { action: 'contact.respond', contactId: contact.contactId, decision: 'accept', requestId: randomUUID() });
    return contact.contactId as string;
  }
  return { relay, db, members, store, a, b, execute, connect, actor, get service() { return service; },
    async restart() { await service.close(); service = new AgentMessagingService(store, members, options); },
    async close() { await service.close(); members.close(); db.close(); await relay.close(); } };
}

test('PA messages use real encrypted Relay, preserve replies and retries, and never create business jobs', async () => {
  const f = await fixture();
  try {
    const directory = await f.execute(f.a.identity, { action: 'find', limit: 20 });
    assert.equal(directory.items.length, 2);
    assert.equal(directory.ownEndpoint.custody, 'eigos-service');
    await assert.rejects(f.execute(f.a.identity, { action: 'send', endpointId: f.b.grant.id, text: 'not approved', requestId: randomUUID() }), /CONTACT_REQUIRED/);
    await f.connect();
    const request = { action: 'send', endpointId: f.b.grant.id, text: '  private-canary-PA-chat\n', requestId: randomUUID() };
    const sent = await f.execute(f.a.identity, request);
    assert.equal(sent.transport, 'queued');
    const repeated = await f.execute(f.a.identity, request); assert.equal(repeated.messageId, sent.messageId);
    await assert.rejects(f.execute(f.a.identity, { ...request, text: 'changed intent' }), /CONFLICT/);
    const inbox = await f.execute(f.b.identity, { action: 'list', limit: 20 }); assert.equal(inbox.items.length, 1);
    assert.equal(inbox.items[0].state, 'delivered_to_endpoint');
    const read = await f.execute(f.b.identity, { action: 'read', messageId: sent.messageId }); assert.equal(read.text, request.text);
    assert.equal((await f.execute(f.a.identity, { action: 'status', messageId: sent.messageId })).state, 'delivered_to_endpoint');
    await f.execute(f.b.identity, { action: 'mark_read', messageId: sent.messageId, requestId: randomUUID() });
    assert.equal((await f.execute(f.a.identity, { action: 'status', messageId: sent.messageId })).state, 'read');
    const reply = await f.execute(f.b.identity, { action: 'reply', messageId: sent.messageId, text: 'reply-canary', requestId: randomUUID() });
    assert.equal(reply.conversationId, sent.conversationId); assert.equal(reply.inReplyTo, sent.messageId);
    await f.execute(f.a.identity, { action: 'list', limit: 20 });
    assert.equal((await f.execute(f.a.identity, { action: 'read', messageId: reply.messageId })).text, 'reply-canary');
    assert.equal((await f.execute(f.a.identity, { action: 'status', messageId: sent.messageId })).state, 'replied');
    assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='jobs'").get(), undefined);
    const metadata = JSON.stringify(f.db.prepare('SELECT * FROM messaging_messages').all());
    assert(!metadata.includes(request.text)); assert(!metadata.includes('reply-canary'));
    const relayBytes = readFileSync(join(f.relay.directory, 'relay.sqlite'));
    assert(!relayBytes.includes(Buffer.from(request.text)));
  } finally { await f.close(); }
});

test('directory search respects the identity domain while explicit cards still require a separate contact', async () => {
  const f = await fixture();
  try {
    const other = f.actor('Other domain', 'other');
    const found = await f.execute(f.a.identity, { action: 'find', limit: 20 });
    assert.equal(found.items.length, 2); assert(!found.items.some((item: { endpointId: string }) => item.endpointId === other.grant.id));
    const card = await f.execute(f.a.identity, { action: 'find', endpointId: other.grant.id, limit: 20 }); assert.equal(card.items.length, 1);
    await assert.rejects(f.execute(f.a.identity, { action: 'send', endpointId: other.grant.id, text: 'no implicit permission', requestId: randomUUID() }), /CONTACT_REQUIRED/);
  } finally { await f.close(); }
});

test('a new contact never revives ciphertext retained under a revoked contact', async () => {
  const f = await fixture();
  try {
    const firstContact = await f.connect();
    const sent = await f.execute(f.a.identity, { action: 'send', endpointId: f.b.grant.id, text: 'old contact only', requestId: randomUUID() });
    await f.execute(f.b.identity, { action: 'list', limit: 20 });
    await f.execute(f.b.identity, { action: 'contact.respond', contactId: firstContact, decision: 'revoke', requestId: randomUUID() });
    assert.notEqual(await f.connect(), firstContact);
    for (const action of ['read', 'status', 'mark_read']) {
      await assert.rejects(f.execute(f.b.identity, { action, messageId: sent.messageId, ...(action === 'mark_read' ? { requestId: randomUUID() } : {}) }), /CONTACT_REQUIRED/);
    }
    await assert.rejects(f.execute(f.b.identity, { action: 'reply', messageId: sent.messageId, text: 'old contact reply', requestId: randomUUID() }), /CONTACT_REQUIRED/);
    assert.equal((await f.execute(f.b.identity, { action: 'list', limit: 20 })).items.length, 0);
  } finally { await f.close(); }
});

test('a revoked endpoint cannot be accepted from a cached contact request', async () => {
  const f = await fixture();
  try {
    const incoming = await f.execute(f.a.identity, { action: 'contact.request', endpointId: f.b.grant.id, requestId: randomUUID() });
    f.service.revoke(f.a.member.id, f.a.grant.id, 1);
    await assert.rejects(f.execute(f.b.identity, { action: 'contact.respond', contactId: incoming.contactId, decision: 'accept', requestId: randomUUID() }), /MESSAGING_AUTHORIZATION_REQUIRED/);
    const rejected = await f.execute(f.b.identity, { action: 'contact.respond', contactId: incoming.contactId, decision: 'reject', requestId: randomUUID() }); assert.equal(rejected.state, 'rejected');
  } finally { await f.close(); }
});

test('an ACKed message from a subsequently revoked contact cannot block another accepted sender', async t => {
  const f = await fixture();
  try {
    const contact = await f.connect();
    await f.execute(f.a.identity, { action: 'send', endpointId: f.b.grant.id, text: 'pending before contact revoke', requestId: randomUUID() });
    const retained = t.mock.method(RelayClient.prototype, 'retainInboxMessage', () => { throw new Error('synthetic interruption before ciphertext transfer'); });
    await assert.rejects(f.execute(f.b.identity, { action: 'list', limit: 20 }), /synthetic interruption/); retained.mock.restore();
    await f.restart();
    await f.execute(f.b.identity, { action: 'contact.respond', contactId: contact, decision: 'revoke', requestId: randomUUID() });
    const c = f.actor('Carol');
    const incoming = await f.execute(c.identity, { action: 'contact.request', endpointId: f.b.grant.id, requestId: randomUUID() });
    await f.execute(f.b.identity, { action: 'contact.respond', contactId: incoming.contactId, decision: 'accept', requestId: randomUUID() });
    const sent = await f.execute(c.identity, { action: 'send', endpointId: f.b.grant.id, text: 'unblocked valid message', requestId: randomUUID() });
    const inbox = await f.execute(f.b.identity, { action: 'list', limit: 20 }); assert.equal(inbox.items.length, 1);
    assert.equal((await f.execute(f.b.identity, { action: 'read', messageId: sent.messageId })).text, 'unblocked valid message');
  } finally { await f.close(); }
});

test('reply status requires durable ciphertext, and new arrivals do not invalidate an inbox page', async t => {
  const f = await fixture();
  try {
    await f.connect();
    const first = await f.execute(f.a.identity, { action: 'send', endpointId: f.b.grant.id, text: 'first', requestId: randomUUID() });
    await f.execute(f.a.identity, { action: 'send', endpointId: f.b.grant.id, text: 'second', requestId: randomUUID() });
    const page = await f.execute(f.b.identity, { action: 'list', limit: 1 }); assert(page.cursor);
    const tampered = Buffer.from(page.cursor, 'base64url'); tampered[tampered.length - 1]! ^= 1;
    await assert.rejects(f.execute(f.b.identity, { action: 'list', cursor: tampered.toString('base64url'), limit: 1 }), /CURSOR_STALE/);
    await assert.rejects(f.execute(f.a.identity, { action: 'list', cursor: page.cursor, limit: 1 }), /CURSOR_STALE/);
    await f.execute(f.a.identity, { action: 'send', endpointId: f.b.grant.id, text: 'third', requestId: randomUUID() });
    const next = await f.execute(f.b.identity, { action: 'list', cursor: page.cursor, limit: 1 }); assert.equal(next.items.length, 1);
    assert.notEqual(next.items[0].messageId, first.messageId);
    const reply = { action: 'reply', messageId: first.messageId, text: 'persist me before reporting a reply', requestId: randomUUID() };
    const queue = t.mock.method(RelayClient.prototype, 'queue', async () => { throw new Error('synthetic outbox failure'); });
    await assert.rejects(f.execute(f.b.identity, reply), /synthetic outbox failure/); queue.mock.restore();
    assert.notEqual((await f.execute(f.a.identity, { action: 'status', messageId: first.messageId })).state, 'replied');
    await f.execute(f.b.identity, reply);
    assert.equal((await f.execute(f.a.identity, { action: 'status', messageId: first.messageId })).state, 'replied');
  } finally { await f.close(); }
});

test('recipient pagination traverses more than 2001 expired records and reaches a later valid sender', async () => {
  const f = await fixture();
  try {
    const contactId = await f.connect(), now = Date.now();
    const insert = f.db.prepare('INSERT INTO messaging_messages VALUES(?,?,?,?)');
    f.db.exec('BEGIN IMMEDIATE');
    for (let i = 0; i < 2001; i++) {
      const message = { id: randomUUID(), sender: f.a.grant.id, recipient: f.b.grant.id, conversationId: randomUUID(), connectionId: contactId,
        textDigest: 'expired-synthetic-record', createdAt: now - 3600000, expiresAt: now - 1000, deliveredAt: now - 3000000 };
      insert.run(message.id, message.sender, message.recipient, JSON.stringify(message));
    }
    f.db.exec('COMMIT');
    const c = f.actor('Later sender');
    const request = await f.execute(c.identity, { action: 'contact.request', endpointId: f.b.grant.id, requestId: randomUUID() });
    await f.execute(f.b.identity, { action: 'contact.respond', contactId: request.contactId, decision: 'accept', requestId: randomUUID() });
    const sent = await f.execute(c.identity, { action: 'send', endpointId: f.b.grant.id, text: 'reachable beyond the old inbox cap', requestId: randomUUID() });
    let cursor: string | undefined, pages = 0; const ids: string[] = [];
    do {
      const page = await f.execute(f.b.identity, { action: 'list', limit: 1, ...(cursor ? { cursor } : {}) });
      for (const item of page.items) ids.push(item.messageId);
      if (page.cursor) assert.notEqual(page.cursor, cursor);
      cursor = page.cursor; assert(++pages < 20, 'bounded scans must advance even across empty expired pages');
    } while (cursor);
    assert.deepEqual(ids, [sent.messageId]);
    assert.equal((await f.execute(f.b.identity, { action: 'read', messageId: sent.messageId })).text, 'reachable beyond the old inbox cap');
  } finally { await f.close(); }
});

test('offline delivery and atomic retained ciphertext survive host restart before and after user read', async () => {
  const f = await fixture();
  try {
    await f.connect();
    const sent = await f.execute(f.a.identity, { action: 'send', endpointId: f.b.grant.id, text: 'offline canary', requestId: randomUUID() });
    await f.restart();
    await f.execute(f.b.identity, { action: 'list', limit: 20 });
    await f.restart();
    const first = await f.execute(f.b.identity, { action: 'read', messageId: sent.messageId }); assert.equal(first.text, 'offline canary');
    await f.execute(f.b.identity, { action: 'mark_read', messageId: sent.messageId, requestId: randomUUID() });
    await f.restart();
    assert.equal((await f.execute(f.b.identity, { action: 'read', messageId: sent.messageId })).text, first.text);
    assert.equal((await f.execute(f.b.identity, { action: 'list', limit: 20 })).items.length, 1);
  } finally { await f.close(); }
});

test('current member, installation, scopes, contact and communication grant gates remain independent', async () => {
  const f = await fixture();
  try {
    const contactId = await f.connect();
    const sent = await f.execute(f.a.identity, { action: 'send', endpointId: f.b.grant.id, text: 'protected', requestId: randomUUID() });
    await assert.rejects(f.execute({ ...f.b.identity, scopes: [] }, { action: 'read', messageId: sent.messageId }), /MESSAGING_AUTHORIZATION_REQUIRED/);
    await assert.rejects(f.execute({ ...f.b.identity, owner: ownerKey(f.a.p) }, { action: 'list', limit: 20 }), /MESSAGING_AUTHORIZATION_REQUIRED/);
    await assert.rejects(f.execute(f.a.identity, { action: 'read', messageId: sent.messageId }), /NOT_FOUND/);
    await f.execute(f.b.identity, { action: 'contact.respond', contactId, decision: 'revoke', requestId: randomUUID() });
    await assert.rejects(f.execute(f.a.identity, { action: 'status', messageId: sent.messageId }), /CONTACT_REQUIRED/);
    f.service.revoke(f.b.member.id, f.b.grant.id, 1);
    await assert.rejects(f.execute(f.b.identity, { action: 'list', limit: 20 }), /MESSAGING_AUTHORIZATION_REQUIRED/);
    assert.equal(f.service.readiness(f.b.id).state, 'authorization_required');
  } finally { await f.close(); }
});


test('closing messaging drains a started delivery and preserves idempotent retry', async () => {
  let armed=false, entered!:()=>void, release!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;}), gate=new Promise<void>(resolve=>{release=resolve;});
  const fetcher:typeof fetch=async (input,init)=>{
    if(armed && new URL(String(input)).pathname==='/v1/messages' && init?.method==='POST'){armed=false;entered();await gate;}
    return fetch(input,init);
  };
  const f=await fixture(fetcher);
  try {
    await f.connect();armed=true;
    const request={action:'send',endpointId:f.b.grant.id,text:'synthetic-drain',requestId:randomUUID()};
    const outcome=f.execute(f.a.identity,request).then(value=>({value}),error=>({error}));
    await started;
    const closing=f.service.close();
    assert.strictEqual(f.service.close(),closing);
    assert.equal(await Promise.race([closing.then(()=> 'closed'),new Promise<string>(resolve=>setTimeout(()=>resolve('pending'),100))]),'pending');
    await assert.rejects(f.service.execute(f.a.identity,{action:'find',limit:1}),/MESSAGING_UNAVAILABLE/);
    release();await closing;
    const interrupted=await outcome;assert('error' in interrupted);assert.match(String(interrupted.error),/MESSAGING_UNAVAILABLE/);
    await f.restart();
    const retried=await f.execute(f.a.identity,request);
    const inbox=await f.execute(f.b.identity,{action:'list',limit:20});
    assert.equal(inbox.items.length,1);assert.equal(inbox.items[0].messageId,retried.messageId);
    assert.equal((await f.execute(f.b.identity,{action:'read',messageId:retried.messageId})).text,'synthetic-drain');
  } finally { release(); await f.close(); }
});

test('closing messaging drains an in-flight endpoint enrollment before releasing node files', async () => {
  let armed=false,entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const fetcher:typeof fetch=async(input,init)=>{
    if(armed && new URL(String(input)).pathname==='/v1/agents' && init?.method==='POST'){armed=false;entered();await gate;}
    return fetch(input,init);
  };
  const f=await fixture(fetcher);
  try {
    armed=true;
    const outcome=f.service.prepareEndpoint(f.a.grant.id).then(value=>({value}),error=>({error}));
    await started;const closing=f.service.close();
    assert.equal(await Promise.race([closing.then(()=> 'closed'),new Promise<string>(resolve=>setTimeout(()=>resolve('pending'),100))]),'pending');
    release();await closing;const interrupted=await outcome;assert('error' in interrupted);assert.match(String(interrupted.error),/MESSAGING_UNAVAILABLE/);
    await f.restart();const endpoint=await f.service.prepareEndpoint(f.a.grant.id);assert.equal(endpoint.endpointId,f.a.grant.id);
    const source=new DatabaseSync(join(f.relay.directory,'relay.sqlite'),{readOnly:true});
    try {assert.equal(source.prepare('SELECT count(*) AS n FROM relay_agents').get()?.n,1);} finally {source.close();}
  } finally {release();await f.close();}
});
