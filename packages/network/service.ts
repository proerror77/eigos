import { NetworkCollaboration } from './collaboration.js';
import type { CollaborationLimits } from './collaboration-contracts.js';
import { NetworkDirectory } from './directory.js';
import { isDirectoryCommand, isDirectoryControl } from './directory-contracts.js';
import type { ExecutionCatalog } from '../core/catalog.js';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { ownerKey, DomainError, type Principal } from '../core/domain.js';
import { digest } from '../core/delegation.js';
import type { Member, MemberStore } from '../members/store.js';
import { NetworkStore } from './store.js';
import { NetworkError, fail, networkCommandSchema, controlCommandSchema, networkQuerySchema, receiptQuerySchema,
  type Content, type NetworkActor, type Draft, type Approval, type Grant, type Publication, type ResultRef, type Binding } from './contracts.js';

export interface NetworkQueryResult { spaceId?: string; profileId?: string; need?: { id: string; revision: number; contentRevision: number; state: string }; message?: { id: string; revision: number }; capabilityState?: ReturnType<NetworkDirectory['candidateState']>; version: number; content?: Content; visibleUntil?: string; items?: unknown[]; page?: { hasMore: boolean; cursor?: string }; result?: unknown; representations?: unknown[]; listings?: unknown[]; ref?: {kind: string; id: string; revision: number}; services?: unknown[]; hasMoreServices?: boolean }
export interface NetworkOptions { memberIds: string[]; operatorIds?: string[]; catalog?: ExecutionCatalog; collaborationLimits?: CollaborationLimits }
const iso = (time: number) => new Date(time).toISOString();
function fields(value: unknown, prefix = ''): string[] {
  if (value && typeof value === 'object' && !Array.isArray(value)) return Object.entries(value).flatMap(([key, child]) => fields(child, prefix + '/' + key));
  return [prefix];
}
const requiredCommand = { 'need.close': 'withdraw_own', 'draft.create': 'draft.create', 'draft.update': 'draft.edit', 'publication.request_approval': 'approval.request', 'publication.publish': 'publish', 'publication.withdraw': 'withdraw_own', 'publication.replace': 'publish', 'representation.request': 'directory.manage', 'listing.create': 'directory.manage', 'listing.update': 'directory.manage', 'listing.submit_review': 'directory.manage', 'listing.set_state': 'directory.manage' } as const;

/** No model, supplier, payment or task-dispatch access. All mutations are synchronous. */
export class NetworkService {
  readonly holder = randomUUID();
  readonly directory: NetworkDirectory;
  readonly collaboration: NetworkCollaboration;
  private timer: ReturnType<typeof setInterval>;
  private leaseLost = false;
  private cursorKey = randomBytes(32);
  constructor(readonly store: NetworkStore, private members: MemberStore, private options: NetworkOptions) {
    this.collaboration = new NetworkCollaboration(store, (pub, viewer) => !!this.baseView(pub, viewer), options.collaborationLimits);
    store.acquire(this.holder);
    this.directory = new NetworkDirectory(store, id => this.member(id), options.operatorIds ?? [], options.catalog);
    try { this.directory.bootstrap(options.memberIds, id => members.get(id)); } catch (error) { store.release(this.holder); throw error; }
    this.timer = setInterval(() => { try { store.renew(this.holder); } catch { this.leaseLost = true; } }, 3000);
    this.timer.unref();
    members.setRevocationObserver(change => store.fence(change.memberId, change.kind, change.target));
  }
  close() { clearInterval(this.timer); this.members.setRevocationObserver(undefined); this.store.release(this.holder); }
  private lease() { if (this.leaseLost) fail('NETWORK_LEASE_LOST', 503); this.store.assertLease(this.holder); }
  private member(memberId: string): Member {
    this.lease(); const m = this.members.get(memberId);
    if (!this.options.memberIds.includes(memberId) || m.status !== 'active') fail('NETWORK_MEMBERSHIP_REQUIRED', 403);
    this.store.checkFence(memberId); return m;
  }
  private identity(p: Principal, token: string, scope: string) {
    this.lease();
    if (!p.scopes.includes(scope)) fail('SCOPE_REQUIRED', 403);
    const m = this.members.find(p); if (!m) return fail('NETWORK_MEMBERSHIP_REQUIRED', 403);
    this.member(m.id);
    // Read-only rechecks inside the business transaction avoid a cross-database write lock cycle.
    if (this.members.connections(m.id).some(c => c.clientId === p.clientId && c.blocked)) fail('ACCESS_REVOKED', 403);
    const installation = this.members.agents.authorize(p, token);
    this.store.checkFence(m.id, installation.id, p.clientId);
    return { member: m, installation };
  }
  actor(p: Principal, token: string, profileId: string, scope: string, command?: string): NetworkActor {
    const { member: m, installation } = this.identity(p, token, scope), owner = ownerKey(p);
    this.directory.profile(profileId, owner);
    const b = this.store.binding(owner, profileId, installation.id);
    if (b.clientId !== p.clientId || command && !b.allowedCommands.includes(command)) fail('ACTOR_NOT_BOUND', 403);
    return { owner, memberId: m.id, installationId: installation.id, clientId: p.clientId, profileId, bindingId: b.id, bindingRevision: b.revision };
  }
  private encodeCursor(context: string, last: string): string {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.cursorKey, iv);
    const body = Buffer.from(JSON.stringify({ context, last, expires: this.store.now() + 900000 }));
    const encrypted = Buffer.concat([cipher.update(body), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
  }
  private decodeCursor(cursor: string | undefined, context: string): string {
    if (!cursor) return '';
    try {
      const raw = Buffer.from(cursor, 'base64url');
      if (raw.length < 29 || raw.toString('base64url') !== cursor) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.cursorKey, raw.subarray(0, 12)); decipher.setAuthTag(raw.subarray(12, 28));
      const c = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString());
      if (c.context !== context || typeof c.last !== 'string' || !Number.isFinite(c.expires) || c.expires <= this.store.now()) throw new Error();
      return c.last;
    } catch { return fail('CURSOR_STALE'); }
  }
  private actorKey(a: NetworkActor) { return digest([a.owner, a.installationId, a.profileId]); }
  private boundDraft(a: NetworkActor, id: string): Draft {
    const d = this.store.get('draft', id, a.owner);
    if (d.profileId !== a.profileId || d.bindingId !== a.bindingId || d.bindingRevision !== a.bindingRevision) fail('NOT_FOUND', 404);
    return d;
  }
  private validBinding(bindingId: string, owner: string): Binding {
    const b = this.store.get('binding', bindingId, owner), m = this.member(b.memberId);
    this.directory.profile(b.profileId, owner);
    if (b.revoked) fail('ACTOR_NOT_BOUND', 403);
    const reg = this.members.agents.list(m.id).find(r => r.id === b.installationId);
    if (!reg || reg.revoked || reg.clientId !== b.clientId || this.members.connections(m.id).some(c => c.clientId === b.clientId && c.blocked)) fail('ACCESS_REVOKED', 403);
    this.store.checkFence(m.id, b.installationId, b.clientId); return b;
  }
  private timeWindow(d: Draft, publishBefore: string, visibleUntil: string) {
    const now = this.store.now(), before = Date.parse(publishBefore), until = Date.parse(visibleUntil);
    if (before <= now || before > now + 86400000 || until <= now || until > now + 604800000 || before > until) fail('INVALID_PUBLICATION_WINDOW', 422);
    if (d.content.kind === 'need' && until > Date.parse(d.content.body.replyDeadline)) fail('INVALID_PUBLICATION_WINDOW', 422);
  }
  private approvalMaterial(r: Omit<Approval, 'reviewDigest' | 'status' | 'grantId'>) { return digest(r); }
  private currentApproval(r: Approval): Draft {
    const d = this.store.get('draft', r.draftId, r.owner), b = this.validBinding(r.bindingId, r.owner);
    if (d.revision !== r.draftRevision || digest(d.content) !== r.contentDigest || b.revision !== r.bindingRevision || d.bindingId !== b.id) fail('REVIEW_STALE');
    this.directory.validAudience(r, b.memberId);
    this.directory.validateContent(d.content, d.owner, d.profileId);
    this.collaboration.validate(d.content, b.memberId, r, r.replacementId ? this.store.get('publication', r.replacementId, r.owner) : undefined);
    if (r.replacementId) this.replacement(d, r.owner, r.spaceId, r.replacementId, r.replacementRevision!);
    else if (d.content.kind !== 'need' && this.activeResource(d, r.spaceId).length) fail('PUBLICATION_EXISTS');
    this.timeWindow(d, r.publishBefore, r.visibleUntil);
    return d;
  }
  private resolveContent(input: { kind: string; [key: string]: unknown }, a: NetworkActor): Content {
    return input.kind === 'listing' ? this.directory.listingContent(String(input.listingId), Number(input.listingRevision), a.owner, a.profileId) : input as Content;
  }
  private sameResource(content: Content, profileId: string, other: Publication) {
    if (content.kind !== other.content.kind || profileId !== other.profileId) return false;
    if (content.kind === 'listing' && other.content.kind === 'listing') return content.listingId === other.content.listingId;
    return content.kind === 'profile';
  }
  private activeResource(d: Draft, spaceId: string) {
    return this.store.list('publication', d.owner).filter(p => p.state === 'active' && this.sameResource(d.content, d.profileId, p) && this.store.get('grant', p.grantId, d.owner).spaceId === spaceId);
  }
  private replacement(d: Draft, owner: string, spaceId: string, id: string, revision: number): Publication {
    const old = this.store.get('publication', id, owner);
    const same = this.sameResource(d.content, d.profileId, old) || d.profileId === old.profileId && this.collaboration.replacement(d.content, old);
    if (!same || this.store.get('grant', old.grantId, owner).spaceId !== spaceId) return fail('INVALID_REPLACEMENT');
    if (old.state !== 'active' || old.revision !== revision || (d.content.kind === 'profile' || d.content.kind === 'listing') && this.activeResource(d, spaceId).length !== 1) return fail('REVISION_CONFLICT');
    return old;
  }
  private controlView(memberId: string, owner: string, ref: ResultRef): unknown {
    if (['space', 'membership', 'invitation', 'representation', 'listing'].includes(ref.kind)) {
      const record = this.store.get(ref.kind, ref.id);
      const manages = (spaceId: string) => {
        if (this.directory.isOperator(memberId)) return true;
        const membership = this.store.scan('membership', { spaceId, memberId }, '', 1)[0];
        return membership?.state === 'active' && membership.role === 'moderator';
      };
      if (ref.kind === 'space' && !manages(ref.id)) return fail('NOT_FOUND', 404);
      if (ref.kind === 'invitation') {
        const i = this.store.get('invitation', ref.id);
        if (i.memberId !== memberId && !manages(i.spaceId)) return fail('NOT_FOUND', 404);
      }
      if (ref.kind === 'membership') {
        const m = this.store.get('membership', ref.id);
        if (m.memberId !== memberId && !manages(m.spaceId)) return fail('NOT_FOUND', 404);
      }
      if ((ref.kind === 'representation' || ref.kind === 'listing') && record.owner !== owner && !this.directory.isOperator(memberId)) return fail('NOT_FOUND', 404);
      const { owner: _owner, ...safe } = record; return safe;
    }
    return this.ownView(owner, ref);
  }
  command(p: Principal, token: string, input: unknown) {
    const args = networkCommandSchema.parse(input);
    let actor = this.actor(p, token, args.asProfileId, 'network:write', requiredCommand[args.operation]);
    const committed = this.store.once(this.actorKey(actor), args.operation, args.requestId, args, () => {
      actor = this.actor(p, token, args.asProfileId, 'network:write', requiredCommand[args.operation]);
    }, () => {
      const a = actor;
      if (args.operation === 'need.close') return this.collaboration.close(a, args.postId, args.expectedRevision);
      if (isDirectoryCommand(args)) return this.directory.command(a, args);
      if (args.operation === 'draft.create') {
        this.store.quota('draft', a.owner);
        const d: Draft = { id: randomUUID(), owner: a.owner, profileId: a.profileId, bindingId: a.bindingId, bindingRevision: a.bindingRevision, content: this.resolveContent(args.content, a), revision: 1, approved: false };
        this.collaboration.validate(d.content, a.memberId);
        this.store.put('draft', d); this.store.event('draft_created', d.id); return [{ kind: 'draft', id: d.id }];
      }
      if (args.operation === 'draft.update') {
        const d = this.boundDraft(a, args.draftId);
        if (d.revision !== args.expectedRevision) fail('REVISION_CONFLICT');
        if (d.approved) fail('APPROVED_DRAFT_IMMUTABLE');
        if (d.content.kind !== args.content.kind) fail('INVALID_INPUT', 422);
        d.content = this.resolveContent(args.content, a); this.collaboration.validate(d.content, a.memberId); d.revision++; this.store.put('draft', d); this.store.event('draft_updated', d.id); return [{ kind: 'draft', id: d.id }];
      }
      if (args.operation === 'publication.request_approval') {
        const d = this.boundDraft(a, args.draftId);
        if (d.revision !== args.expectedRevision) fail('REVISION_CONFLICT');
        if (d.approved) fail('APPROVED_DRAFT_IMMUTABLE');
        this.timeWindow(d, args.publishBefore, args.visibleUntil); this.store.quota('approval', a.owner);
        const spaceId = args.spaceId ?? this.store.spaceId;
        const audience = this.directory.audience(spaceId, a.memberId, args.recipientMemberIds);
        this.directory.validateContent(d.content, d.owner, d.profileId);
        this.collaboration.validate(d.content, a.memberId, { spaceId, recipientMemberIds: args.recipientMemberIds, visibleUntil: args.visibleUntil }, args.replacementId ? this.store.get('publication', args.replacementId, a.owner) : undefined);
        if (!!args.replacementId !== !!args.replacementRevision) fail('INVALID_INPUT', 422);
        if (args.replacementId) this.replacement(d, a.owner, spaceId, args.replacementId, args.replacementRevision!);
        else if (d.content.kind !== 'need' && this.activeResource(d, spaceId).length) fail('PUBLICATION_EXISTS');
        const material = { id: randomUUID(), owner: a.owner, profileId: a.profileId, draftId: d.id, draftRevision: d.revision, bindingId: a.bindingId, bindingRevision: a.bindingRevision,
          contentDigest: digest(d.content), ...audience, spaceId, ...(args.replacementId ? { replacementId: args.replacementId, replacementRevision: args.replacementRevision } : {}), publishBefore: args.publishBefore, visibleUntil: args.visibleUntil };
        const r: Approval = { ...material, reviewDigest: this.approvalMaterial(material), status: 'pending' };
        this.store.put('approval', r); return [{ kind: 'approval', id: r.id }];
      }
      if (args.operation === 'publication.publish' || args.operation === 'publication.replace') {
        const d = this.boundDraft(a, args.draftId), g = this.store.get('grant', args.grantId, a.owner);
        if (g.status !== 'approved') fail(g.status === 'consumed' ? 'GRANT_CONSUMED' : 'GRANT_REVOKED');
        if (d.revision !== args.expectedRevision || g.draftId !== d.id || g.draftRevision !== d.revision || g.contentDigest !== digest(d.content)) fail('CONTENT_CHANGED');
        if (g.bindingId !== a.bindingId || g.bindingRevision !== a.bindingRevision || g.profileId !== a.profileId) fail('ACTOR_NOT_BOUND', 403);
        this.currentApproval({ ...g, status: 'approved' }); this.store.quota('publication', a.owner);
        const replacing = args.operation === 'publication.replace';
        if (g.action !== (replacing ? 'replace_publication' : 'publish')) fail('GRANT_ACTION_MISMATCH');
        let previous: Publication | undefined;
        if (replacing) {
          if (g.replacementId !== args.previousPublicationId || g.replacementRevision !== args.previousRevision) fail('CONTENT_CHANGED');
          const old = this.replacement(d, a.owner, g.spaceId, args.previousPublicationId, args.previousRevision);
          previous = old; old.state = 'superseded'; old.revision++; this.store.put('publication', old);
        } else if (d.content.kind !== 'need' && this.activeResource(d, g.spaceId).length) fail('PUBLICATION_EXISTS');
        const pub: Publication = { id: randomUUID(), owner: a.owner, memberId: a.memberId, profileId: a.profileId, draftId: d.id, grantId: g.id,
          content: structuredClone(d.content), revision: 1, state: 'active', visibleUntil: g.visibleUntil, recipientMemberIds: [...g.recipientMemberIds] };
        this.collaboration.published(pub, previous);
        g.status = 'consumed'; g.usedPublicationId = pub.id; g.revision++;
        this.store.put('publication', pub); this.store.put('grant', g); this.store.event('published', pub.id);
        return [{ kind: 'publication', id: pub.id }];
      }
      const pub = this.store.get('publication', args.publicationId, a.owner);
      if (pub.profileId !== a.profileId) fail('NOT_FOUND', 404);
      if (pub.revision !== args.expectedRevision) fail('REVISION_CONFLICT');
      this.collaboration.withdraw(pub); pub.state = 'retracted'; pub.revision++; this.store.put('publication', pub); this.store.event('retracted', pub.id);
      return [{ kind: 'publication', id: pub.id }];
    });
    return { version: 1, requestId: args.requestId, ...committed, result: committed.refs.map(ref => this.ownView(actor.owner, ref)) };
  }
  control(memberId: string, input: unknown) {
    const args = controlCommandSchema.parse(input); const member = this.member(memberId), owner = ownerKey({ ...member, clientId: '', scopes: [] });
    const committed = this.store.once(digest([owner, 'controller']), args.action, args.requestId, args, () => { this.member(memberId); }, () => {
      if (isDirectoryControl(args)) return this.directory.control(memberId, owner, args);
      if (args.action === 'profile.create') {
        this.store.quota('profile', owner); const id = randomUUID();
        this.store.put('profile', { id, owner, memberId, displayName: args.displayName, revision: 1, state: 'active' }); return [{ kind: 'profile', id }];
      }
      if (args.action === 'profile.bind_installation') {
        this.directory.profile(args.profileId, owner);
        const reg = this.members.agents.list(memberId).find(r => r.id === args.installationId && !r.revoked);
        if (!reg?.clientId) return fail('ACTOR_NOT_BOUND', 403);
        if (this.members.connections(memberId).some(c => c.clientId === reg.clientId && c.blocked)) return fail('ACTOR_NOT_BOUND', 403);
        this.store.checkFence(memberId, reg.id, reg.clientId);
        if (this.store.list('binding', owner).some(b => b.profileId === args.profileId && b.installationId === reg.id && !b.revoked)) fail('BINDING_EXISTS');
        this.store.quota('binding', owner);
        const b: Binding = { id: randomUUID(), owner, memberId, profileId: args.profileId, installationId: reg.id, clientId: reg.clientId, allowedCommands: args.allowedCommands, revision: 1, revoked: false };
        this.store.put('binding', b); return [{ kind: 'binding', id: b.id }];
      }
      if (args.action === 'profile.revoke_binding') {
        const b = this.store.get('binding', args.bindingId, owner);
        if (b.revision !== args.expectedRevision) fail('REVISION_CONFLICT');
        b.revoked = true; b.revision++; this.store.put('binding', b); this.store.event('binding_revoked', b.id); return [{ kind: 'binding', id: b.id }];
      }
      if (args.action === 'publication.approve') {
        const r = this.store.get('approval', args.approvalRequestId, owner);
        if (r.status !== 'pending') fail('REVIEW_STALE');
        if (args.reviewDigest !== r.reviewDigest || args.expectedDraftRevision !== r.draftRevision) fail('REVIEW_STALE');
        const d = this.currentApproval(r);
        if (d.approved) fail('REVIEW_STALE'); this.store.quota('grant', owner);
        const { status: _status, grantId: _grant, ...material } = r;
        const g: Grant = { ...material, id: randomUUID(), version: 1, schemaVersion: 'eigos.network.publication@1', purpose: d.content.kind === 'profile' ? 'profile_discovery' : d.content.kind === 'listing' ? 'service_discovery' : 'request_collaboration', action: r.replacementId ? 'replace_publication' : 'publish', allowedFields: fields(d.content.body), approvedBy: memberId, approvedAt: iso(this.store.now()), status: 'approved', revision: 1, maxUses: 1 };
        r.status = 'approved'; r.grantId = g.id; d.approved = true;
        this.store.put('grant', g); this.store.put('approval', r); this.store.put('draft', d); return [{ kind: 'grant', id: g.id }];
      }
      const g = this.store.get('grant', args.grantId, owner);
      if (g.revision !== args.expectedRevision) fail('REVISION_CONFLICT');
      g.status = 'revoked'; g.revokedAt = iso(this.store.now()); g.revision++; this.store.put('grant', g);
      if (g.usedPublicationId) { const pub = this.store.get('publication', g.usedPublicationId, owner); this.collaboration.withdraw(pub); pub.state = 'retracted'; pub.revision++; this.store.put('publication', pub); this.store.event('grant_revoked', pub.id); }
      return [{ kind: 'grant', id: g.id }];
    });
    return { version: 1, requestId: args.requestId, ...committed, result: committed.refs.map(ref => this.controlView(memberId, owner, ref)) };
  }
  private ownView(owner: string, ref: ResultRef): unknown {
    const record = this.store.get(ref.kind, ref.id, owner);
    if (ref.kind === 'need') return this.collaboration.view(this.store.get('need', ref.id, owner));
    if (ref.kind === 'publication') {
      const pub = record as Publication, grant = this.store.get('grant', pub.grantId, owner);
      // Never replay content which has since expired or been revoked.
      return { id: pub.id, kind: ref.kind, revision: pub.revision, state: pub.state === 'active' && grant.status !== 'revoked' && Date.parse(pub.visibleUntil) > this.store.now() ? 'active' : 'unavailable' };
    }
    const { owner: _owner, ...safe } = record;
    return safe;
  }
  query(p: Principal, token: string, input: unknown): NetworkQueryResult {
    const args = networkQuerySchema.parse(input);
    if (['get', 'spaces', 'profile', 'listing', 'search', 'need', 'messages'].includes(args.kind)) {
      const { member } = this.identity(p, token, 'network:read');
      return this.directoryQuery(member.id, args);
    }
    if (args.kind !== 'my_drafts' && args.kind !== 'my_approval_request' && args.kind !== 'my_directory') return fail('INVALID_INPUT', 422);
    const a = this.actor(p, token, args.asProfileId, 'network:read');
    if (args.kind === 'my_directory') return { version: 1, representations: this.store.list('representation', a.owner).filter(r => r.profileId === a.profileId).map(r => this.ownView(a.owner, { kind: 'representation', id: r.id })), listings: this.store.list('listing', a.owner).filter(l => l.profileId === a.profileId).map(l => this.ownView(a.owner, { kind: 'listing', id: l.id })) };
    if (args.kind === 'my_drafts') {
      const rows = this.store.list('draft', a.owner).filter(d => d.profileId === a.profileId && d.bindingId === a.bindingId && d.bindingRevision === a.bindingRevision);
      const context = digest([this.actorKey(a), a.bindingRevision, rows.map(d => [d.id, d.revision, d.approved])]);
      const after = this.decodeCursor(args.cursor, context);
      const remaining = rows.filter(d => d.id > after), items: unknown[] = []; let bytes = 0, last = after;
      for (const d of remaining) {
        const view = this.ownView(a.owner, { kind: 'draft', id: d.id }), size = Buffer.byteLength(JSON.stringify(view));
        if (items.length === args.limit || bytes + size > 60000) break;
        items.push(view); bytes += size; last = d.id;
      }
      const hasMore = remaining.length > items.length;
      const cursor = hasMore ? this.encodeCursor(context, last) : undefined;
      return { version: 1, items, page: { hasMore, cursor } };
    }
    const r = this.store.get('approval', args.approvalRequestId, a.owner);
    if (r.profileId !== a.profileId || r.bindingId !== a.bindingId || r.bindingRevision !== a.bindingRevision) fail('NOT_FOUND', 404);
    return { version: 1, result: this.ownView(a.owner, { kind: 'approval', id: r.id }) };
  }
  private baseView(pub: Publication, viewerId: string) {
    try {
      const grant = this.store.get('grant', pub.grantId);
      if (pub.state !== 'active' || grant.status !== 'consumed' || grant.usedPublicationId !== pub.id || Date.parse(pub.visibleUntil) <= this.store.now()) return undefined;
      this.directory.profile(pub.profileId, pub.owner); this.directory.mayRead(grant, pub.memberId, viewerId);
      this.directory.validateContent(pub.content, pub.owner, pub.profileId);
      const content = pub.content;
      return { version: 1, ref: { kind: 'publication', id: pub.id, revision: pub.revision }, profileId: pub.profileId, spaceId: grant.spaceId, content, visibleUntil: pub.visibleUntil,
        ...(content.kind === 'listing' ? { capabilityState: this.directory.candidateState(content.listingId, ownerKey({ ...this.member(viewerId), clientId: '', scopes: [] })) } : {}) };
    } catch (error) {
      if (error instanceof NetworkError && error.status < 500 && error.status !== 429 || error instanceof DomainError) return undefined;
      throw error;
    }
  }
  private publicView(pub: Publication, viewerId: string): NetworkQueryResult | undefined {
    const base = this.baseView(pub, viewerId); if (!base) return undefined;
    try {
      if (!this.collaboration.readable(pub, viewerId)) return undefined;
      return { ...base, ...(pub.content.kind === 'need' ? { need: this.collaboration.view(this.collaboration.need(pub.needId ?? pub.id)) } : {}),
        ...(pub.content.kind === 'message' ? { message: { id: pub.messageId ?? pub.id, revision: this.store.get('message', pub.messageId ?? pub.id).revision } } : {}) };
    } catch (error) {
      if (error instanceof NetworkError && error.status < 500 || error instanceof DomainError) return undefined;
      throw error;
    }
  }
  directoryQuery(memberId: string, input: unknown): NetworkQueryResult {
    this.member(memberId); const args = networkQuerySchema.parse(input);
    if (args.kind === 'get') return this.publicView(this.store.get('publication', args.publicationId), memberId) ?? fail('NOT_FOUND', 404);
    if (args.kind === 'need' || args.kind === 'messages') {
      const n = this.collaboration.need(args.postId), visible = this.publicView(this.store.get('publication', n.currentPublicationId), memberId);
      if (!visible) return fail('NOT_FOUND', 404);
      if (args.kind === 'need') return visible;
      const context = digest([memberId, n.id, this.store.visibilityRevision(), { ...args, cursor: undefined }]);
      const after = this.decodeCursor(args.cursor, context);
      const rows = this.store.scan('publication', { 'content.kind': 'message', 'content.body.postId': n.id, state: 'active' }, after);
      const items = []; let bytes = 0, scanned = 0, last = after;
      for (const pub of rows) {
        if (scanned === 200 || items.length === args.limit) break;
        const view = this.publicView(pub, memberId);
        if (view) { const size = Buffer.byteLength(JSON.stringify(view)); if (bytes + size > 60000) break; items.push(view); bytes += size; }
        scanned++; last = pub.id;
      }
      const hasMore = rows.length > scanned;
      return { version: 1, items, page: { hasMore, cursor: hasMore ? this.encodeCursor(context, last) : undefined } };
    }
    if (args.kind === 'spaces') return { version: 1, items: this.directory.spaces(memberId) };
    if (args.kind !== 'profile' && args.kind !== 'listing' && args.kind !== 'search') return fail('INVALID_INPUT', 422);
    const access = this.directory.assertMember(args.spaceId, memberId);
    if (args.kind === 'profile' || args.kind === 'listing') {
      const rows = args.kind === 'profile' ? this.store.scan('publication', { profileId: args.profileId, 'content.kind': 'profile', state: 'active' }) : this.store.scan('publication', { 'content.listingId': args.listingId, state: 'active' });
      const visible = rows.map(p => this.publicView(p, memberId)).find(v => v?.spaceId === args.spaceId);
      if (!visible) return fail('NOT_FOUND', 404);
      if (args.kind === 'listing') return visible;
      const services = this.store.scan('publication', { profileId: args.profileId, 'content.kind': 'listing', state: 'active' }).map(p => this.publicView(p, memberId)).filter(v => v?.spaceId === args.spaceId);
      const items = []; let bytes = Buffer.byteLength(JSON.stringify(visible));
      for (const v of services) { const size = Buffer.byteLength(JSON.stringify(v)); if (items.length >= 20 || bytes + size > 60000) break; items.push(v); bytes += size; }
      return { ...visible, services: items, hasMoreServices: services.length > items.length };
    }
    const context = digest([memberId, access.space.epoch, access.membership.generation, this.store.visibilityRevision(), { ...args, cursor: undefined }]);
    const after = this.decodeCursor(args.cursor, context);
    const rows = this.store.scan('publication', { 'content.kind': args.objectKind, state: 'active' }, after);
    const items = []; let bytes = 0, scanned = 0, last = after;
    for (const pub of rows) {
      if (scanned === 200 || items.length === args.limit) break;
      scanned++; const view = this.publicView(pub, memberId);
      if (view?.spaceId === args.spaceId) {
        const content = view.content!; const body = content.body;
        const text = JSON.stringify(body).toLowerCase();
        const matches = (!args.search || text.includes(args.search.toLowerCase())) && (!args.capabilityId || content.kind === 'listing' && content.body.capabilityRef.id === args.capabilityId)
          && (!args.coarseArea || content.kind === 'listing' && content.body.coarseAreas.includes(args.coarseArea) || content.kind === 'need' && content.body.coarseArea === args.coarseArea)
          && (!args.category || content.kind === 'need' && content.body.category === args.category);
        if (matches) { const size = Buffer.byteLength(JSON.stringify(view)); if (bytes + size > 60000) { scanned--; break; } items.push(view); bytes += size; }
      }
      last = pub.id;
    }
    const hasMore = rows.length > scanned;
    return { version: 1, items, page: { hasMore, cursor: hasMore ? this.encodeCursor(context, last) : undefined } };
  }

  receipt(p: Principal, token: string, input: unknown) {
    const args = receiptQuerySchema.parse(input), a = this.actor(p, token, args.asProfileId, 'network:read');
    const r = this.store.receipt(this.actorKey(a), args.operation, args.requestId);
    if (!r) return fail('NOT_FOUND', 404);
    return { version: 1, refs: r.refs, result: r.refs.map(ref => this.ownView(a.owner, ref)) };
  }
  panel(memberId: string) {
    const m = this.member(memberId), owner = ownerKey({ ...m, clientId: '', scopes: [] });
    const spaces = this.directory.spaces(memberId), operator = this.directory.isOperator(memberId);
    const managedSpaces = operator ? this.store.scan('space').map(s => ({ id: s.id, name: s.name, revision: s.revision, state: s.state, role: 'operator' })) : this.store.scan('membership', { memberId, state: 'active' }).filter(m => m.role === 'moderator').map(m => { const s = this.store.get('space', m.spaceId); return { id: s.id, name: s.name, revision: s.revision, state: s.state, role: m.role }; });
    const knownMembers = new Set([memberId, ...spaces.flatMap(s => this.store.scan('membership', { spaceId: s.id, state: 'active' }).map(m => m.memberId))]);
    return { operator, spaces, invitations: this.store.scan('invitation', { memberId, state: 'pending' }),
      spaceMembers: managedSpaces.map(s => ({ space: s, memberships: this.store.scan('membership', { spaceId: s.id }) })),
      representations: this.directory.isOperator(memberId) ? this.store.scan('representation') : this.store.list('representation', owner),
      listings: this.directory.isOperator(memberId) ? this.store.scan('listing') : this.store.list('listing', owner),
      profiles: this.store.list('profile', owner), bindings: this.store.list('binding', owner), grants: this.store.list('grant', owner),
      approvals: this.store.list('approval', owner).map(r => ({ ...r, content: this.store.get('draft', r.draftId, owner).content })),
      installations: this.members.agents.list(memberId).filter(r => !r.revoked),
      recipients: this.options.memberIds.filter(id => operator || knownMembers.has(id)).flatMap(id => { try { const member = this.member(id); return [{ id, displayName: member.displayName }]; } catch { return []; } }), spaceId: this.store.spaceId };
  }
}
