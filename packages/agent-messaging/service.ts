import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Principal } from '../core/domain.js';
import { ownerKey } from '../core/domain.js';
import { DomainError } from '../core/domain.js';
import { digest } from '../core/delegation.js';
import type { MemberStore } from '../members/store.js';
import { RelayClient } from '../agent-transport/client.js';
import type { RelayEnrollmentIssuer } from '../agent-transport/enrollment.js';
import { MAX_MESSAGE_MS, RelayError, type Connection } from '../relay/contracts.js';
import { MessagingStore } from './store.js';
import { communicationGrantInputSchema, messageContentSchema, messagingFail, messagingOperationSchema, operationScope, MessagingError,
  MESSAGE_PROTOCOL, type CommunicationGrant, type MessageRecord, type MessagingIdentity, type MessagingOperation } from './contracts.js';

export interface MessagingOptions {
  relayUrl: string; nodeDirectory: string; enrollment: Pick<RelayEnrollmentIssuer, 'issueCommunication'>;
  available?: () => boolean; fetch?: typeof fetch;
  checkIdentity?: (facts: ReturnType<MemberStore['authorizationFacts']>) => string;
  permissionsUrl?: string;
}

/** Protocol-neutral messaging infrastructure. It never submits a task, starts a model or loads a source. */
export class AgentMessagingService {
  #nodes = new Map<string, Promise<RelayClient>>();
  #refreshing = new Map<string, Promise<void>>();
  #closing = new Set<Promise<void>>();
  #cursorKey = randomBytes(32);
  private closed = false;
  get permissionsUrl() { return this.options.permissionsUrl; }
  constructor(readonly store: MessagingStore, private members: MemberStore, private options: MessagingOptions) {
    if (!isAbsolute(options.nodeDirectory)) throw new Error('Messaging nodes require an absolute private directory');
    mkdirSync(options.nodeDirectory, { recursive: true, mode: 0o700 });
    const info = lstatSync(options.nodeDirectory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 || process.getuid && info.uid !== process.getuid())
      throw new Error('Messaging nodes require an owned private directory (0700)');
  }
  identity(p: Principal, bearer: string): MessagingIdentity {
    this.available();
    this.members.authorize(p);
    const installation = this.members.agents.authorize(p, bearer);
    const facts = this.members.authorizationFacts(installation.memberId!, installation.id);
    this.options.checkIdentity?.(facts);
    if (!facts.active || facts.ownerKey !== ownerKey(p) || facts.clientId !== p.clientId) return messagingFail('MESSAGING_AUTHORIZATION_REQUIRED');
    return { memberId: facts.memberId, installationId: facts.installationId, owner: facts.ownerKey, clientId: facts.clientId, scopes: [...p.scopes] };
  }
  readiness(installationId: string) {
    const grant = this.store.installation(installationId);
    if (!grant) return { state: 'authorization_required' as const };
    try { this.live(grant.id); return { state: 'ready' as const, endpointId: grant.id, scopes: grant.scopes, expiresAt: grant.expiresAt }; }
    catch { return { state: 'authorization_required' as const }; }
  }
  approve(memberId: string, input: unknown) {
    const args = communicationGrantInputSchema.parse(input), facts = this.members.authorizationFacts(memberId, args.installationId);
    this.available();
    const generation = this.options.checkIdentity?.(facts) ?? digest(facts);
    if (!facts.active) return messagingFail('MESSAGING_AUTHORIZATION_REQUIRED');
    const grant = this.store.approve({ memberId, installationId: facts.installationId, owner: facts.ownerKey, clientId: facts.clientId }, args, generation);
    return this.live(grant.id);
  }
  revoke(memberId: string, id: string, revision: number) { this.store.revoke(memberId, id, revision); this.retire(id); }
  private retire(id: string) {
    const opening = this.#nodes.get(id);
    this.#nodes.delete(id);
    if (!opening) return;
    const closing = opening.then(node => { node.close(); }).catch(() => {}).finally(() => this.#closing.delete(closing));
    this.#closing.add(closing);
  }
  private available() { if (this.closed || this.options.available && !this.options.available()) return messagingFail('MESSAGING_UNAVAILABLE', 503); }
  private live(id: string): CommunicationGrant {
    this.available();
    const grant = this.store.grant(id), facts = this.members.authorizationFacts(grant.memberId, grant.installationId);
    const generation = this.options.checkIdentity?.(facts) ?? digest(facts);
    if (!facts.active || facts.ownerKey !== grant.owner || facts.clientId !== grant.clientId || grant.revoked || grant.expiresAt <= this.store.now() || generation !== grant.identityGeneration)
      return messagingFail('MESSAGING_AUTHORIZATION_REQUIRED');
    return grant;
  }
  private authorized(identity: MessagingIdentity, scope: string) {
    if (!identity.scopes.includes(scope)) return messagingFail('MESSAGING_AUTHORIZATION_REQUIRED');
    const grant = this.store.installation(identity.installationId);
    if (!grant) return messagingFail('MESSAGING_AUTHORIZATION_REQUIRED');
    const current = this.live(grant.id);
    if (current.memberId !== identity.memberId || current.owner !== identity.owner || current.clientId !== identity.clientId || !current.scopes.includes(scope))
      return messagingFail('MESSAGING_AUTHORIZATION_REQUIRED');
    return current;
  }
  private node(id: string): Promise<RelayClient> {
    this.live(id);
    let opening = this.#nodes.get(id);
    if (!opening) {
      for (const key of this.#nodes.keys()) { try { this.live(key); } catch { this.retire(key); } }
      if (this.#nodes.size >= 64) return Promise.reject(new Error('Messaging node capacity reached'));
      opening = this.openNode(id).catch(error => { this.#nodes.delete(id); throw error; });
      this.#nodes.set(id, opening);
    }
    return opening.then(async node => {
      const lease = this.store.lease(id);
      if (lease.expiresAt <= this.store.now() + 60000 || lease.renewalId) await this.enroll(id, node, true);
      this.live(id); return node;
    });
  }
  private async openNode(id: string) {
    const grant = this.live(id);
    const node = await RelayClient.open({ baseUrl: this.options.relayUrl, credentialPath: join(this.options.nodeDirectory, id + '.json'),
      displayName: grant.displayName, fetch: this.options.fetch });
    try {
      this.live(id); this.store.bindNode(id, node.agentId);
      await this.enroll(id, node, !!this.store.lease(id).renewalId);
      this.live(id); return node;
    } catch (error) { node.close(); throw error; }
  }
  private async enroll(id: string, node: RelayClient, renew: boolean) {
    const grant = this.live(id), member = this.members.get(grant.memberId);
    const assertion = await this.options.enrollment.issueCommunication(grant.owner, member.tenant, node.agentId, grant.expiresAt);
    this.live(id);
    const receipt = renew ? await node.renew(assertion.accessToken, this.store.renewal(id)) : await node.register(assertion.accessToken);
    this.live(id); this.store.recordLease(id, receipt.expiresAt);
  }
  private endpoint(grant: CommunicationGrant) {
    return { endpointId: grant.id, agentId: grant.agentId, displayName: grant.displayName, transport: 'service_mailbox',
      custody: grant.custody, protocols: ['mcp', 'a2a'], activeUntil: new Date(grant.expiresAt).toISOString(), inbound: 'pull' };
  }
  private async accepted(own: CommunicationGrant, peer: CommunicationGrant): Promise<{ node: RelayClient; contact: Connection }> {
    const node = await this.node(own.id), other = await this.node(peer.id);
    const contact = (await node.contacts()).find(c => c.state === 'accepted' && [c.requester, c.recipient].includes(other.agentId));
    if (!contact) return messagingFail('CONTACT_REQUIRED');
    this.live(own.id); this.live(peer.id);
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
  async execute(identity: MessagingIdentity, input: unknown): Promise<unknown> {
    const operation = messagingOperationSchema.parse(input), scope = operationScope(operation.action), own = this.authorized(identity, scope);
    const result = await this.dispatch(own, operation);
    this.authorized(identity, scope);
    return result;
  }
  private async dispatch(own: CommunicationGrant, op: MessagingOperation): Promise<unknown> {
    if (op.action === 'find') {
      await this.node(own.id);
      const ownDomain = JSON.parse(own.owner).slice(0, 2);
      const grants = this.store.grants().filter(grant => {
        try { this.live(grant.id); } catch { return false; }
        return (grant.memberId === own.memberId || grant.visibility === 'members' && digest(JSON.parse(grant.owner).slice(0, 2)) === digest(ownDomain) || grant.id === op.endpointId)
          && (!op.endpointId || grant.id === op.endpointId) && (!op.query || grant.displayName.toLowerCase().includes(op.query.toLowerCase()));
      });
      const items = grants.map(g => this.endpoint(this.store.grant(g.id)));
      return { ownEndpoint: this.endpoint(this.store.grant(own.id)), ...this.page(items, op.cursor, op.limit, digest([own.id, op.query, op.endpointId, items])) };
    }
    if (op.action === 'contact.request') {
      const peer = this.live(op.endpointId);
      if (peer.id === own.id || !peer.scopes.includes('messaging:read')) return messagingFail('INVALID_INPUT', 400);
      this.store.claimRequest(own.id, op.requestId, op, peer.id);
      const node = await this.node(own.id), other = await this.node(peer.id);
      let connection: Connection;
      const key = digest(['messaging-contact', own.id, op.requestId]);
      const transportId = `${key.slice(0, 8)}-${key.slice(8, 12)}-5${key.slice(13, 16)}-a${key.slice(17, 20)}-${key.slice(20, 32)}`;
      try { connection = await node.requestContact(other.agentId, transportId, () => { this.live(own.id); this.live(peer.id); }); }
      catch (error) {
        if (!(error instanceof RelayError) || error.code !== 'CONNECTION_ALREADY_EXISTS') throw error;
        connection = (await node.contacts()).find(c => ['pending', 'accepted'].includes(c.state) && [c.requester, c.recipient].includes(other.agentId)) ?? messagingFail('CONTACT_REQUIRED');
      }
      connection = (await node.contacts()).find(c => c.id === connection.id) ?? connection;
      this.live(peer.id);
      return { contactId: connection.id, endpointId: peer.id, state: connection.state };
    }
    if (op.action === 'contact.respond') {
      const node = await this.node(own.id), contacts = await node.contacts();
      const previous = contacts.find(c => c.id === op.contactId);
      if (!previous) return messagingFail('NOT_FOUND', 404);
      const peer = op.decision === 'accept' ? this.store.grants().find(grant => grant.agentId === (previous.requester === node.agentId ? previous.recipient : previous.requester)) : undefined;
      if (op.decision === 'accept') { if (!peer) return messagingFail('NOT_FOUND', 404); this.live(peer.id); }
      this.store.claimRequest(own.id, op.requestId, op, op.contactId);
      const expected = op.decision === 'accept' ? 'accepted' : op.decision === 'reject' ? 'rejected' : 'revoked';
      const contact = previous.state === expected ? previous : await node.respondContact(op.contactId, op.decision, () => { this.live(own.id); if (peer) this.live(peer.id); });
      return { contactId: contact.id, state: contact.state };
    }
    if (op.action === 'send' || op.action === 'reply') return this.send(own, op);
    if (op.action === 'list') {
      await this.refresh(own.id);
      const node = await this.node(own.id), contacts = await node.contacts(), accepted = new Set(contacts.filter(c => c.state === 'accepted').map(c => c.id));
      const contactViews = contacts.flatMap(c => {
        const peerId = c.requester === node.agentId ? c.recipient : c.requester;
        const peer = this.store.grants().find(g => g.agentId === peerId);
        try { if (!peer) return []; this.live(peer.id); } catch { return []; }
        return [{ contactId: c.id, state: c.state, endpoint: this.endpoint(peer), incoming: c.recipient === node.agentId }];
      });
      const context = digest([own.id, own.revision, contactViews.map(c => [c.contactId, c.state, c.endpoint.endpointId])]);
      const after = this.after(op.cursor, context), scanLimit = 201, batch = this.store.inbox(own.id, { after, limit: scanLimit });
      const items: ReturnType<AgentMessagingService['view']>[] = []; let last = after;
      for (const { cursor, message } of batch) {
        if (items.length === op.limit) break;
        last = cursor;
        if (!message.deliveredAt || message.expiresAt <= this.store.now() || !accepted.has(message.connectionId)) continue;
        try { this.live(message.sender); } catch { continue; }
        items.push(this.view(message));
      }
      const hasMore = batch.some(row => row.cursor > last) || batch.length === scanLimit;
      return { items, contacts: contactViews,
        ...(hasMore ? { cursor: this.cursor({ context, after: last, expiresAt: this.store.now() + 900000 }) } : {}) };
    }
    const record = this.store.message(op.messageId);
    if (record.sender !== own.id && record.recipient !== own.id) return messagingFail('NOT_FOUND', 404);
    const peer = this.live(record.sender === own.id ? record.recipient : record.sender);
    const { node, contact } = await this.accepted(own, peer);
    if (contact.id !== record.connectionId) return messagingFail('CONTACT_REQUIRED');
    if (op.action === 'status') {
      const receipt = record.sender === own.id ? await node.receipt(node.agentId, record.id).catch(error => {
        if (error instanceof RelayError && error.status === 404) return { status: 'unknown' };
        throw error;
      }) : undefined;
      return { ...this.view(this.store.message(record.id)), ...(receipt ? { transport: receipt.status } : {}) };
    }
    if (record.recipient !== own.id) return messagingFail('NOT_FOUND', 404);
    if (record.expiresAt <= this.store.now()) return messagingFail('MESSAGE_EXPIRED', 410);
    await this.refresh(own.id);
    const received = await node.readRetainedMessage(peer.agentId!, record.id), content = messageContentSchema.parse(received.content);
    if (received.connectionId !== record.connectionId || content.id !== record.id || content.sender !== peer.id || content.recipient !== own.id || digest(content.text) !== record.textDigest)
      return messagingFail('CONFLICT', 409);
    this.live(peer.id); this.live(own.id);
    const current = await this.accepted(this.live(own.id), this.live(peer.id));
    if (current.contact.id !== record.connectionId) return messagingFail('CONTACT_REQUIRED');
    if (op.action === 'mark_read') { this.store.claimRequest(own.id, op.requestId, op, record.id); this.store.markRead(record.id); }
    return op.action === 'mark_read' ? this.view(this.store.message(record.id)) : { ...this.view(this.store.message(record.id)), text: content.text };
  }
  private view(record: MessageRecord) {
    return { messageId: record.id, conversationId: record.conversationId, senderEndpointId: record.sender, recipientEndpointId: record.recipient,
      inReplyTo: record.inReplyTo, createdAt: new Date(record.createdAt).toISOString(), expiresAt: new Date(record.expiresAt).toISOString(),
      state: record.expiresAt <= this.store.now() ? 'expired' : this.store.hasReply(record.id) ? 'replied' : record.readAt ? 'read' : record.deliveredAt ? 'delivered_to_endpoint'
        : record.outboxStoredAt || record.relayStoredAt ? 'stored' : 'pending' };
  }
  private async send(own: CommunicationGrant, op: Extract<MessagingOperation, { action: 'send' | 'reply' }>) {
    const parent = op.action === 'reply' ? this.store.message(op.messageId) : undefined;
    if (parent && (parent.recipient !== own.id || parent.expiresAt <= this.store.now())) return messagingFail('NOT_FOUND', 404);
    const peer = this.live(op.action === 'send' ? op.endpointId : parent!.sender);
    const { node, contact } = await this.accepted(own, peer);
    if (parent && parent.connectionId !== contact.id) return messagingFail('CONTACT_REQUIRED');
    const record = this.store.prepare(own.id, op.requestId, op, () => {
      const now = this.store.now(), expiresAt = Math.min(op.expiresAt ? Date.parse(op.expiresAt) : now + MAX_MESSAGE_MS, own.expiresAt, peer.expiresAt);
      if (expiresAt <= now || expiresAt - now > MAX_MESSAGE_MS) return messagingFail('INVALID_INPUT', 400);
      return { id: randomUUID(), sender: own.id, recipient: peer.id, conversationId: parent?.conversationId ?? randomUUID(),
        inReplyTo: parent?.id, connectionId: contact.id, textDigest: digest(op.text), createdAt: now, expiresAt };
    });
    if (record.expiresAt <= this.store.now()) return messagingFail('MESSAGE_EXPIRED', 410);
    if (record.connectionId !== contact.id) return messagingFail('CONTACT_REQUIRED');
    const content = messageContentSchema.parse({ protocol: MESSAGE_PROTOCOL, id: record.id, sender: record.sender, recipient: record.recipient,
      conversationId: record.conversationId, inReplyTo: record.inReplyTo, text: op.text, createdAt: record.createdAt, expiresAt: record.expiresAt });
    const id = await node.queue(this.store.grant(peer.id).agentId!, contact.id, content, { id: record.id, expiresAt: record.expiresAt });
    this.store.outboxStored(record.id);
    const receipt = await node.deliver(id, { beforeSend: async () => {
      const current = await this.accepted(this.live(own.id), this.live(peer.id));
      if (current.contact.id !== record.connectionId) return messagingFail('CONTACT_REQUIRED');
    } });
    if (receipt.status === 'queued' || receipt.status === 'received') this.store.relayStored(record.id);
    this.live(peer.id); this.live(own.id);
    return { ...this.view(this.store.message(record.id)), transport: receipt.status };
  }
  private refresh(id: string): Promise<void> {
    const active = this.#refreshing.get(id);
    if (active) return active;
    const work = this.receive(id).finally(() => this.#refreshing.delete(id));
    this.#refreshing.set(id, work); return work;
  }
  private async receive(id: string) {
    const own = this.live(id), node = await this.node(id);
    for (let batch = 0; batch < 16; batch++) {
      const waiting = await node.poll();
      if (!waiting.length) return;
      const contacts = await node.contacts();
      for (const message of waiting) {
        this.live(id);
        const content = messageContentSchema.safeParse(message.content);
        if (!content.success) { node.markHandled(message.senderId, message.id); continue; }
        const body = content.data;
        let peer: CommunicationGrant, record: MessageRecord;
        try { peer = this.live(body.sender); record = this.store.message(body.id); }
        catch (error) {
          if (!(error instanceof MessagingError && ['MESSAGING_AUTHORIZATION_REQUIRED', 'NOT_FOUND'].includes(error.code))
            && !(error instanceof DomainError && ['NOT_FOUND', 'FORBIDDEN'].includes(error.code))) throw error;
          node.markHandled(message.senderId, message.id); continue;
        }
        const contact = contacts.find(c => c.state === 'accepted' && c.id === record.connectionId && [c.requester, c.recipient].includes(peer.agentId!));
        if (!contact) { node.markHandled(message.senderId, message.id); continue; }
        if (message.senderId !== peer.agentId || message.id !== body.id || body.recipient !== own.id || record.sender !== peer.id || record.recipient !== own.id
          || message.connectionId !== record.connectionId || contact.id !== record.connectionId || body.expiresAt !== record.expiresAt || message.expiresAt !== record.expiresAt
          || body.createdAt !== record.createdAt || body.conversationId !== record.conversationId || body.inReplyTo !== record.inReplyTo || digest(body.text) !== record.textDigest)
          { node.markHandled(message.senderId, message.id); continue; }
        this.live(id); this.live(peer.id);
        this.store.delivered(record.id);
        node.retainInboxMessage(message.senderId, message.id);
      }
    }
  }
  async prepareEndpoint(id: string) { await this.node(id); return this.endpoint(this.store.grant(id)); }
  async close() {
    this.closed = true;
    await Promise.allSettled(this.#refreshing.values());
    await Promise.allSettled(this.#closing);
    for (const node of await Promise.allSettled(this.#nodes.values())) if (node.status === 'fulfilled') node.value.close();
    this.#nodes.clear();
  }
}
