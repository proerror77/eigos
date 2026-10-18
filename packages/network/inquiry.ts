import { randomUUID } from 'node:crypto';
import { digest } from '../core/delegation.js';
import { type Principal } from '../core/domain.js';
import type { JobStore } from '../core/store.js';
import type { TaskService } from '../core/tasks.js';
import type { ExecutionCatalog } from '../core/catalog.js';
import { BACKEND_VERSION } from '../ontology/execution.js';
import { quoteSelectionMaterial, recordSelectedProposal } from '../ontology/offer-selection.js';
import { fail, type NetworkActor, type ResultRef, type Binding } from './contracts.js';
import type { NetworkQueryResult } from './service.js';
import { NetworkStore } from './store.js';
import { conversionSchema, selectionSchema, type ConversionInput, type SelectionInput, type Inquiry, type InquiryChoice, type InquirySource, type QuoteSelection } from './inquiry-contracts.js';
import { validateInquirySource } from './inquiry-source.js';

export class InquiryBridge {
  constructor(private store: NetworkStore, private jobs: JobStore, private tasks: TaskService, private catalog: ExecutionCatalog,
    private view: (memberId: string, input: unknown) => NetworkQueryResult, private binding: (id: string, owner: string) => Binding) {
    if (!jobs.sharesNetworkStore(store)) throw new Error('Inquiry and Task must use the same business connection');
  }
  byPost(owner: string, postId: string) { return this.store.list('inquiry', owner).find(i => i.postId === postId); }
  private conversion(a: Pick<NetworkActor, 'owner' | 'memberId' | 'profileId'>, input: ConversionInput) {
    const post = this.store.get('need', input.postId, a.owner);
    if (post.profileId !== a.profileId) return fail('NOT_FOUND', 404);
    const postView = this.view(a.memberId, { version: 1, kind: 'need', postId: post.id });
    if (post.revision !== input.expectedPostRevision) fail('REVISION_CONFLICT');
    if (postView.need?.state !== 'open') fail('POST_CLOSED');
    const listingView = this.view(a.memberId, { version: 1, kind: 'get', publicationId: input.listing.publicationId });
    if (listingView.content?.kind !== 'listing' || listingView.spaceId !== postView.spaceId) return fail('NOT_FOUND', 404);
    if (listingView.ref?.revision !== input.listing.revision) fail('REVISION_CONFLICT');
    const l = this.store.get('listing', listingView.content.listingId);
    if (!l.bindingRef || !l.bindingDigest || !l.capabilityDigest) return fail('SOURCE_NOT_AVAILABLE');
    const source: InquirySource = { mode: 'quote_only', inquiryId: post.id, buyerMemberId: a.memberId, listingId: l.id, listingRevision: l.revision,
      listingPublicationId: input.listing.publicationId, capabilityRef: l.capabilityRef, capabilityDigest: l.capabilityDigest,
      bindingRef: l.bindingRef, bindingDigest: l.bindingDigest, providerId: l.providerId };
    try { validateInquirySource(this.store, this.catalog, a.owner, source); } catch { return fail('SOURCE_NOT_AVAILABLE'); }
    if (input.message) {
      const message = this.view(a.memberId, { version: 1, kind: 'get', publicationId: input.message.publicationId });
      if (message.content?.kind !== 'message' || message.content.body.postId !== post.id || message.content.body.responseToPostRevision !== post.contentRevision
        || message.content.body.listingRef?.publicationId !== input.listing.publicationId || message.content.body.listingRef.revision !== input.listing.revision) fail('NOT_FOUND', 404);
      if (message.ref?.revision !== input.message.revision) fail('REVISION_CONFLICT');
    }
    let taskMaterial: unknown; let buyerGoal = input.request.kind === 'create' ? input.request.buyerGoal : '';
    if (input.request.kind === 'attach') {
      const job = this.jobs.get(a.owner, input.request.existingTaskId);
      if (job.service !== 'eigos.delegate' || job.delegation?.backendVersion !== BACKEND_VERSION || job.delegation.request.executionEnvironment === 'sandbox') fail('TASK_UNSUPPORTED');
      if (['completed', 'failed', 'rejected', 'canceled'].includes(job.state)) fail('TASK_TERMINAL');
      if (this.jobs.hasClaim(a.owner, job.id) || !['submitted', 'input-required'].includes(job.state) || job.delegation?.plan || this.jobs.intents(a.owner, job.id).length) fail('TASK_BUSY');
      if (job.revision !== input.request.expectedTaskRevision || job.delegation!.request.revision !== input.request.expectedRequestRevision) fail('REVISION_CONFLICT');
      if (this.store.list('inquiry', a.owner).some(i => i.taskId === job.id)) fail('INQUIRY_ALREADY_EXISTS');
      buyerGoal = job.goal; taskMaterial = { goal: job.goal, request: job.delegation!.request, revision: job.revision };
    }
    return { source, preview: { needTitle: postView.content?.kind === 'need' ? postView.content.body.title : '', listingTitle: listingView.content.body.title, buyerGoal, request: input.request, ...(taskMaterial ? { existingPrivateRequest: taskMaterial } : {}) }, materialDigest: digest({ input, source, taskMaterial }), provenance: {
      postPublicationId: post.currentPublicationId, postContentRevision: post.contentRevision, listingPublicationId: input.listing.publicationId,
      ...(input.message ? { messagePublicationId: input.message.publicationId } : {}),
    } };
  }
  private material(choice: Pick<InquiryChoice, 'kind' | 'input' | 'owner' | 'memberId' | 'profileId'>) {
    if (choice.kind === 'convert') return this.conversion(choice, conversionSchema.parse(choice.input));
    const input = selectionSchema.parse(choice.input), inquiry = this.store.get('inquiry', input.inquiryId, choice.owner);
    try { validateInquirySource(this.store, this.catalog, choice.owner, inquiry.source); } catch { return fail('SOURCE_NOT_AVAILABLE'); }
    const material = quoteSelectionMaterial(this.jobs, inquiry, input);
    return { materialDigest: material.snapshotDigest, material, inquiry, preview: { taskId: inquiry.taskId, quote: input.quote, selectionKind: input.selectionKind, terms: material.snapshot.quoteTerms, checks: material.snapshot.checks, conditions: material.snapshot.conditions, evidenceLevels: material.snapshot.evidenceLevels } };
  }
  request(a: NetworkActor, kind: InquiryChoice['kind'], input: unknown): ResultRef[] {
    const parsed = kind === 'convert' ? conversionSchema.parse(input) : selectionSchema.parse(input);
    // A confirmed prior conversion is recovered through my_inquiry; no second approval or Task is needed.
    if (kind === 'convert') {
      const previous = this.byPost(a.owner, (parsed as ConversionInput).postId);
      if (previous) {
        if (previous.inputDigest !== digest(parsed)) fail('INQUIRY_ALREADY_EXISTS');
        return [{ kind: 'inquiry', id: previous.id }];
      }
    }
    this.store.quota('choice', a.owner);
    const c: InquiryChoice = { id: randomUUID(), owner: a.owner, memberId: a.memberId, profileId: a.profileId, bindingId: a.bindingId, bindingRevision: a.bindingRevision,
      kind, input: parsed, materialDigest: '', reviewDigest: '', expiresAt: new Date(this.store.now() + 900000).toISOString(), revision: 1, status: 'pending', preview: {} };
    const material = this.material(c); c.materialDigest = material.materialDigest; c.preview = material.preview;
    c.reviewDigest = digest({ ...c, reviewDigest: undefined });
    this.store.put('choice', c); this.store.event('inquiry_choice_requested', c.id); return [{ kind: 'choice', id: c.id }];
  }
  approve(owner: string, memberId: string, id: string, expectedRevision: number, reviewDigest: string): ResultRef[] {
    const c = this.store.get('choice', id, owner), b = this.binding(c.bindingId, owner);
    if (c.status !== 'pending' || c.revision !== expectedRevision || c.reviewDigest !== reviewDigest || b.revision !== c.bindingRevision
      || !b.allowedCommands.includes('inquiry.manage') || Date.parse(c.expiresAt) <= this.store.now() || this.material(c).materialDigest !== c.materialDigest) fail('REVIEW_STALE');
    c.status = 'approved'; c.revision++; c.approvedBy = memberId; c.approvedAt = new Date(this.store.now()).toISOString();
    this.store.put('choice', c); this.store.event('inquiry_choice_approved', c.id); return [{ kind: 'choice', id }];
  }
  revoke(owner: string, id: string, expectedRevision: number): ResultRef[] {
    const c = this.store.get('choice', id, owner);
    if (c.revision !== expectedRevision) fail('REVISION_CONFLICT');
    if (c.status === 'consumed') fail('CHOICE_ALREADY_APPLIED');
    c.status = 'revoked'; c.revision++; this.store.put('choice', c); this.store.event('inquiry_choice_revoked', c.id);
    return [{ kind: 'choice', id }];
  }
  apply(p: Principal, a: NetworkActor, id: string, kind: InquiryChoice['kind']): ResultRef[] {
    this.jobs.assertTransaction(); const c = this.store.get('choice', id, a.owner);
    if (c.kind !== kind || c.profileId !== a.profileId || c.bindingId !== a.bindingId || c.bindingRevision !== a.bindingRevision) fail('ACTOR_NOT_BOUND', 403);
    if (c.status === 'consumed') return [{ kind: kind === 'convert' ? 'inquiry' : 'selection', id: c.resultId! }];
    if (c.status !== 'approved' || !c.approvedBy || Date.parse(c.expiresAt) <= this.store.now()) fail('BUYER_CONFIRMATION_REQUIRED', 403);
    let result: ResultRef;
    if (kind === 'convert') {
      const input = conversionSchema.parse(c.input), previous = this.byPost(a.owner, input.postId);
      if (previous) {
        if (previous.selectionDigest !== c.materialDigest) fail('INQUIRY_ALREADY_EXISTS');
        result = { kind: 'inquiry', id: previous.id };
      } else {
        const checked = this.conversion(a, input); if (checked.materialDigest !== c.materialDigest) fail('REVIEW_STALE');
        this.store.quota('inquiry', a.owner); const inquiryId = randomUUID();
        const job = input.request.kind === 'create' ? this.tasks.submitInTransaction(p, { service: 'eigos.delegate', goal: input.request.buyerGoal, requirements: input.request.requirements,
          requestId: `network-inquiry:${inquiryId}`, executionEnvironment: 'live' }) : this.jobs.get(a.owner, input.request.existingTaskId);
        if (input.request.kind === 'attach') { job.revision = (job.revision ?? 0) + 1; job.delegation!.request.revision++; job.updatedAt = new Date(this.store.now()).toISOString(); this.jobs.save(a.owner, job); }
        const inquiry: Inquiry = { id: inquiryId, owner: a.owner, profileId: a.profileId, postId: input.postId, taskId: job.id, selectionDigest: c.materialDigest, inputDigest: digest(input),
          source: { ...checked.source, inquiryId }, provenance: checked.provenance, selectedAtRequestRevision: job.delegation!.request.revision, createdAt: new Date(this.store.now()).toISOString() };
        this.jobs.bindInquiryContext(a.owner, job.id, inquiry.source); this.store.put('inquiry', inquiry); this.store.event('inquiry_linked', inquiry.id);
        result = { kind: 'inquiry', id: inquiry.id };
      }
    } else {
      const input = selectionSchema.parse(c.input), checked = this.material(c);
      if (!('material' in checked) || checked.materialDigest !== c.materialDigest) return fail('REVIEW_STALE');
      this.store.quota('selection', a.owner); const selectionId = randomUUID(), at = new Date(this.store.now()).toISOString();
      const selection: QuoteSelection = { id: selectionId, owner: a.owner, inquiryId: input.inquiryId, taskId: checked.inquiry.taskId, profileId: a.profileId,
        quoteRef: checked.material.quoteRef, quoteRevision: input.quote.revision, requestRevision: input.expectedRequestRevision, kind: input.selectionKind,
        snapshot: checked.material.snapshot, snapshotDigest: checked.material.snapshotDigest, createdAt: at, ...(input.selectionKind === 'proposal' ? { proposalId: randomUUID() } : {}) };
      if (selection.proposalId) recordSelectedProposal(this.jobs, checked.inquiry, selection.proposalId, checked.material, at);
      this.store.put('selection', selection); this.store.event('quote_selected', selection.id); result = { kind: 'selection', id: selection.id };
    }
    c.status = 'consumed'; c.resultId = result.id; c.revision++; this.store.put('choice', c); return [result];
  }
  inquiryView(owner: string, id: string) {
    const inquiry = this.store.get('inquiry', id, owner), job = this.jobs.get(owner, inquiry.taskId);
    let sourceAvailable = false; try { validateInquirySource(this.store, this.catalog, owner, inquiry.source); sourceAvailable = true; } catch { /* Report history without claiming current source availability. */ }
    return { id, postId: inquiry.postId, taskId: job.id, requestRevision: job.delegation?.request.revision, taskRevision: job.revision,
      state: job.state === 'completed' && job.delegation?.acceptance?.accepted ? 'report_ready' : job.state === 'input-required' ? 'needs_input' : ['failed', 'canceled', 'rejected'].includes(job.state) ? 'unavailable' : 'quoting',
      mode: 'quote_only', businessExecution: 'not_started', source: { listingId: inquiry.source.listingId, listingRevision: inquiry.source.listingRevision, candidateEligible: sourceAvailable, availableNow: 'unknown' }, provenance: inquiry.provenance };
  }
  selectionView(owner: string, id: string) {
    const s = this.store.get('selection', id, owner); let current = false;
    try {
      const inquiry = this.store.get('inquiry', s.inquiryId, owner); validateInquirySource(this.store, this.catalog, owner, inquiry.source);
      current = quoteSelectionMaterial(this.jobs, inquiry, { inquiryId: inquiry.id, expectedRequestRevision: s.requestRevision, quote: { ...s.quoteRef, revision: s.quoteRevision }, selectionKind: s.kind }).snapshotDigest === s.snapshotDigest;
    } catch { /* Historical decision remains private; it never grants ongoing authority. */ }
    return { id, inquiryId: s.inquiryId, quoteRef: s.quoteRef, quoteRevision: s.quoteRevision, kind: s.kind, proposalId: s.proposalId, current,
      execution: 'not_started', snapshot: s.snapshot, snapshotDigest: s.snapshotDigest, createdAt: s.createdAt };
  }
}
