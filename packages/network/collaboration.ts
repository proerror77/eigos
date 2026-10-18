import { digest } from '../core/delegation.js';
import { fail, type Content, type Publication, type NetworkActor } from './contracts.js';
import type { CollaborationLimits, NeedPost, MessageContent } from './collaboration-contracts.js';
import { NetworkStore } from './store.js';

type Audience = { spaceId: string; recipientMemberIds: string[]; visibleUntil: string };

/** Shared records only: no TaskService, model, supplier or execution endpoint access. */
export class NetworkCollaboration {
  constructor(private store: NetworkStore, private baseVisible: (pub: Publication, viewer: string) => boolean,
    readonly limits: CollaborationLimits = { maxResponders: 3, maxClarificationRounds: 2 }) {
    if (!Number.isInteger(limits.maxResponders) || limits.maxResponders < 1 || limits.maxResponders > 10
      || !Number.isInteger(limits.maxClarificationRounds) || limits.maxClarificationRounds < 1 || limits.maxClarificationRounds > 10) fail('INVALID_COLLABORATION_LIMITS', 422);
  }
  need(id: string) { return this.store.get('need', id); }
  state(n: NeedPost) {
    const pub = this.store.get('publication', n.currentPublicationId);
    if (pub.content.kind !== 'need') return fail('NOT_FOUND', 404);
    if (n.state === 'withdrawn' || pub.state !== 'active') return 'withdrawn';
    return Date.parse(pub.content.body.replyDeadline) <= this.store.now() || Date.parse(pub.visibleUntil) <= this.store.now() ? 'expired' : n.state;
  }
  view(n: NeedPost) { return { id: n.id, revision: n.revision, contentRevision: n.contentRevision, state: this.state(n) }; }
  private post(content: MessageContent, viewer: string) {
    const n = this.need(content.body.postId), pub = this.store.get('publication', n.currentPublicationId);
    if (!this.baseVisible(pub, viewer) || pub.content.kind !== 'need' || content.body.responseToPostRevision !== n.contentRevision) return fail('NOT_FOUND', 404);
    return { n, pub };
  }
  private references(content: MessageContent, viewer: string, depth = 0) {
    if (depth > 1) fail('REFERRAL_DEPTH_EXCEEDED');
    const { n, pub } = this.post(content, viewer), body = content.body;
    if (body.listingRef) {
      const listing = this.store.get('publication', body.listingRef.publicationId);
      if (listing.content.kind !== 'listing' || listing.revision !== body.listingRef.revision || !this.baseVisible(listing, viewer)
        || this.store.get('grant', listing.grantId).spaceId !== this.store.get('grant', pub.grantId).spaceId) fail('NOT_FOUND', 404);
    }
    if (body.parentMessageId) {
      const parent = this.store.get('message', body.parentMessageId), question = this.store.get('publication', parent.currentPublicationId);
      if (question.content.kind !== 'message' || question.content.body.kind !== 'question' || question.content.body.parentMessageId
        || parent.revision !== body.parentMessageRevision || question.content.body.postId !== n.id || question.content.body.responseToPostRevision !== n.contentRevision || !this.baseVisible(question, viewer)) return fail('NOT_FOUND', 404);
      this.references(question.content, viewer, depth + 1);
    }
    return { n, pub };
  }
  readable(pub: Publication, viewer: string) {
    if (pub.content.kind === 'need') return this.need(pub.needId ?? pub.id).currentPublicationId === pub.id;
    if (pub.content.kind !== 'message') return true;
    const message = this.store.get('message', pub.messageId ?? pub.id);
    if (message.currentPublicationId !== pub.id) return false;
    this.references(pub.content, viewer);
    return true;
  }
  validate(content: Content, memberId: string, audience?: Audience, replacing?: Publication) {
    if (content.kind !== 'message') return;
    const { n, pub } = this.references(content, memberId), body = content.body;
    if (this.state(n) !== 'open') fail('POST_CLOSED');
    if (replacing) {
      if (replacing.content.kind !== 'message' || digest({ ...body, safeText: '' }) !== digest({ ...replacing.content.body, safeText: '' })) fail('INVALID_REPLACEMENT');
    }
    if (body.kind === 'answer') {
      const question = this.store.get('message', body.parentMessageId!);
      if (memberId !== n.memberId || question.memberId === memberId) fail('ANSWER_ROLE_REQUIRED', 403);
      if (audience && !replacing && question.answerMessageId) fail('QUESTION_ALREADY_ANSWERED');
    } else if (memberId === n.memberId && body.kind !== 'discussion') fail('RESPONDER_REQUIRED', 403);
    if (audience) {
      const parentGrant = this.store.get('grant', pub.grantId);
      if (audience.spaceId !== parentGrant.spaceId || Date.parse(audience.visibleUntil) > Date.parse(pub.visibleUntil)
        || !audience.recipientMemberIds.includes(n.memberId)) fail('INVALID_AUDIENCE', 422);
      for (const recipient of audience.recipientMemberIds) this.references(content, recipient);
      if (body.parentMessageId && !audience.recipientMemberIds.includes(this.store.get('message', body.parentMessageId).memberId)) fail('INVALID_AUDIENCE', 422);
    }
    if (audience && !replacing) {
      if (memberId !== n.memberId && !n.responderMemberIds.includes(memberId) && n.responderMemberIds.length >= this.limits.maxResponders) fail('RESPONDER_LIMIT_HANDOFF_REQUIRED');
      if (body.kind === 'question' && (n.questionCounts[memberId] ?? 0) >= this.limits.maxClarificationRounds) fail('CLARIFICATION_LIMIT_HANDOFF_REQUIRED');
    }
  }
  replacement(content: Content, old: Publication) {
    if (content.kind === 'need' && old.content.kind === 'need') {
      const n = this.need(old.needId ?? old.id);
      if (n.currentPublicationId !== old.id || this.state(n) !== 'open') fail('POST_CLOSED');
      return true;
    }
    if (content.kind === 'message' && old.content.kind === 'message') {
      if (this.store.get('message', old.messageId ?? old.id).currentPublicationId !== old.id) fail('REVISION_CONFLICT');
      if (digest({ ...content.body, safeText: '' }) !== digest({ ...old.content.body, safeText: '' })) fail('INVALID_REPLACEMENT');
      return true;
    }
    return false;
  }
  published(pub: Publication, previous?: Publication) {
    if (pub.content.kind === 'need') {
      const n: NeedPost = previous ? this.need(previous.needId ?? previous.id) : {
        id: pub.id, owner: pub.owner, memberId: pub.memberId, profileId: pub.profileId,
        currentPublicationId: pub.id, revision: 0, contentRevision: 0, state: 'open', responderMemberIds: [], questionCounts: {},
      };
      n.currentPublicationId = pub.id; n.revision++; n.contentRevision++; pub.needId = n.id;
      this.store.put('need', n);
    }
    if (pub.content.kind === 'message') {
      const body = pub.content.body, n = this.need(body.postId);
      const message = previous ? this.store.get('message', previous.messageId ?? previous.id) : {
        id: pub.id, owner: pub.owner, memberId: pub.memberId, profileId: pub.profileId, postId: n.id, currentPublicationId: pub.id, revision: 0,
      };
      if (!previous) {
        if (pub.memberId !== n.memberId && !n.responderMemberIds.includes(pub.memberId)) n.responderMemberIds.push(pub.memberId);
        if (body.kind === 'question') n.questionCounts[pub.memberId] = (n.questionCounts[pub.memberId] ?? 0) + 1;
        if (body.kind === 'answer') {
          const question = this.store.get('message', body.parentMessageId!); question.answerMessageId = message.id; this.store.put('message', question);
        }
        this.store.put('need', n);
      }
      message.currentPublicationId = pub.id; message.revision++; pub.messageId = message.id;
      this.store.put('message', message);
    }
  }
  withdraw(pub: Publication) {
    if (pub.content.kind !== 'need') return;
    const n = this.need(pub.needId ?? pub.id);
    if (n.currentPublicationId === pub.id) { n.state = 'withdrawn'; n.revision++; this.store.put('need', n); }
  }
  close(a: NetworkActor, id: string, expectedRevision: number) {
    const n = this.store.get('need', id, a.owner);
    if (n.profileId !== a.profileId) fail('NOT_FOUND', 404);
    if (n.revision !== expectedRevision) fail('REVISION_CONFLICT');
    if (this.state(n) !== 'open') fail('POST_CLOSED');
    n.state = 'closed'; n.revision++; this.store.put('need', n); this.store.event('need_closed', id);
    return [{ kind: 'need' as const, id }];
  }
}
