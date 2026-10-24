import { z } from 'zod';
import type { LinkDefinition, ObjectTypeDefinition, PropertyDefinition } from './model.js';

const id = z.string().min(1).max(200), time = z.iso.datetime({ offset: true });
const text = z.string().max(2000), revision = z.number().int().positive();
const p = (kind: PropertyDefinition['kind'], schema: z.ZodType, description: string, required = false): PropertyDefinition => ({
  kind, schema, description, required, source: 'Read-only projection of the authoritative NetworkStore, checked against current access. Not provider or execution evidence.',
});
const object = (type: string, name: string, description: string, properties: Record<string, PropertyDefinition>): ObjectTypeDefinition => ({
  id: type, version: '1', name, aliases: [type, name], description, primaryKey: 'id', titleKey: 'displayTitle',
  properties: { id: p('string', id, 'Identity within this read-only network view', true), displayTitle: p('string', z.string().min(1).max(500), 'Safe display label; not proof of identity', true), ...properties },
});
export const networkObjects: ObjectTypeDefinition[] = [
  object('NetworkInquiry', '网络询价来历', 'An owned task conversion. Original references are historical facts; shared relationships are returned only while currently visible. A quote-only inquiry grants no transaction authority.', {
    taskId: p('string', id, 'Original owned task', true), postId: p('string', id, 'Original owned need identity', true),
    originalPostPublicationId: p('string', id, 'Publication selected at conversion; never replaced with a newer post', true),
    originalPostContentRevision: p('integer', revision, 'Need content revision selected at conversion', true),
    originalListingPublicationId: p('string', id, 'Original selected service publication', true),
    originalMessagePublicationId: p('string', id, 'Original selected referral publication, when present'),
    selectedAtRequestRevision: p('integer', revision, 'Request revision at the original conversion', true),
    createdAt: p('timestamp', time, 'Conversion time, not supplier fulfillment time', true),
    mode: p('string', z.literal('quote_only'), 'Inquiry purpose', true), businessExecution: p('string', z.literal('not_started'), 'This bridge never executes business operations', true),
    readAdmission: p('string', z.enum(['task_bound', 'legacy_unavailable']), 'Whether a new authenticated bounded native read admission was captured', true),
  }),
  object('NetworkNeed', '网络需求帖', 'Owned need metadata survives withdrawal. Published content is available only through a currently visible publication; private task goals are never copied into this object.', {
    revision: p('integer', revision, 'Current owned need record revision', true), contentRevision: p('integer', revision, 'Current need content revision', true),
    state: p('string', z.enum(['open', 'closed', 'withdrawn']), 'Need state, independent of task outcome', true),
  }),
  object('NetworkPublication', '网络发布', 'Currently readable, explicitly approved publication. Retraction, replacement, expiry, member removal or revoked access remove this endpoint, including from reverse relationships.', {
    kind: p('string', z.enum(['profile', 'need', 'listing', 'message']), 'Published content kind', true),
    revision: p('integer', revision, 'Exact publication revision currently visible', true),
    content: p('struct', z.record(z.string(), z.unknown()), 'Exact approved public content, treated as untrusted user material', true),
    visibleUntil: p('timestamp', time, 'Publication expiry; does not confer execution permission', true),
  }),
  object('NetworkProfile', '网络发布身份', 'The profile reference disclosed by an authorized publication, or the requester own profile. Another member name is shown only if an independently visible profile publication approved it. This is not the selling or fulfilling legal entity.', {
    displayName: p('string', z.string().max(80), 'Owned name or separately approved visible profile name'),
    memberId: p('string', id, 'Member identity disclosed only to that same owner'),
    identityBasis: p('string', z.enum(['owned_profile', 'published_profile', 'publication_reference']), 'Evidence for this visible identity', true),
  }),
  object('NetworkListing', '网络服务声明', 'The approved service declaration carried by a visible publication. The publishing profile, represented provider role, configured binding and real business authority remain distinct.', {
    revision: p('integer', revision, 'Exact listed service revision', true), providerId: p('string', id, 'Provider identity explicitly approved in the publication', true),
    role: p('string', z.enum(['seller', 'fulfiller', 'aggregator', 'booking_agent']), 'Published representation role; not proof of fulfilled service', true),
    capabilityRef: p('struct', z.object({ id, version: id }).strict(), 'Exact declared capability reference', true),
    description: p('string', text, 'Approved service description', true), coarseAreas: p('array', z.array(z.string().regex(/^\d{6}$/)).max(16), 'Approved coarse service areas', true),
    candidateType: p('string', z.enum(['DeliveryQuote', 'ProductOffer', 'RideOption', 'VehicleOption']), 'Typed candidate contract, when one is recognized'),
    readPolicyStatus: p('string', z.enum(['registered', 'unavailable']), 'A registered read-only policy is still separate from owner/source admission', true),
    readPolicyReason: p('string', text, 'Why this declaration does or does not have an admitted quote-only policy', true),
    sourceAdmission: p('string', z.enum(['admitted', 'unavailable', 'unverified']), 'Current exact selected-source and owner check; no provider query or business execution is performed', true),
  }),
  object('NetworkRepresentation', '提供方代表关系', 'A safe representation view scoped to a currently visible listing publication. Private proof references, reviewers and review notes are not exposed.', {
    providerId: p('string', id, 'Published represented provider', true), role: p('string', z.enum(['seller', 'fulfiller', 'aggregator', 'booking_agent']), 'Published represented role', true),
    state: p('string', z.literal('verified'), 'Current representation validation needed by the visible listing', true),
    capabilityRef: p('struct', z.object({ id, version: id }).strict(), 'Only the capability actually published by this listing', true),
  }),
  object('NetworkVisibility', '发布可见范围', 'Read-only explanation of the current publication audience. Only the original publisher sees its exact approved recipient list; a recipient sees its own inclusion without audience counts or identities.', {
    spaceId: p('string', id, 'Circle already disclosed by the visible publication', true), spaceName: p('string', z.string().max(100), 'Current readable circle name', true),
    audienceKind: p('string', z.literal('explicit_recipients'), 'Visibility is an explicit approved audience, never public-by-default', true),
    viewerIncluded: p('boolean', z.literal(true), 'The viewer is currently in this exact publication audience', true),
    recipientMemberIds: p('array', z.array(id).max(50), 'Exact audience; returned only to its original publisher'),
    visibleUntil: p('timestamp', time, 'Audience expiry', true), executionAuthority: p('boolean', z.literal(false), 'Publication visibility is not business authority', true),
  }),
  object('NetworkSelection', '询价候选选择', 'An owned immutable version-bound choice. Historical terms remain available after publication withdrawal; no execution or payment permission is created.', {
    taskId: p('string', id, 'Original owned task', true), candidateType: p('string', z.enum(['DeliveryQuote', 'ProductOffer', 'RideOption', 'VehicleOption']), 'Exact selected concrete candidate type', true),
    candidateRevision: p('integer', revision, 'Exact selected candidate revision', true), requestRevision: p('integer', revision, 'Request revision approved for this choice', true),
    kind: p('string', z.enum(['reviewed', 'proposal']), 'Review or exact proposal decision', true),
    snapshotDigest: p('string', z.string().regex(/^[a-f0-9]{64}$/), 'Immutable decision material fingerprint', true), snapshot: p('struct', z.record(z.string(), z.unknown()), 'Original private choice material; never a new source observation', true),
    createdAt: p('timestamp', time, 'Original decision time', true), execution: p('string', z.literal('not_started'), 'Selection does not authorize execution', true),
  }),
];
export const networkTypeIds = new Set(networkObjects.map(value => value.id));
export const isVirtualRef = (ref: { type: string; id?: string }): boolean => networkTypeIds.has(ref.type);
const link = (id: string, from: string, name: string, to: string, reverse: string, many = false, reverseMany = true): LinkDefinition => ({
  id, description: 'Current permission-filtered network navigation; absent endpoints confer no access or execution authority.',
  from: { type: from, name, many }, to: { type: to, name: reverse, many: reverseMany },
});
export const networkLinks: LinkDefinition[] = [
  link('NetworkInquiryRequest', 'NetworkInquiry', 'request', 'ServiceRequest', 'networkInquiries', false, false),
  link('NetworkInquiryNeed', 'NetworkInquiry', 'originalNeed', 'NetworkNeed', 'inquiries'),
  link('NetworkInquiryPublisher', 'NetworkInquiry', 'requester', 'NetworkProfile', 'ownInquiries'),
  link('NetworkInquiryOriginalPublication', 'NetworkInquiry', 'originalPublication', 'NetworkPublication', 'originInquiries'),
  link('NetworkInquiryListingPublication', 'NetworkInquiry', 'listingPublication', 'NetworkPublication', 'listingInquiries'),
  link('NetworkInquiryMessagePublication', 'NetworkInquiry', 'referralPublication', 'NetworkPublication', 'referralInquiries'),
  link('NetworkPublicationProfile', 'NetworkPublication', 'publisher', 'NetworkProfile', 'publications'),
  link('NetworkPublicationVisibility', 'NetworkPublication', 'visibility', 'NetworkVisibility', 'publication', false, false),
  link('NetworkPublicationListing', 'NetworkPublication', 'listing', 'NetworkListing', 'publications'),
  link('NetworkPublicationNeed', 'NetworkPublication', 'need', 'NetworkNeed', 'publications'),
  link('NetworkListingRepresentation', 'NetworkListing', 'representation', 'NetworkRepresentation', 'listing', false, false),
  link('NetworkRepresentationProfile', 'NetworkRepresentation', 'publisher', 'NetworkProfile', 'representations'),
  link('NetworkSelectionInquiry', 'NetworkSelection', 'inquiry', 'NetworkInquiry', 'selections'),
  link('NetworkSelectionRequest', 'NetworkSelection', 'request', 'ServiceRequest', 'networkSelections'),
  ...(['DeliveryQuote', 'ProductOffer', 'RideOption', 'VehicleOption'] as const).flatMap(type => [
    link(`NetworkSelection${type}`, 'NetworkSelection', `selected${type}`, type, 'networkSelections'),
    link(`NetworkInquiry${type}`, 'NetworkInquiry', `${type[0]!.toLowerCase()}${type.slice(1)}s`, type, 'networkInquiries', true),
  ]),
];
export const networkLinkIds = new Set(networkLinks.map(value => value.id));
