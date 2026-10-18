import { z } from 'zod';
import { NetworkEvidence } from './evidence.js';
import { InquiryBridge } from './inquiry.js';
import type { JobStore } from '../core/store.js';
import type { TaskService } from '../core/tasks.js';
import { NetworkActivity } from './activity.js';
import { updatesQuerySchema } from './activity-contracts.js';
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
export interface NetworkOptions { memberIds: string[]; operatorIds?: string[]; catalog?: ExecutionCatalog; collaborationLimits?: CollaborationLimits; jobs?: JobStore; tasks?: TaskService }
const iso = (time: number) => new Date(time).toISOString();
function fields(value: unknown, prefix = ''): string[] {
  if (value && typeof value === 'object' && !Array.isArray(value)) return Object.entries(value).flatMap(([key, child]) => fields(child, prefix + '/' + key));
  return [prefix];
}
const requiredCommand = { 'evidence.prepare': 'evidence.manage', 'evidence.refresh': 'evidence.manage', 'inquiry.request_conversion': 'inquiry.manage', 'inquiry.request_selection': 'inquiry.manage', 'inquiry.convert': 'inquiry.manage', 'inquiry.select_quote': 'inquiry.manage', 'follow.set': 'follow.manage', 'need.close': 'withdraw_own', 'draft.create': 'draft.create', 'draft.update': 'draft.edit', 'publication.request_approval': 'approval.request', 'publication.publish': 'publish', 'publication.withdraw': 'withdraw_own', 'publication.replace': 'publish', 'representation.request': 'directory.manage', 'listing.create': 'directory.manage', 'listing.update': 'directory.manage', 'listing.submit_review': 'directory.manage', 'listing.set_state': 'directory.manage' } as const;

/** No model or supplier calls. Private Task submission shares the transaction; only Worker executes. */
export class NetworkService {
  readonly holder = randomUUID();
  readonly directory: NetworkDirectory;
  readonly collaboration: NetworkCollaboration;
  readonly activity: NetworkActivity;
  readonly inquiry?: InquiryBridge;
  readonly evidence?: NetworkEvidence;
  private timer: ReturnType<typeof setInterval>;
  private leaseLost = false;
  private cursorKey = randomBytes(32);
  constructor(readonly store: NetworkStore, private members: MemberStore, private options: NetworkOptions) {
    this.activity = new NetworkActivity(store, (pub, viewer) => this.publicView(pub, viewer), (profileId, spaceId, memberId) => { this.directoryQuery(memberId, { version: 1, kind: 'profile', profileId, spaceId }); });
    this.collaboration = new NetworkCollaboration(store, (pub, viewer) => !!this.baseView(pub, viewer), options.collaborationLimits);
    if (options.jobs && options.tasks && options.catalog) this.inquiry = new InquiryBridge(store, options.jobs, options.tasks, options.catalog, (memberId, input) => this.directoryQuery(memberId, input), (id, owner) => this.validBinding(id, owner));
    if (options.jobs && options.catalog) this.evidence = new NetworkEvidence(store, options.jobs, options.catalog);
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
    this.validateEvidence(d.content, d.owner, d.profileId);
    this.collaboration.validate(d.content, b.memberId, r, r.replacementId ? this.store.get('publication', r.replacementId, r.owner) : undefined);
    if (r.replacementId) this.replacement(d, r.owner, r.spaceId, r.replacementId, r.replacementRevision!);
    else if (d.content.kind !== 'need' && this.activeResource(d, r.spaceId).length) fail('PUBLICATION_EXISTS');
    this.timeWindow(d, r.publishBefore, r.visibleUntil);
    return d;
  }
  private resolveContent(input: { kind: string; [key: string]: unknown }, a: NetworkActor): Content {
    if (input.kind === 'evidence_card') return this.evidenceService().content(a.owner, a.profileId, String(input.cardId), Number(input.cardRevision));
    return input.kind === 'listing' ? this.directory.listingContent(String(input.listingId), Number(input.listingRevision), a.owner, a.profileId) : input as Content;
  }
  private sameResource(content: Content, profileId: string, other: Publication) {
    if (content.kind !== other.content.kind || profileId !== other.profileId) return false;
    if (content.kind === 'evidence_card' && other.content.kind === 'evidence_card') return content.cardId === other.content.cardId;
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
    if (old.state !== 'active' || old.revision !== revision || (d.content.kind === 'profile' || d.content.kind === 'listing' || d.content.kind === 'evidence_card') && this.activeResource(d, spaceId).length !== 1) return fail('REVISION_CONFLICT');
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
  private validateEvidence(content: Content, owner: string, profileId: string) { if (content.kind === 'evidence_card') this.evidenceService().validate(content, owner, profileId); }
  private evidenceService() { return this.evidence ?? fail('EVIDENCE_UNAVAILABLE', 503); }
  private evidenceScope(p: Principal, a: NetworkActor) {
    if (!p.scopes.includes('tasks:read')) fail('SCOPE_REQUIRED', 403);
    if (!this.store.get('binding', a.bindingId, a.owner).allowedCommands.includes('evidence.manage')) fail('ACTOR_NOT_BOUND', 403);
  }
  private inquiryService() { return this.inquiry ?? fail('INQUIRY_UNAVAILABLE', 503); }
  private inquiryScope(p: Principal) { if (!p.scopes.includes('tasks:write') || !p.scopes.includes('tasks:read')) fail('SCOPE_REQUIRED', 403); }
  command(p: Principal, token: string, input: unknown) {
    const args = networkCommandSchema.parse(input);
    if (args.operation.startsWith('inquiry.')) this.inquiryScope(p);
    if (args.operation.startsWith('evidence.') && !p.scopes.includes('tasks:read')) fail('SCOPE_REQUIRED', 403);
    let actor = this.actor(p, token, args.asProfileId, 'network:write', requiredCommand[args.operation]);
    const committed = this.store.once(this.actorKey(actor), args.operation, args.requestId, args, () => {
      if (args.operation.startsWith('inquiry.')) this.inquiryScope(p);
      if (args.operation.startsWith('evidence.') && !p.scopes.includes('tasks:read')) fail('SCOPE_REQUIRED', 403);
      actor = this.actor(p, token, args.asProfileId, 'network:write', requiredCommand[args.operation]);
      if ((args.operation === 'draft.create' || args.operation === 'draft.update') && args.content.kind === 'evidence_card') this.evidenceScope(p, actor);
      if ('draftId' in args && this.boundDraft(actor, args.draftId).content.kind === 'evidence_card') this.evidenceScope(p, actor);
    }, () => {
      const a = actor;
      if (args.operation === 'evidence.prepare' || args.operation === 'evidence.refresh') {
        this.evidenceScope(p, a);
        return args.operation === 'evidence.prepare' ? this.evidenceService().prepare(a, args.source, args.projection) : this.evidenceService().refresh(a, args.cardId, args.expectedRevision, args.projection);
      }
      if (args.operation === 'inquiry.request_conversion') return this.inquiryService().request(a, 'convert', args.input);
      if (args.operation === 'inquiry.request_selection') return this.inquiryService().request(a, 'select_quote', args.input);
      if (args.operation === 'inquiry.convert' || args.operation === 'inquiry.select_quote') return this.inquiryService().apply(p, a, args.choiceId, args.operation === 'inquiry.convert' ? 'convert' : 'select_quote');
      if (args.operation === 'follow.set') return this.activity.follow(a, args);
      if (args.operation === 'need.close') return this.collaboration.close(a, args.postId, args.expectedRevision);
      if (isDirectoryCommand(args)) return this.directory.command(a, args);
      if (args.operation === 'draft.create') {
        if (args.content.kind === 'evidence_card') this.evidenceScope(p, a);
        this.store.quota('draft', a.owner);
        const d: Draft = { id: randomUUID(), owner: a.owner, profileId: a.profileId, bindingId: a.bindingId, bindingRevision: a.bindingRevision, content: this.resolveContent(args.content, a), revision: 1, approved: false };
        this.collaboration.validate(d.content, a.memberId);
        this.store.put('draft', d); this.store.event('draft_created', d.id); return [{ kind: 'draft', id: d.id }];
      }
      if (args.operation === 'draft.update') {
        const d = this.boundDraft(a, args.draftId);
        if (d.content.kind === 'evidence_card') this.evidenceScope(p, a);
        if (d.revision !== args.expectedRevision) fail('REVISION_CONFLICT');
        if (d.approved) fail('APPROVED_DRAFT_IMMUTABLE');
        if (d.content.kind !== args.content.kind) fail('INVALID_INPUT', 422);
        d.content = this.resolveContent(args.content, a); this.collaboration.validate(d.content, a.memberId); d.revision++; this.store.put('draft', d); this.store.event('draft_updated', d.id); return [{ kind: 'draft', id: d.id }];
      }
      if (args.operation === 'publication.request_approval') {
        const d = this.boundDraft(a, args.draftId);
        if (d.content.kind === 'evidence_card') this.evidenceScope(p, a);
        if (d.revision !== args.expectedRevision) fail('REVISION_CONFLICT');
        if (d.approved) fail('APPROVED_DRAFT_IMMUTABLE');
        this.timeWindow(d, args.publishBefore, args.visibleUntil); this.store.quota('approval', a.owner);
        const spaceId = args.spaceId ?? this.store.spaceId;
        const audience = this.directory.audience(spaceId, a.memberId, args.recipientMemberIds);
        this.directory.validateContent(d.content, d.owner, d.profileId);
        this.validateEvidence(d.content, d.owner, d.profileId);
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
        if (d.content.kind === 'evidence_card') this.evidenceScope(p, a);
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
          previous = old; old.state = 'superseded'; old.revision++; this.store.put('publication', old); this.store.event('superseded', old.id);
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
      this.collaboration.withdraw(pub); this.evidence?.withdrawPending(pub); pub.state = 'retracted'; pub.revision++; this.store.put('publication', pub); this.store.event('retracted', pub.id);
      return [{ kind: 'publication', id: pub.id }];
    });
    return { version: 1, requestId: args.requestId, ...committed, result: committed.refs.map(ref => this.ownView(actor.owner, ref)) };
  }
  control(memberId: string, input: unknown) {
    const args = controlCommandSchema.parse(input); const member = this.member(memberId), owner = ownerKey({ ...member, clientId: '', scopes: [] });
    const committed = this.store.once(digest([owner, 'controller']), args.action, args.requestId, args, () => { this.member(memberId); }, () => {
      if (args.action === 'inquiry.revoke_choice') return this.inquiryService().revoke(owner, args.choiceId, args.expectedRevision);
      if (args.action === 'inquiry.approve_choice') return this.inquiryService().approve(owner, memberId, args.choiceId, args.expectedRevision, args.reviewDigest);
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
        const g: Grant = { ...material, id: randomUUID(), version: 1, schemaVersion: 'eigos.network.publication@1', purpose: d.content.kind === 'profile' ? 'profile_discovery' : d.content.kind === 'listing' ? 'service_discovery' : d.content.kind === 'evidence_card' ? 'evidence_sharing' : 'request_collaboration', action: r.replacementId ? 'replace_publication' : 'publish', allowedFields: fields(d.content.body), approvedBy: memberId, approvedAt: iso(this.store.now()), status: 'approved', revision: 1, maxUses: 1 };
        r.status = 'approved'; r.grantId = g.id; d.approved = true;
        this.store.put('grant', g); this.store.put('approval', r); this.store.put('draft', d); return [{ kind: 'grant', id: g.id }];
      }
      const g = this.store.get('grant', args.grantId, owner);
      if (g.revision !== args.expectedRevision) fail('REVISION_CONFLICT');
      g.status = 'revoked'; g.revokedAt = iso(this.store.now()); g.revision++; this.store.put('grant', g);
      if (g.usedPublicationId) { const pub = this.store.get('publication', g.usedPublicationId, owner); this.collaboration.withdraw(pub); this.evidence?.withdrawPending(pub); pub.state = 'retracted'; pub.revision++; this.store.put('publication', pub); this.store.event('grant_revoked', pub.id); }
      return [{ kind: 'grant', id: g.id }];
    });
    return { version: 1, requestId: args.requestId, ...committed, result: committed.refs.map(ref => this.controlView(memberId, owner, ref)) };
  }
  private ownView(owner: string, ref: ResultRef): unknown {
    const record = this.store.get(ref.kind, ref.id, owner);
    if (ref.kind === 'evidence') return this.evidenceService().ownView(owner, ref.id);
    if (ref.kind === 'choice') { const c = this.store.get('choice', ref.id, owner); return { id: c.id, kind: c.kind, status: c.status, revision: c.revision, expiresAt: c.expiresAt, reviewDigest: c.reviewDigest, input: c.input }; }
    if (ref.kind === 'inquiry') return this.inquiryService().inquiryView(owner, ref.id);
    if (ref.kind === 'selection') return this.inquiryService().selectionView(owner, ref.id);
    if (ref.kind === 'need') return this.collaboration.view(this.store.get('need', ref.id, owner));
    if (ref.kind === 'publication') {
      const pub = record as Publication, grant = this.store.get('grant', pub.grantId, owner);
      // Never replay content which has since expired or been revoked.
      let available = pub.state === 'active' && grant.status === 'consumed' && grant.usedPublicationId === pub.id && Date.parse(pub.visibleUntil) > this.store.now();
      if (available && (pub.content.kind === 'message' || pub.content.kind === 'evidence_card')) {
        try { available = this.collaboration.readable(pub, pub.memberId); this.validateEvidence(pub.content, pub.owner, pub.profileId); }
        catch (error) {
          if (error instanceof NetworkError && error.status < 500 || error instanceof DomainError) available = false;
          else throw error;
        }
      }
      return { id: pub.id, kind: ref.kind, revision: pub.revision, state: available ? 'active' : 'unavailable' };
    }
    const { owner: _owner, ...safe } = record;
    return safe;
  }
  query(p: Principal, token: string, input: unknown): NetworkQueryResult {
    const args = networkQuerySchema.parse(input);
    if (args.kind === 'my_inquiry' || args.kind === 'my_selection') {
      if (!p.scopes.includes('tasks:read')) fail('SCOPE_REQUIRED', 403);
      this.identity(p, token, 'network:read'); const owner = ownerKey(p);
      if (args.kind === 'my_selection') return { version: 1, result: this.inquiryService().selectionView(owner, args.selectionId) };
      const inquiry = this.inquiryService().byPost(owner, args.postId) ?? fail('NOT_FOUND', 404);
      return { version: 1, result: this.inquiryService().inquiryView(owner, inquiry.id) };
    }
    if (['get', 'spaces', 'profile', 'listing', 'search', 'need', 'messages', 'evidence'].includes(args.kind)) {
      const { member } = this.identity(p, token, 'network:read');
      return this.directoryQuery(member.id, args);
    }
    if (args.kind !== 'my_drafts' && args.kind !== 'my_approval_request' && args.kind !== 'my_directory' && args.kind !== 'my_follows' && args.kind !== 'my_choice' && args.kind !== 'my_evidence') return fail('INVALID_INPUT', 422);
    const a = this.actor(p, token, args.asProfileId, 'network:read');
    if (args.kind === 'my_evidence') {
      this.evidenceScope(p, a); const card = this.store.get('evidence', args.cardId, a.owner);
      if (card.profileId !== a.profileId) fail('NOT_FOUND', 404);
      return { version: 1, result: this.evidenceService().ownView(a.owner, card.id) };
    }
    if (args.kind === 'my_choice') {
      if (!p.scopes.includes('tasks:read')) fail('SCOPE_REQUIRED', 403);
      const choice = this.store.get('choice', args.choiceId, a.owner);
      if (choice.profileId !== a.profileId || choice.bindingId !== a.bindingId || choice.bindingRevision !== a.bindingRevision) fail('NOT_FOUND', 404);
      return { version: 1, result: this.ownView(a.owner, { kind: 'choice', id: choice.id }) };
    }
    if (args.kind === 'my_follows') {
      const rows = this.activity.follows(a.owner, a.profileId);
      const context = digest(['follows', this.actorKey(a), a.bindingRevision, rows.map(f => [f.id, f.revision])]);
      const after = this.decodeCursor(args.cursor, context), rest = rows.filter(f => f.id > after);
      const items = rest.slice(0, args.limit).map(f => this.ownView(a.owner, { kind: 'follow', id: f.id })), hasMore = rest.length > items.length;
      return { version: 1, items, page: { hasMore, cursor: hasMore ? this.encodeCursor(context, rest[items.length - 1]!.id) : undefined } };
    }
    if (args.kind === 'my_directory') return { version: 1, representations: this.store.list('representation', a.owner).filter(r => r.profileId === a.profileId).map(r => this.ownView(a.owner, { kind: 'representation', id: r.id })), listings: this.store.list('listing', a.owner).filter(l => l.profileId === a.profileId).map(l => this.ownView(a.owner, { kind: 'listing', id: l.id })) };
    if (args.kind === 'my_drafts') {
      const rows = this.store.list('draft', a.owner).filter(d => d.profileId === a.profileId && d.bindingId === a.bindingId && d.bindingRevision === a.bindingRevision);
      if (rows.some(d => d.content.kind === 'evidence_card')) this.evidenceScope(p, a);
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
    if (this.store.get('draft', r.draftId, a.owner).content.kind === 'evidence_card') this.evidenceScope(p, a);
    return { version: 1, result: this.ownView(a.owner, { kind: 'approval', id: r.id }) };
  }
  private baseView(pub: Publication, viewerId: string) {
    try {
      const grant = this.store.get('grant', pub.grantId);
      if (pub.state !== 'active' || grant.status !== 'consumed' || grant.usedPublicationId !== pub.id || Date.parse(pub.visibleUntil) <= this.store.now()) return undefined;
      this.directory.profile(pub.profileId, pub.owner); this.directory.mayRead(grant, pub.memberId, viewerId);
      this.directory.validateContent(pub.content, pub.owner, pub.profileId);
      this.validateEvidence(pub.content, pub.owner, pub.profileId);
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
    if (args.kind === 'evidence') {
      this.directory.assertMember(args.spaceId, memberId);
      const rows = this.store.scan('publication', { 'content.cardId': args.cardId, state: 'active' });
      return rows.map(p => this.publicView(p, memberId)).find(v => v?.spaceId === args.spaceId) ?? fail('NOT_FOUND', 404);
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

  updates(p: Principal, token: string, input: unknown) {
    const args = updatesQuerySchema.parse(input);
    return this.store.transaction(() => {
      const { member } = this.identity(p, token, 'network:read');
      if (args.asProfileId) this.actor(p, token, args.asProfileId, 'network:read');
      return this.activityForMember(member.id, args);
    });
  }
  memberUpdates(memberId: string, input: unknown) {
    return this.store.transaction(() => this.activityForMember(memberId, input));
  }
  private activityForMember(memberId: string, input: unknown) {
    const args = updatesQuerySchema.parse(input), m = this.member(memberId), owner = ownerKey({ ...m, clientId: '', scopes: [] });
    // This internal member-session entry point still requires ownership of a private follow filter.
    if (args.asProfileId) this.directory.profile(args.asProfileId, owner);
    const access = this.directory.assertMember(args.spaceId, memberId);
    return this.activity.updates(owner, memberId, args, [access.space.epoch, access.membership.generation, this.options.memberIds.slice().sort(), this.evidence?.policyVersion() ?? 'no-result-projection']);
  }

  receipt(p: Principal, token: string, input: unknown) {
    const args = receiptQuerySchema.parse(input);
    if ((args.operation.startsWith('inquiry.') || args.operation.startsWith('evidence.')) && !p.scopes.includes('tasks:read')) fail('SCOPE_REQUIRED', 403);
    const a = this.actor(p, token, args.asProfileId, 'network:read');
    const r = this.store.receipt(this.actorKey(a), args.operation, args.requestId);
    if (!r) return fail('NOT_FOUND', 404);
    for (const ref of r.refs) {
      if (ref.kind === 'evidence'
        || ref.kind === 'draft' && this.store.get('draft', ref.id, a.owner).content.kind === 'evidence_card'
        || ref.kind === 'publication' && this.store.get('publication', ref.id, a.owner).content.kind === 'evidence_card'
        || ref.kind === 'approval' && this.store.get('draft', this.store.get('approval', ref.id, a.owner).draftId, a.owner).content.kind === 'evidence_card') this.evidenceScope(p, a);
    }
    return { version: 1, refs: r.refs, result: r.refs.map(ref => this.ownView(a.owner, ref)) };
  }
  /** Browser control-plane identity is derived solely from the authenticated member session.
   * It is never accepted as an MCP/A2A credential or an installation actor. */
  private sessionPrincipal(memberId: string, write = false): Principal {
    const m = this.member(memberId);
    return { issuer: m.issuer, tenant: m.tenant, subject: m.subject, clientId: 'member-control-plane', scopes: ['tasks:read', ...(write ? ['tasks:write'] : [])] };
  }
  memberTask(memberId: string, taskId: string) {
    const tasks = this.options.tasks ?? fail('INQUIRY_UNAVAILABLE', 503);
    return tasks.get(this.sessionPrincipal(memberId), taskId);
  }
  memberTaskSummary(memberId: string, taskId: string) {
    const owner = ownerKey(this.sessionPrincipal(memberId));
    // Keep this read-only: opening a task never creates an EvidenceCard or publication.
    try { return this.evidenceService().resultSummary(owner, taskId); }
    catch (error) {
      if (error instanceof NetworkError && ['RESULT_NOT_READY', 'EVIDENCE_SOURCE_UNSUPPORTED'].includes(error.code)) return undefined;
      throw error;
    }
  }
  memberTaskReply(memberId: string, input: unknown) {
    const args = z.object({ taskId: z.uuid(), requestId: z.uuid(), expectedRevision: z.number().int().positive(), expectedUpdatedAt: z.iso.datetime(), answer: z.string().trim().min(1).max(500) }).strict().parse(input);
    const p = this.sessionPrincipal(memberId, true), tasks = this.options.tasks ?? fail('INQUIRY_UNAVAILABLE', 503);
    const job = tasks.get(p, args.taskId);
    // A stale page cannot answer a different question. Reply never approves an execution plan.
    if (job.revision !== args.expectedRevision || job.updatedAt !== args.expectedUpdatedAt) return fail('REVISION_CONFLICT');
    return tasks.reply(p, { taskId: args.taskId, requestId: args.requestId, answer: args.answer }, undefined, { revision: args.expectedRevision, updatedAt: args.expectedUpdatedAt });
  }
  memberInquiry(memberId: string, id: string) {
    const owner = ownerKey(this.sessionPrincipal(memberId));
    return { inquiry: this.inquiryService().inquiryView(owner, id), selections: this.store.list('selection', owner).filter(s => s.inquiryId === id).map(s => this.inquiryService().selectionView(owner, s.id)) };
  }
  workbench(memberId: string, offset = 0) {
    const p = this.sessionPrincipal(memberId), owner = ownerKey(p);
    const tasks = this.options.tasks?.list(p, { limit: 20, offset });
    return { spaces: this.directory.spaces(memberId), tasks,
      drafts: this.store.list('draft', owner).map(d => ({ id: d.id, revision: d.revision, content: d.content })),
      publications: this.store.list('publication', owner).map(pub => {
        const grant = this.store.get('grant', pub.grantId, owner);
        const visible = grant.recipientMemberIds.some(id => !!this.publicView(pub, id));
        return { id: pub.id, contentKind: pub.content.kind, state: pub.state, visible, visibleUntil: pub.visibleUntil };
      }),
      inquiries: this.inquiry ? this.store.list('inquiry', owner).map(i => this.inquiry!.inquiryView(owner, i.id)) : [],
      evidence: this.evidence ? this.store.list('evidence', owner).map(e => this.evidence!.ownView(owner, e.id)) : [],
    };
  }
  panel(memberId: string) {
    const m = this.member(memberId), owner = ownerKey({ ...m, clientId: '', scopes: [] });
    const spaces = this.directory.spaces(memberId), operator = this.directory.isOperator(memberId);
    const managedSpaces = operator ? this.store.scan('space').map(s => ({ id: s.id, name: s.name, revision: s.revision, state: s.state, role: 'operator' })) : this.store.scan('membership', { memberId, state: 'active' }).filter(m => m.role === 'moderator').map(m => { const s = this.store.get('space', m.spaceId); return { id: s.id, name: s.name, revision: s.revision, state: s.state, role: m.role }; });
    const knownMembers = new Set([memberId, ...spaces.flatMap(s => this.store.scan('membership', { spaceId: s.id, state: 'active' }).map(m => m.memberId))]);
    return { operator, spaces, choices: this.store.list('choice', owner), inquiries: this.inquiry ? this.store.list('inquiry', owner).map(i => this.inquiry!.inquiryView(owner, i.id)) : [], invitations: this.store.scan('invitation', { memberId, state: 'pending' }),
      spaceMembers: managedSpaces.map(s => ({ space: s, memberships: this.store.scan('membership', { spaceId: s.id }) })),
      representations: this.directory.isOperator(memberId) ? this.store.scan('representation') : this.store.list('representation', owner),
      listings: this.directory.isOperator(memberId) ? this.store.scan('listing') : this.store.list('listing', owner),
      profiles: this.store.list('profile', owner), bindings: this.store.list('binding', owner), grants: this.store.list('grant', owner),
      approvals: this.store.list('approval', owner).map(r => {
        let current = false;
        try { this.currentApproval(r); current = true; }
        catch (error) { if (!(error instanceof NetworkError && error.status < 500 || error instanceof DomainError)) throw error; }
        return { ...r, current, content: this.store.get('draft', r.draftId, owner).content };
      }),
      installations: this.members.agents.list(memberId).filter(r => !r.revoked),
      recipients: this.options.memberIds.filter(id => operator || knownMembers.has(id)).flatMap(id => { try { const member = this.member(id); return [{ id, displayName: member.displayName }]; } catch { return []; } }), spaceId: this.store.spaceId };
  }
}
