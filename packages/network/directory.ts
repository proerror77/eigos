import { randomUUID } from 'node:crypto';
import { ownerKey } from '../core/domain.js';
import { digest } from '../core/delegation.js';
import { bindingDigest, sameRef, type ExecutionCatalog } from '../core/catalog.js';
import type { Member } from '../members/store.js';
import { NetworkError, fail, type NetworkActor, type Content, type Approval, type ResultRef } from './contracts.js';
import type { DirectoryCommand, DirectoryControl, Space, Membership, Representation, Listing } from './directory-contracts.js';
import { NetworkStore } from './store.js';

export type DirectoryMember = Pick<Member, 'id' | 'issuer' | 'tenant' | 'subject'>;
const ownerOf = (member: DirectoryMember) => ownerKey({ ...member, clientId: '', scopes: [] });
const rev = (actual: number, expected: number) => { if (actual !== expected) fail('REVISION_CONFLICT'); };

/** Network domain operations only. No supplier calls, model runs or task mutations. */
export class NetworkDirectory {
  constructor(readonly store: NetworkStore, private member: (id: string) => DirectoryMember, private operatorIds: string[], private catalog?: ExecutionCatalog) {}
  bootstrap(ids: string[], lookup: (id: string) => DirectoryMember = this.member) {
    this.store.transaction(() => {
      if (this.store.scan('space').some(s => s.id === this.store.spaceId)) return;
      const members = ids.map(lookup); if (!members.length) fail('NETWORK_MEMBERSHIP_REQUIRED', 403);
      const owner = ownerOf(members[0]!);
      this.store.put('space', { id: this.store.spaceId, owner, name: '封闭试点圈', state: 'active', revision: 1, epoch: 1, configured: true });
      for (const m of members) {
        let state: 'active' | 'removed' = 'active';
        try { this.member(m.id); } catch (error) { if (error instanceof NetworkError && error.status === 403) state = 'removed'; else throw error; }
        this.store.put('membership', { id: randomUUID(), owner, spaceId: this.store.spaceId, memberId: m.id, role: 'member', state, revision: 1, generation: 1 });
      }
      this.store.event('space_bootstrapped', this.store.spaceId);
    });
  }
  isOperator(id: string) { return this.operatorIds.includes(id); }
  private operator(id: string) { this.member(id); if (!this.isOperator(id)) fail('OPERATOR_REQUIRED', 403); }
  profile(id: string, owner?: string) {
    const p = this.store.get('profile', id, owner); this.member(p.memberId);
    if (p.state === 'suspended') fail('PROFILE_SUSPENDED', 403); return p;
  }
  membership(spaceId: string, memberId: string): Membership {
    const value = this.store.scan('membership', { spaceId, memberId }, '', 1)[0];
    return value ?? fail('NOT_FOUND', 404);
  }
  assertMember(spaceId: string, memberId: string) {
    this.member(memberId); const space = this.store.get('space', spaceId), membership = this.membership(spaceId, memberId);
    if (space.state !== 'active' || membership.state !== 'active') fail('NOT_FOUND', 404);
    return { space, membership };
  }
  private moderator(spaceId: string, id: string): Space {
    this.member(id); const s = this.store.get('space', spaceId);
    const m = this.store.scan('membership', { spaceId, memberId: id }, '', 1)[0];
    if (!this.isOperator(id) && (m?.state !== 'active' || m.role !== 'moderator')) fail('MODERATOR_REQUIRED', 403);
    return s;
  }
  audience(spaceId: string, publisherId: string, recipients: string[]) {
    try {
      const { space, membership } = this.assertMember(spaceId, publisherId);
      const ids = [...recipients].sort(), generations: Record<string, number> = {};
      for (const id of ids) generations[id] = this.assertMember(spaceId, id).membership.generation;
      return { recipientMemberIds: ids, membershipGenerations: generations, publisherGeneration: membership.generation, spaceEpoch: space.epoch,
        audienceDigest: digest([spaceId, space.epoch, membership.generation, generations]) };
    } catch { return fail('INVALID_AUDIENCE', 422); }
  }
  validAudience(a: Approval, publisherId: string) {
    const now = this.audience(a.spaceId, publisherId, a.recipientMemberIds);
    if (a.membershipGenerations) {
      if (now.audienceDigest !== a.audienceDigest) fail('REVIEW_STALE');
    } else {
      // T06 implicit-circle grants are valid only in the original membership generation.
      if (a.spaceId !== this.store.spaceId || now.spaceEpoch !== 1 || now.publisherGeneration !== 1 || Object.values(now.membershipGenerations).some(g => g !== 1)
        || a.audienceDigest !== digest([a.spaceId, now.recipientMemberIds])) fail('REVIEW_STALE');
    }
  }
  mayRead(a: Omit<Approval, 'status'>, publisherId: string, viewerId: string) {
    const publisher = this.assertMember(a.spaceId, publisherId), viewer = this.assertMember(a.spaceId, viewerId);
    if (!a.recipientMemberIds.includes(viewerId) || publisher.space.epoch !== (a.spaceEpoch ?? 1)
      || publisher.membership.generation !== (a.publisherGeneration ?? 1) || viewer.membership.generation !== (a.membershipGenerations?.[viewerId] ?? 1)) fail('NOT_FOUND', 404);
  }
  representation(id: string, owner?: string) {
    const r = this.store.get('representation', id, owner); this.profile(r.profileId, r.owner);
    if (r.state !== 'verified' || !r.validUntil || Date.parse(r.validUntil) <= this.store.now()) fail('REPRESENTATION_UNVERIFIED');
    return r;
  }
  activeListing(id: string, owner?: string): Listing {
    const l = this.store.get('listing', id, owner), r = this.representation(l.representationId, l.owner);
    if (l.state !== 'active' || l.representationRevision !== r.revision || l.providerId !== r.providerId || !r.capabilityRefs.some(c => sameRef(c, l.capabilityRef))) fail('LISTING_UNAVAILABLE');
    return l;
  }
  listingContent(id: string, revision: number, owner: string, profileId: string): Content {
    const l = this.activeListing(id, owner); rev(l.revision, revision);
    if (l.profileId !== profileId) fail('NOT_FOUND', 404);
    return { kind: 'listing', listingId: l.id, listingRevision: l.revision, body: { ...l.details, providerId: l.providerId, role: l.role, capabilityRef: l.capabilityRef } };
  }
  validateContent(content: Content, owner: string, profileId: string) {
    this.profile(profileId, owner);
    if (content.kind === 'listing' && digest(content) !== digest(this.listingContent(content.listingId, content.listingRevision, owner, profileId))) fail('CONTENT_CHANGED');
  }
  candidateState(listingId: string, viewerOwner: string) {
    const l = this.activeListing(listingId);
    const base = { claim: 'declared', representation: 'verified', availableNow: 'unknown', realExecutionEnabled: false } as const;
    if (!l.bindingRef || !this.catalog) return { ...base, binding: 'none', candidateEligible: false, mode: 'introduction_only' };
    try {
      const selected = this.catalog.source(l.bindingRef, viewerOwner), { binding } = selected, capability = this.catalog.capability(l.capabilityRef);
      if (bindingDigest(binding) !== l.bindingDigest || digest(capability) !== l.capabilityDigest || binding.providerId !== l.providerId || !sameRef(binding.capabilityRef, l.capabilityRef)) throw new Error();
      const read = capability.actions.some(a => a.effect === 'read' || a.effect === 'local');
      const authorization = ('program' in selected ? selected.program : selected.adapter).sourceAuthorization?.(viewerOwner);
      if (authorization && authorization.state !== 'connected') return { ...base, binding: 'configured', candidateEligible: false, mode: 'requires_own_authorization', authorization };
      return { ...base, binding: 'configured', candidateEligible: read && capability.environment !== 'sandbox', mode: capability.environment === 'sandbox' ? 'sandbox_only' : read ? 'read_candidate' : 'unavailable', evidenceLevel: binding.verification.level };
    } catch { return { ...base, binding: 'unavailable', candidateEligible: false, mode: 'unavailable' }; }
  }
  command(a: NetworkActor, args: DirectoryCommand): ResultRef[] {
    if (args.operation === 'representation.request') {
      this.store.quota('representation', a.owner);
      if (new Set(args.capabilityRefs.map(c => digest(c))).size !== args.capabilityRefs.length) fail('INVALID_INPUT', 422);
      const r: Representation = { id: randomUUID(), owner: a.owner, memberId: a.memberId, profileId: a.profileId, providerId: args.providerId, role: args.role, capabilityRefs: args.capabilityRefs, note: args.note, revision: 1, state: 'pending' };
      this.store.put('representation', r); this.store.event('representation_requested', r.id); return [{ kind: 'representation', id: r.id }];
    }
    if (args.operation === 'listing.create') {
      const r = this.store.get('representation', args.representationId, a.owner);
      if (r.profileId !== a.profileId || !r.capabilityRefs.some(c => sameRef(c, args.capabilityRef))) fail('REPRESENTATION_SCOPE_MISMATCH');
      this.store.quota('listing', a.owner);
      const l: Listing = { id: randomUUID(), owner: a.owner, memberId: a.memberId, profileId: a.profileId, representationId: r.id, providerId: r.providerId, role: r.role, capabilityRef: args.capabilityRef, details: args.details, revision: 1, state: 'draft' };
      this.store.put('listing', l); this.store.event('listing_created', l.id); return [{ kind: 'listing', id: l.id }];
    }
    const l = this.store.get('listing', args.listingId, a.owner);
    if (l.profileId !== a.profileId) fail('NOT_FOUND', 404); rev(l.revision, args.expectedRevision);
    if (l.state === 'retired') fail('LISTING_RETIRED');
    if (args.operation === 'listing.update') { l.details = args.details; l.state = 'draft'; delete l.reviewedBy; delete l.bindingRef; delete l.bindingDigest; delete l.capabilityDigest; }
    if (args.operation === 'listing.submit_review') {
      if (!['draft', 'paused'].includes(l.state)) fail('LISTING_NOT_REVIEWABLE');
      this.representation(l.representationId, a.owner); l.state = 'review';
    }
    if (args.operation === 'listing.set_state') l.state = args.state;
    l.revision++; this.store.put('listing', l); this.store.event('listing_changed', l.id); return [{ kind: 'listing', id: l.id }];
  }
  control(memberId: string, owner: string, args: DirectoryControl): ResultRef[] {
    if (args.action === 'profile.update' || args.action === 'profile.set_state') {
      const p = this.store.get('profile', args.profileId, owner); rev(p.revision, args.expectedRevision);
      if (args.action === 'profile.update') p.displayName = args.displayName;
      else {
        p.state = args.state;
        if (p.state === 'suspended') {
          for (const g of this.store.list('grant', owner).filter(g => g.profileId === p.id && g.status !== 'revoked')) {
            g.status = 'revoked'; g.revokedAt = new Date(this.store.now()).toISOString(); g.revision++; this.store.put('grant', g);
            if (g.usedPublicationId) { const pub = this.store.get('publication', g.usedPublicationId, owner); pub.state = 'retracted'; pub.revision++; this.store.put('publication', pub); }
          }
        }
      }
      p.revision++; this.store.put('profile', p); this.store.event('profile_changed', p.id); return [{ kind: 'profile', id: p.id }];
    }
    if (args.action === 'space.create') {
      this.operator(memberId); if (this.store.scan('space', {}, '', 21).length >= 20) fail('RESOURCE_BUDGET', 429);
      const s: Space = { id: randomUUID(), owner, name: args.name, state: 'active', revision: 1, epoch: 1 };
      this.store.put('space', s); this.store.put('membership', { id: randomUUID(), owner, spaceId: s.id, memberId, state: 'active', role: 'moderator', revision: 1, generation: 1 });
      this.store.event('space_created', s.id); return [{ kind: 'space', id: s.id }];
    }
    if (args.action === 'space.invite') {
      const s = this.moderator(args.spaceId, memberId); if (s.state !== 'active') fail('SPACE_ARCHIVED');
      try { this.member(args.memberId); } catch { return fail('INVALID_AUDIENCE', 422); }
      if (this.store.scan('membership', { spaceId: s.id, memberId: args.memberId, state: 'active' }).length) fail('MEMBER_EXISTS');
      if (Date.parse(args.expiresAt) <= this.store.now() || Date.parse(args.expiresAt) > this.store.now() + 604800000) fail('INVALID_INVITATION_WINDOW', 422);
      if (this.store.scan('invitation', { spaceId: s.id, memberId: args.memberId, state: 'pending' }).some(i => i.spaceEpoch === s.epoch && Date.parse(i.expiresAt) > this.store.now())) fail('INVITATION_EXISTS');
      this.store.quota('invitation', s.owner); const id = randomUUID();
      this.store.put('invitation', { id, owner: s.owner, spaceId: s.id, memberId: args.memberId, invitedBy: memberId, spaceEpoch: s.epoch, expiresAt: args.expiresAt, revision: 1, state: 'pending' });
      this.store.event('invitation_created', id); return [{ kind: 'invitation', id }];
    }
    if (args.action === 'space.accept_invitation' || args.action === 'space.revoke_invitation') {
      const i = this.store.get('invitation', args.invitationId), s = this.store.get('space', i.spaceId);
      if (args.action === 'space.accept_invitation') { if (i.memberId !== memberId) fail('NOT_FOUND', 404); }
      else this.moderator(s.id, memberId);
      rev(i.revision, args.expectedRevision);
      if (i.state !== 'pending') fail('INVITATION_UNAVAILABLE');
      if (args.action === 'space.accept_invitation') {
        if (Date.parse(i.expiresAt) <= this.store.now() || s.state !== 'active' || i.spaceEpoch !== s.epoch) fail('INVITATION_UNAVAILABLE');
        // An inviter who lost authority cannot leave a still-valid invitation behind.
        this.moderator(s.id, i.invitedBy);
        const old = this.store.scan('membership', { spaceId: s.id, memberId }, '', 1)[0];
        if (old?.state === 'active') fail('MEMBER_EXISTS');
        const membership: Membership = { id: old?.id ?? randomUUID(), owner: s.owner, spaceId: s.id, memberId, state: 'active', role: 'member', revision: (old?.revision ?? 0) + 1, generation: (old?.generation ?? 0) + 1 };
        this.store.put('membership', membership); i.state = 'accepted';
      } else i.state = 'revoked';
      i.revision++; this.store.put('invitation', i); this.store.event('invitation_changed', i.id); return [{ kind: 'invitation', id: i.id }];
    }
    if (args.action === 'space.set_member') {
      this.moderator(args.spaceId, memberId); const m = this.membership(args.spaceId, args.memberId); rev(m.revision, args.expectedRevision);
      if (m.state !== 'active' && args.state === 'active') fail('INVITATION_REQUIRED');
      if (args.role !== m.role) this.operator(memberId);
      m.state = args.state; m.role = args.role; m.revision++; this.store.put('membership', m); this.store.event('membership_changed', m.id); return [{ kind: 'membership', id: m.id }];
    }
    if (args.action === 'space.set_state') {
      const s = this.moderator(args.spaceId, memberId); rev(s.revision, args.expectedRevision);
      if (s.state !== args.state) s.epoch++; s.state = args.state; s.revision++; this.store.put('space', s); this.store.event('space_changed', s.id); return [{ kind: 'space', id: s.id }];
    }
    this.operator(memberId);
    if (args.action === 'representation.review') {
      const r = this.store.get('representation', args.representationId); rev(r.revision, args.expectedRevision);
      if (r.memberId === memberId) fail('SELF_REVIEW_FORBIDDEN', 403);
      if (args.decision === 'verified' && (Date.parse(args.validUntil) <= this.store.now() || Date.parse(args.validUntil) > this.store.now() + 7776000000)) fail('INVALID_VERIFICATION_WINDOW', 422);
      r.state = args.decision; r.proofRef = args.proofRef; r.validUntil = args.validUntil; r.reviewedBy = memberId; r.revision++;
      this.store.put('representation', r); this.store.event('representation_reviewed', r.id); return [{ kind: 'representation', id: r.id }];
    }
    const l = this.store.get('listing', args.listingId); rev(l.revision, args.expectedRevision);
    if (l.memberId === memberId) fail('SELF_REVIEW_FORBIDDEN', 403);
    if (l.state !== 'review') fail('LISTING_NOT_REVIEWABLE');
    const r = args.decision === 'approved' ? this.representation(l.representationId, l.owner) : this.store.get('representation', l.representationId, l.owner);
    delete l.bindingRef; delete l.bindingDigest; delete l.capabilityDigest;
    if (args.decision === 'approved' && args.bindingRef) {
      const binding = this.catalog?.configuredBinding(args.bindingRef);
      if (!binding?.enabled || binding.providerId !== l.providerId || !sameRef(binding.capabilityRef, l.capabilityRef)) return fail('BINDING_SCOPE_MISMATCH');
      l.bindingRef = binding.ref; l.bindingDigest = bindingDigest(binding); l.capabilityDigest = digest(this.catalog!.capability(l.capabilityRef));
    }
    l.state = args.decision === 'approved' ? 'active' : 'draft'; l.representationRevision = r.revision; l.reviewedBy = memberId; l.revision++;
    this.store.put('listing', l); this.store.event('listing_reviewed', l.id); return [{ kind: 'listing', id: l.id }];
  }
  spaces(memberId: string) {
    return this.store.scan('membership', { memberId, state: 'active' }).flatMap(m => {
      try { const { space } = this.assertMember(m.spaceId, memberId); return [{ id: space.id, name: space.name, revision: space.revision, state: space.state, role: m.role }]; } catch { return []; }
    });
  }
}
