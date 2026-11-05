import {createCipheriv,createDecipheriv,randomBytes,randomUUID} from 'node:crypto';
import {DomainError} from '../core/domain.js';
import {digest} from '../core/delegation.js';
import type {Member} from '../members/contracts.js';
import type {RelayEnrollmentIssuer} from '../agent-transport/enrollment.js';
import {MAX_MESSAGE_MS,RelayError,type Connection} from '../relay/contracts.js';
import {messageContentSchema,messagingFail,messagingOperationSchema,operationScope,MessagingError,MESSAGE_PROTOCOL,type CommunicationGrant,type MessageRecord,type MessagingIdentity,type MessagingOperation} from './contracts.js';
import type {MessagingStoragePort,MessagingNodePort,MessagingNodeFactory,MessagingAdmissionPort} from './ports.js';
export interface MessagingProtocolOptions {relayUrl:string;enrollment:Pick<RelayEnrollmentIssuer,'issueCommunication'>;openNode:MessagingNodeFactory}
function denied(error:unknown){return error instanceof MessagingError&&['MESSAGING_AUTHORIZATION_REQUIRED','NOT_FOUND'].includes(error.code)||error instanceof DomainError&&['NOT_FOUND','FORBIDDEN'].includes(error.code);}

/** One asynchronous protocol implementation for SQLite and PostgreSQL. The
 * host supplies genuine admission and durable encrypted-node storage. */
export class AgentMessagingProtocol {
  #nodes = new Map<string, Promise<MessagingNodePort>>();
  #refreshing = new Map<string, Promise<void>>();
  #closing = new Set<Promise<void>>();
  #active = new Set<Promise<unknown>>();
  #closePromise?: Promise<void>;
  #cursorKey = randomBytes(32);
  private closed = false;
  constructor(readonly store:MessagingStoragePort,private readonly members:{get(id:string):Promise<Member>|Member},private readonly options:MessagingProtocolOptions,private readonly admission:MessagingAdmissionPort){}
  private available(){if(this.closed)return messagingFail('MESSAGING_UNAVAILABLE',503);this.admission.available();}
  private async live(id:string){this.available();return this.admission.live(id);}
  private async authorized(identity:MessagingIdentity,scope:string){this.available();return this.admission.authorized(identity,scope);}
  retire(id: string) {
    const opening = this.#nodes.get(id);
    this.#nodes.delete(id);
    if (!opening) return;
    const closing = opening.then(async node => { await node.close(); }).catch(() => {}).finally(() => this.#closing.delete(closing));
    this.#closing.add(closing);
  }
  private async node(id: string): Promise<MessagingNodePort> {
    await this.live(id);
    let opening = this.#nodes.get(id);
    if (!opening) {
      for (const key of this.#nodes.keys()) { try { await this.live(key); } catch(error) { if(!denied(error))throw error;this.retire(key); } }
      if (this.#nodes.size >= 64) return Promise.reject(new Error('Messaging node capacity reached'));
      opening = this.openNode(id).catch(error => { this.#nodes.delete(id); throw error; });
      this.#nodes.set(id, opening);
    }
    return opening.then(async node => {
      const lease = await this.store.lease(id);
      if (lease.expiresAt <= this.store.now() + 60000 || lease.renewalId) await this.enroll(id, node, true);
      await this.live(id); return node;
    });
  }
  private async openNode(id: string) {
    const grant = await this.live(id);
    const node = await this.options.openNode(grant,async()=>{await this.live(id);});
    try {
      await this.live(id); await this.store.bindNode(id, node.agentId);
      await this.enroll(id, node, !!(await this.store.lease(id)).renewalId);
      await this.live(id); return node;
    } catch (error) { await node.close(); throw error; }
  }
  private async enroll(id: string, node: MessagingNodePort, renew: boolean) {
    const grant = await this.live(id), member = await this.members.get(grant.memberId);
    const assertion = await this.options.enrollment.issueCommunication(grant.owner, member.tenant, node.agentId, grant.expiresAt);
    await this.live(id);
    const receipt = renew ? await node.renew(assertion.accessToken, await this.store.renewal(id)) : await node.register(assertion.accessToken);
    await this.live(id); await this.store.recordLease(id, receipt.expiresAt);
  }
  private endpoint(grant: CommunicationGrant) {
    return { endpointId: grant.id, agentId: grant.agentId, displayName: grant.displayName, transport: 'service_mailbox',
      custody: grant.custody, protocols: ['mcp', 'a2a'], activeUntil: new Date(grant.expiresAt).toISOString(), inbound: 'pull' };
  }
  private async accepted(own: CommunicationGrant, peer: CommunicationGrant): Promise<{ node: MessagingNodePort; contact: Connection }> {
    const node = await this.node(own.id), other = await this.node(peer.id);
    const contact = (await node.contacts()).find(c => c.state === 'accepted' && [c.requester, c.recipient].includes(other.agentId));
    if (!contact) return messagingFail('CONTACT_REQUIRED');
    await this.live(own.id); await this.live(peer.id);
    return { node, contact };
  }
  private cursor(value: unknown) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.#cursorKey, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
  }
  private after(cursor: string | undefined, context: string): number {
    if (!cursor) return 0;
    try {
      const bytes = Buffer.from(cursor, 'base64url');
      if (bytes.length <= 28) return messagingFail('CURSOR_STALE', 409);
      const decipher = createDecipheriv('aes-256-gcm', this.#cursorKey, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const parsed = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
      if (parsed.context !== context || !Number.isSafeInteger(parsed.after) || parsed.after < 0 || parsed.expiresAt <= this.store.now()) return messagingFail('CURSOR_STALE', 409);
      return parsed.after;
    } catch { return messagingFail('CURSOR_STALE', 409); }
  }
  private page<T>(items: T[], cursor: string | undefined, limit: number, context: string) {
    const after = this.after(cursor, context), next = after + limit;
    return { items: items.slice(after, next), ...(next < items.length ? { cursor: this.cursor({ context, after: next, expiresAt: this.store.now() + 900000 }) } : {}) };
  }
  private track<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new MessagingError('MESSAGING_UNAVAILABLE',503));
    const work = Promise.resolve().then(action); this.#active.add(work);
    void work.finally(() => this.#active.delete(work)).catch(() => {});
    return work;
  }
  async execute(identity: MessagingIdentity, input: unknown): Promise<unknown> {
    return this.track(async () => {
      const operation = messagingOperationSchema.parse(input), scope = operationScope(operation.action), own = await this.authorized(identity, scope);
      const result = await this.dispatch(own, operation);
      await this.authorized(identity, scope);
      return result;
    });
  }
  private async dispatch(own: CommunicationGrant, op: MessagingOperation): Promise<unknown> {
    if (op.action === 'find') {
      await this.node(own.id);
      const ownDomain = JSON.parse(own.owner).slice(0, 2);
      const items=[];
      for(const candidate of await this.store.grants()){
        let grant:CommunicationGrant;try{grant=await this.live(candidate.id);}catch(error){if(denied(error))continue;throw error;}
        if((grant.memberId===own.memberId||grant.visibility==='members'&&digest(JSON.parse(grant.owner).slice(0,2))===digest(ownDomain)||grant.id===op.endpointId)
          &&(!op.endpointId||grant.id===op.endpointId)&&(!op.query||grant.displayName.toLowerCase().includes(op.query.toLowerCase())))items.push(this.endpoint(grant));
      }
      return {ownEndpoint:this.endpoint(await this.live(own.id)),...this.page(items,op.cursor,op.limit,digest([own.id,op.query,op.endpointId,items]))};
    }
    if (op.action === 'contact.request') {
      const peer = await this.live(op.endpointId);
      if (peer.id === own.id || !peer.scopes.includes('messaging:read')) return messagingFail('INVALID_INPUT', 400);
      await this.store.claimRequest(own.id, op.requestId, op, peer.id);
      const node = await this.node(own.id), other = await this.node(peer.id);
      let connection: Connection;
      const key = digest(['messaging-contact', own.id, op.requestId]);
      const transportId = `${key.slice(0, 8)}-${key.slice(8, 12)}-5${key.slice(13, 16)}-a${key.slice(17, 20)}-${key.slice(20, 32)}`;
      try { connection = await node.requestContact(other.agentId, transportId, async () => { await this.live(own.id); await this.live(peer.id); }); }
      catch (error) {
        if (!(error instanceof RelayError) || error.code !== 'CONNECTION_ALREADY_EXISTS') throw error;
        connection = (await node.contacts()).find(c => ['pending', 'accepted'].includes(c.state) && [c.requester, c.recipient].includes(other.agentId)) ?? messagingFail('CONTACT_REQUIRED');
      }
      connection = (await node.contacts()).find(c => c.id === connection.id) ?? connection;
      await this.live(peer.id);
      return { contactId: connection.id, endpointId: peer.id, state: connection.state };
    }
    if (op.action === 'contact.respond') {
      const node = await this.node(own.id), contacts = await node.contacts();
      const previous = contacts.find(c => c.id === op.contactId);
      if (!previous) return messagingFail('NOT_FOUND', 404);
      const peer = op.decision === 'accept' ? (await this.store.grants()).find(grant => grant.agentId === (previous.requester === node.agentId ? previous.recipient : previous.requester)) : undefined;
      if (op.decision === 'accept') { if (!peer) return messagingFail('NOT_FOUND', 404); await this.live(peer.id); }
      await this.store.claimRequest(own.id, op.requestId, op, op.contactId);
      const expected = op.decision === 'accept' ? 'accepted' : op.decision === 'reject' ? 'rejected' : 'revoked';
      const contact = previous.state === expected ? previous : await node.respondContact(op.contactId, op.decision, async () => { await this.live(own.id); if (peer) await this.live(peer.id); });
      return { contactId: contact.id, state: contact.state };
    }
    if (op.action === 'send' || op.action === 'reply') return this.send(own, op);
    if (op.action === 'list') {
      await this.refresh(own.id);
      const node = await this.node(own.id), contacts = await node.contacts(), accepted = new Set(contacts.filter(c => c.state === 'accepted').map(c => c.id));
      const grants=await this.store.grants(),contactViews=[];
      for(const c of contacts){const peerId=c.requester===node.agentId?c.recipient:c.requester,peer=grants.find(g=>g.agentId===peerId);if(!peer)continue;
        try{const current=await this.live(peer.id);contactViews.push({contactId:c.id,state:c.state,endpoint:this.endpoint(current),incoming:c.recipient===node.agentId});}catch(error){if(!denied(error))throw error;}
      }
      const context = digest([own.id, own.revision, contactViews.map(c => [c.contactId, c.state, c.endpoint.endpointId])]);
      const after = this.after(op.cursor, context), scanLimit = 201, batch = await this.store.inbox(own.id, { after, limit: scanLimit });
      const items: Awaited<ReturnType<AgentMessagingProtocol['view']>>[] = []; let last = after;
      for (const { cursor, message } of batch) {
        if (items.length === op.limit) break;
        last = cursor;
        if (!message.deliveredAt || message.expiresAt <= this.store.now() || !accepted.has(message.connectionId)) continue;
        try { await this.live(message.sender); } catch(error) { if(denied(error))continue;throw error; }
        items.push(await this.view(message));
      }
      const hasMore = batch.some(row => row.cursor > last) || batch.length === scanLimit;
      return { items, contacts: contactViews,
        ...(hasMore ? { cursor: this.cursor({ context, after: last, expiresAt: this.store.now() + 900000 }) } : {}) };
    }
    const record = await this.store.message(op.messageId);
    if (record.sender !== own.id && record.recipient !== own.id) return messagingFail('NOT_FOUND', 404);
    const peer = await this.live(record.sender === own.id ? record.recipient : record.sender);
    const { node, contact } = await this.accepted(own, peer);
    if (contact.id !== record.connectionId) return messagingFail('CONTACT_REQUIRED');
    if (op.action === 'status') {
      const receipt = record.sender === own.id ? await node.receipt(node.agentId, record.id).catch(error => {
        if (error instanceof RelayError && error.status === 404) return { status: 'unknown' };
        throw error;
      }) : undefined;
      return { ...await this.view(await this.store.message(record.id)), ...(receipt ? { transport: receipt.status } : {}) };
    }
    if (record.recipient !== own.id) return messagingFail('NOT_FOUND', 404);
    if (record.expiresAt <= this.store.now()) return messagingFail('MESSAGE_EXPIRED', 410);
    await this.refresh(own.id);
    const received = await node.readRetainedMessage(peer.agentId!, record.id), content = messageContentSchema.parse(received.content);
    if (received.connectionId !== record.connectionId || content.id !== record.id || content.sender !== peer.id || content.recipient !== own.id || digest(content.text) !== record.textDigest)
      return messagingFail('CONFLICT', 409);
    await this.live(peer.id); await this.live(own.id);
    const current = await this.accepted(await this.live(own.id), await this.live(peer.id));
    if (current.contact.id !== record.connectionId) return messagingFail('CONTACT_REQUIRED');
    if (op.action === 'mark_read') { await this.store.claimRequest(own.id, op.requestId, op, record.id); await this.store.markRead(record.id); }
    return op.action === 'mark_read' ? this.view(await this.store.message(record.id)) : { ...await this.view(await this.store.message(record.id)), text: content.text };
  }
  private async view(record: MessageRecord) {
    return { messageId: record.id, conversationId: record.conversationId, senderEndpointId: record.sender, recipientEndpointId: record.recipient,
      inReplyTo: record.inReplyTo, createdAt: new Date(record.createdAt).toISOString(), expiresAt: new Date(record.expiresAt).toISOString(),
      state: record.expiresAt <= this.store.now() ? 'expired' : await this.store.hasReply(record.id) ? 'replied' : record.readAt ? 'read' : record.deliveredAt ? 'delivered_to_endpoint'
        : record.outboxStoredAt || record.relayStoredAt ? 'stored' : 'pending' };
  }
  private async send(own: CommunicationGrant, op: Extract<MessagingOperation, { action: 'send' | 'reply' }>) {
    const parent = op.action === 'reply' ? await this.store.message(op.messageId) : undefined;
    if (parent && (parent.recipient !== own.id || parent.expiresAt <= this.store.now())) return messagingFail('NOT_FOUND', 404);
    const peer = await this.live(op.action === 'send' ? op.endpointId : parent!.sender);
    const { node, contact } = await this.accepted(own, peer);
    if (parent && parent.connectionId !== contact.id) return messagingFail('CONTACT_REQUIRED');
    const record = await this.store.prepare(own.id, op.requestId, op, () => {
      const now = this.store.now(), expiresAt = Math.min(op.expiresAt ? Date.parse(op.expiresAt) : now + MAX_MESSAGE_MS, own.expiresAt, peer.expiresAt);
      if (expiresAt <= now || expiresAt - now > MAX_MESSAGE_MS) return messagingFail('INVALID_INPUT', 400);
      return { id: randomUUID(), sender: own.id, recipient: peer.id, conversationId: parent?.conversationId ?? randomUUID(),
        inReplyTo: parent?.id, connectionId: contact.id, textDigest: digest(op.text), createdAt: now, expiresAt };
    });
    if (record.expiresAt <= this.store.now()) return messagingFail('MESSAGE_EXPIRED', 410);
    if (record.connectionId !== contact.id) return messagingFail('CONTACT_REQUIRED');
    const content = messageContentSchema.parse({ protocol: MESSAGE_PROTOCOL, id: record.id, sender: record.sender, recipient: record.recipient,
      conversationId: record.conversationId, inReplyTo: record.inReplyTo, text: op.text, createdAt: record.createdAt, expiresAt: record.expiresAt });
    const id = await node.queue((await this.store.grant(peer.id)).agentId!, contact.id, content, { id: record.id, expiresAt: record.expiresAt });
    await this.store.outboxStored(record.id);
    const receipt = await node.deliver(id, { beforeSend: async () => {
      const current = await this.accepted(await this.live(own.id), await this.live(peer.id));
      if (current.contact.id !== record.connectionId) return messagingFail('CONTACT_REQUIRED');
    } });
    if (receipt.status === 'queued' || receipt.status === 'received') await this.store.relayStored(record.id);
    await this.live(peer.id); await this.live(own.id);
    return { ...await this.view(await this.store.message(record.id)), transport: receipt.status };
  }
  private refresh(id: string): Promise<void> {
    const active = this.#refreshing.get(id);
    if (active) return active;
    const work = this.receive(id).finally(() => this.#refreshing.delete(id));
    this.#refreshing.set(id, work); return work;
  }
  private async receive(id: string) {
    const own = await this.live(id), node = await this.node(id);
    for (let batch = 0; batch < 16; batch++) {
      const waiting = await node.poll();
      if (!waiting.length) return;
      const contacts = await node.contacts();
      for (const message of waiting) {
        await this.live(id);
        const content = messageContentSchema.safeParse(message.content);
        if (!content.success) { await node.markHandled(message.senderId, message.id); continue; }
        const body = content.data;
        let peer: CommunicationGrant, record: MessageRecord;
        try { peer = await this.live(body.sender); record = await this.store.message(body.id); }
        catch (error) {
          if (!(error instanceof MessagingError && ['MESSAGING_AUTHORIZATION_REQUIRED', 'NOT_FOUND'].includes(error.code))
            && !(error instanceof DomainError && ['NOT_FOUND', 'FORBIDDEN'].includes(error.code))) throw error;
          await node.markHandled(message.senderId, message.id); continue;
        }
        const contact = contacts.find(c => c.state === 'accepted' && c.id === record.connectionId && [c.requester, c.recipient].includes(peer.agentId!));
        if (!contact) { await node.markHandled(message.senderId, message.id); continue; }
        if (message.senderId !== peer.agentId || message.id !== body.id || body.recipient !== own.id || record.sender !== peer.id || record.recipient !== own.id
          || message.connectionId !== record.connectionId || contact.id !== record.connectionId || body.expiresAt !== record.expiresAt || message.expiresAt !== record.expiresAt
          || body.createdAt !== record.createdAt || body.conversationId !== record.conversationId || body.inReplyTo !== record.inReplyTo || digest(body.text) !== record.textDigest)
          { await node.markHandled(message.senderId, message.id); continue; }
        await this.live(id); await this.live(peer.id);
        await this.store.delivered(record.id);
        await node.retainInboxMessage(message.senderId, message.id);
      }
    }
  }
  async prepareEndpoint(id: string) { return this.track(async () => { await this.node(id); return this.endpoint(await this.store.grant(id)); }); }
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.closed = true;
    return this.#closePromise = this.drain();
  }
  private async drain(): Promise<void> {
    // Stop admitting operations first; let started work settle before closing
    // node databases so an in-flight response can persist its receipt.
    await Promise.allSettled([...this.#active]);
    await Promise.allSettled(this.#refreshing.values());
    const nodes = [...this.#nodes.values()]; this.#nodes.clear();
    const closing = [...this.#closing];
    await Promise.allSettled(closing);
    for (const node of await Promise.allSettled(nodes)) if (node.status === 'fulfilled') await node.value.close();
  }
}
