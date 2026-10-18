import { randomUUID, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { ownerKey, type Principal } from '../core/domain.js';
import { digest } from '../core/delegation.js';
import type { Member, MemberStore } from '../members/store.js';
import { NetworkStore } from './store.js';
import { fail, networkCommandSchema, controlCommandSchema, networkQuerySchema, receiptQuerySchema,
  type NetworkActor, type Draft, type Approval, type Grant, type Publication, type ResultRef, type Binding } from './contracts.js';

export interface NetworkOptions { memberIds: string[] }
const iso = (time: number) => new Date(time).toISOString();
function fields(value: unknown, prefix = ''): string[] {
  if (value && typeof value === 'object' && !Array.isArray(value)) return Object.entries(value).flatMap(([key, child]) => fields(child, prefix + '/' + key));
  return [prefix];
}
const requiredCommand = { 'draft.create': 'draft.create', 'draft.update': 'draft.edit', 'publication.request_approval': 'approval.request', 'publication.publish': 'publish', 'publication.withdraw': 'withdraw_own' } as const;

/** No model, supplier, payment or task-dispatch access. All mutations are synchronous. */
export class NetworkService {
  readonly holder = randomUUID();
  private timer: ReturnType<typeof setInterval>;
  private leaseLost = false;
  private cursorKey = randomBytes(32);
  constructor(readonly store: NetworkStore, private members: MemberStore, private options: NetworkOptions) {
    store.acquire(this.holder);
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
    this.store.get('profile', profileId, owner);
    const b = this.store.binding(owner, profileId, installation.id);
    if (b.clientId !== p.clientId || command && !b.allowedCommands.includes(command)) fail('ACTOR_NOT_BOUND', 403);
    return { owner, memberId: m.id, installationId: installation.id, clientId: p.clientId, profileId, bindingId: b.id, bindingRevision: b.revision };
  }
  private actorKey(a: NetworkActor) { return digest([a.owner, a.installationId, a.profileId]); }
  private boundDraft(a: NetworkActor, id: string): Draft {
    const d = this.store.get('draft', id, a.owner);
    if (d.profileId !== a.profileId || d.bindingId !== a.bindingId || d.bindingRevision !== a.bindingRevision) fail('NOT_FOUND', 404);
    return d;
  }
  private validBinding(bindingId: string, owner: string): Binding {
    const b = this.store.get('binding', bindingId, owner), m = this.member(b.memberId);
    if (b.revoked) fail('ACTOR_NOT_BOUND', 403);
    const reg = this.members.agents.list(m.id).find(r => r.id === b.installationId);
    if (!reg || reg.revoked || reg.clientId !== b.clientId || this.members.connections(m.id).some(c => c.clientId === b.clientId && c.blocked)) fail('ACCESS_REVOKED', 403);
    this.store.checkFence(m.id, b.installationId, b.clientId); return b;
  }
  private quota(kind: 'profile' | 'binding' | 'draft' | 'approval' | 'grant' | 'publication', owner: string) {
    if (this.store.list(kind, owner).length >= 100) fail('RESOURCE_BUDGET', 429);
  }
  private audience(ids: string[]) {
    try { for (const id of ids) this.member(id); } catch { return fail('INVALID_AUDIENCE', 422); }
    return [...ids].sort();
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
    const recipients = this.audience(r.recipientMemberIds);
    if (digest([this.store.spaceId, recipients]) !== r.audienceDigest) fail('REVIEW_STALE');
    this.timeWindow(d, r.publishBefore, r.visibleUntil);
    return d;
  }
  command(p: Principal, token: string, input: unknown) {
    const args = networkCommandSchema.parse(input);
    let actor = this.actor(p, token, args.asProfileId, 'network:write', requiredCommand[args.operation]);
    const committed = this.store.once(this.actorKey(actor), args.operation, args.requestId, args, () => {
      actor = this.actor(p, token, args.asProfileId, 'network:write', requiredCommand[args.operation]);
    }, () => {
      const a = actor;
      if (args.operation === 'draft.create') {
        this.quota('draft', a.owner);
        const d: Draft = { id: randomUUID(), owner: a.owner, profileId: a.profileId, bindingId: a.bindingId, bindingRevision: a.bindingRevision, content: args.content, revision: 1, approved: false };
        this.store.put('draft', d); return [{ kind: 'draft', id: d.id }];
      }
      if (args.operation === 'draft.update') {
        const d = this.boundDraft(a, args.draftId);
        if (d.revision !== args.expectedRevision) fail('REVISION_CONFLICT');
        if (d.approved) fail('APPROVED_DRAFT_IMMUTABLE');
        if (d.content.kind !== args.content.kind) fail('INVALID_INPUT', 422);
        d.content = args.content; d.revision++; this.store.put('draft', d); return [{ kind: 'draft', id: d.id }];
      }
      if (args.operation === 'publication.request_approval') {
        const d = this.boundDraft(a, args.draftId);
        if (d.revision !== args.expectedRevision) fail('REVISION_CONFLICT');
        if (d.approved) fail('APPROVED_DRAFT_IMMUTABLE');
        this.timeWindow(d, args.publishBefore, args.visibleUntil); this.quota('approval', a.owner);
        const recipientMemberIds = this.audience(args.recipientMemberIds);
        const material = { id: randomUUID(), owner: a.owner, profileId: a.profileId, draftId: d.id, draftRevision: d.revision, bindingId: a.bindingId, bindingRevision: a.bindingRevision,
          contentDigest: digest(d.content), recipientMemberIds, audienceDigest: digest([this.store.spaceId, recipientMemberIds]), spaceId: this.store.spaceId, publishBefore: args.publishBefore, visibleUntil: args.visibleUntil };
        const r: Approval = { ...material, reviewDigest: this.approvalMaterial(material), status: 'pending' };
        this.store.put('approval', r); return [{ kind: 'approval', id: r.id }];
      }
      if (args.operation === 'publication.publish') {
        const d = this.boundDraft(a, args.draftId), g = this.store.get('grant', args.grantId, a.owner);
        if (g.status !== 'approved') fail(g.status === 'consumed' ? 'GRANT_CONSUMED' : 'GRANT_REVOKED');
        if (d.revision !== args.expectedRevision || g.draftId !== d.id || g.draftRevision !== d.revision || g.contentDigest !== digest(d.content)) fail('CONTENT_CHANGED');
        if (g.bindingId !== a.bindingId || g.bindingRevision !== a.bindingRevision || g.profileId !== a.profileId) fail('ACTOR_NOT_BOUND', 403);
        this.currentApproval({ ...g, status: 'approved' }); this.quota('publication', a.owner);
        const pub: Publication = { id: randomUUID(), owner: a.owner, memberId: a.memberId, profileId: a.profileId, draftId: d.id, grantId: g.id,
          content: structuredClone(d.content), revision: 1, state: 'active', visibleUntil: g.visibleUntil, recipientMemberIds: [...g.recipientMemberIds] };
        g.status = 'consumed'; g.usedPublicationId = pub.id; g.revision++;
        this.store.put('publication', pub); this.store.put('grant', g); this.store.event('published', pub.id);
        return [{ kind: 'publication', id: pub.id }];
      }
      const pub = this.store.get('publication', args.publicationId, a.owner);
      if (pub.profileId !== a.profileId) fail('NOT_FOUND', 404);
      if (pub.revision !== args.expectedRevision) fail('REVISION_CONFLICT');
      pub.state = 'retracted'; pub.revision++; this.store.put('publication', pub); this.store.event('retracted', pub.id);
      return [{ kind: 'publication', id: pub.id }];
    });
    return { version: 1, requestId: args.requestId, ...committed, result: committed.refs.map(ref => this.ownView(actor.owner, ref)) };
  }
  control(memberId: string, input: unknown) {
    const args = controlCommandSchema.parse(input); const member = this.member(memberId), owner = ownerKey({ ...member, clientId: '', scopes: [] });
    const committed = this.store.once(digest([owner, 'controller']), args.action, args.requestId, args, () => { this.member(memberId); }, () => {
      if (args.action === 'profile.create') {
        this.quota('profile', owner); const id = randomUUID();
        this.store.put('profile', { id, owner, memberId, displayName: args.displayName, revision: 1 }); return [{ kind: 'profile', id }];
      }
      if (args.action === 'profile.bind_installation') {
        this.store.get('profile', args.profileId, owner);
        const reg = this.members.agents.list(memberId).find(r => r.id === args.installationId && !r.revoked);
        if (!reg?.clientId) return fail('ACTOR_NOT_BOUND', 403);
        if (this.members.connections(memberId).some(c => c.clientId === reg.clientId && c.blocked)) return fail('ACTOR_NOT_BOUND', 403);
        this.store.checkFence(memberId, reg.id, reg.clientId);
        if (this.store.list('binding', owner).some(b => b.profileId === args.profileId && b.installationId === reg.id && !b.revoked)) fail('BINDING_EXISTS');
        this.quota('binding', owner);
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
        if (d.approved) fail('REVIEW_STALE'); this.quota('grant', owner);
        const { status: _status, grantId: _grant, ...material } = r;
        const g: Grant = { ...material, id: randomUUID(), version: 1, schemaVersion: 'eigos.network.publication@1', purpose: d.content.kind === 'profile' ? 'profile_discovery' : 'request_collaboration', action: 'publish', allowedFields: fields(d.content.body), approvedBy: memberId, approvedAt: iso(this.store.now()), status: 'approved', revision: 1, maxUses: 1 };
        r.status = 'approved'; r.grantId = g.id; d.approved = true;
        this.store.put('grant', g); this.store.put('approval', r); this.store.put('draft', d); return [{ kind: 'grant', id: g.id }];
      }
      const g = this.store.get('grant', args.grantId, owner);
      if (g.revision !== args.expectedRevision) fail('REVISION_CONFLICT');
      g.status = 'revoked'; g.revokedAt = iso(this.store.now()); g.revision++; this.store.put('grant', g);
      if (g.usedPublicationId) { const pub = this.store.get('publication', g.usedPublicationId, owner); pub.state = 'retracted'; pub.revision++; this.store.put('publication', pub); this.store.event('grant_revoked', pub.id); }
      return [{ kind: 'grant', id: g.id }];
    });
    return { version: 1, requestId: args.requestId, ...committed, result: committed.refs.map(ref => this.ownView(owner, ref)) };
  }
  private ownView(owner: string, ref: ResultRef): unknown {
    const record = this.store.get(ref.kind, ref.id, owner);
    if (ref.kind === 'publication') {
      const pub = record as Publication, grant = this.store.get('grant', pub.grantId, owner);
      // Never replay content which has since expired or been revoked.
      return { id: pub.id, kind: ref.kind, revision: pub.revision, state: pub.state === 'active' && grant.status !== 'revoked' && Date.parse(pub.visibleUntil) > this.store.now() ? 'active' : 'unavailable' };
    }
    const { owner: _owner, ...safe } = record;
    return safe;
  }
  query(p: Principal, token: string, input: unknown) {
    const args = networkQuerySchema.parse(input);
    if (args.kind === 'get') {
      const { member } = this.identity(p, token, 'network:read');
      const pub = this.store.get('publication', args.publicationId), grant = this.store.get('grant', pub.grantId);
      try { this.member(pub.memberId); } catch { return fail('NOT_FOUND', 404); }
      if (pub.state !== 'active' || grant.status === 'revoked' || Date.parse(pub.visibleUntil) <= this.store.now() || !pub.recipientMemberIds.includes(member.id)) fail('NOT_FOUND', 404);
      return { version: 1, ref: { kind: 'publication', id: pub.id, revision: pub.revision }, content: pub.content, visibleUntil: pub.visibleUntil };
    }
    const a = this.actor(p, token, args.asProfileId, 'network:read');
    if (args.kind === 'my_drafts') {
      const rows = this.store.list('draft', a.owner).filter(d => d.profileId === a.profileId && d.bindingId === a.bindingId && d.bindingRevision === a.bindingRevision);
      const context = digest([this.actorKey(a), a.bindingRevision, rows.map(d => [d.id, d.revision, d.approved])]);
      let after = '';
      if (args.cursor) {
        try {
          const [payload, signature, extra] = args.cursor.split('.');
          const supplied = Buffer.from(signature ?? '', 'base64url'), expected = createHmac('sha256', this.cursorKey).update(payload ?? '').digest();
          if (!payload || extra || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error();
          const c = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { context: string; last: string; expires: number };
          if (c.context !== context || typeof c.last !== 'string' || !Number.isFinite(c.expires) || c.expires <= this.store.now()) throw new Error();
          after = c.last;
        } catch { return fail('CURSOR_STALE'); }
      }
      const remaining = rows.filter(d => d.id > after), items: unknown[] = []; let bytes = 0, last = after;
      for (const d of remaining) {
        const view = this.ownView(a.owner, { kind: 'draft', id: d.id }), size = Buffer.byteLength(JSON.stringify(view));
        if (items.length === args.limit || bytes + size > 60000) break;
        items.push(view); bytes += size; last = d.id;
      }
      const hasMore = remaining.length > items.length;
      const payload = Buffer.from(JSON.stringify({ context, last, expires: this.store.now() + 900000 })).toString('base64url');
      const cursor = hasMore ? payload + '.' + createHmac('sha256', this.cursorKey).update(payload).digest('base64url') : undefined;
      return { version: 1, items, page: { hasMore, cursor } };
    }
    const r = this.store.get('approval', args.approvalRequestId, a.owner);
    if (r.profileId !== a.profileId || r.bindingId !== a.bindingId || r.bindingRevision !== a.bindingRevision) fail('NOT_FOUND', 404);
    return { version: 1, result: this.ownView(a.owner, { kind: 'approval', id: r.id }) };
  }
  receipt(p: Principal, token: string, input: unknown) {
    const args = receiptQuerySchema.parse(input), a = this.actor(p, token, args.asProfileId, 'network:read');
    const r = this.store.receipt(this.actorKey(a), args.operation, args.requestId);
    if (!r) return fail('NOT_FOUND', 404);
    return { version: 1, refs: r.refs, result: r.refs.map(ref => this.ownView(a.owner, ref)) };
  }
  panel(memberId: string) {
    const m = this.member(memberId), owner = ownerKey({ ...m, clientId: '', scopes: [] });
    return { profiles: this.store.list('profile', owner), bindings: this.store.list('binding', owner), grants: this.store.list('grant', owner),
      approvals: this.store.list('approval', owner).map(r => ({ ...r, content: this.store.get('draft', r.draftId, owner).content })),
      installations: this.members.agents.list(memberId).filter(r => !r.revoked),
      recipients: this.options.memberIds.flatMap(id => { try { const member = this.member(id); return [{ id, displayName: member.displayName }]; } catch { return []; } }), spaceId: this.store.spaceId };
  }
}
