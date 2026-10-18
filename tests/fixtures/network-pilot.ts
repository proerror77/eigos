import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemberStore } from '../../packages/members/store.js';
import { NetworkStore } from '../../packages/network/store.js';
import { NetworkService } from '../../packages/network/service.js';
import { commands } from '../../packages/network/contracts.js';
import { SCOPES, ownerKey, type Principal } from '../../packages/core/domain.js';
import type { ExecutionCatalog } from '../../packages/core/catalog.js';

export function networkFixture(options: { operatorSubjects?: string[]; catalog?: ExecutionCatalog; collaborationLimits?: { maxResponders: number; maxClarificationRounds: number } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'eigos-network-')), path = join(dir, 'business.sqlite');
  const db = new DatabaseSync(path), members = new MemberStore(join(dir, 'members.sqlite'));
  let now = Date.now();
  const store = new NetworkStore(db, () => now);
  const identity = (subject: string) => ({ issuer: 'https://idp.test', subject, tenant: 'one' });
  const create = (subject: string) => {
    const member = members.login(identity(subject)); members.apply(member.id, { displayName: subject, locale: 'en', timezone: 'UTC', consent: true }, false);
    const p: Principal = { ...identity(subject), clientId: 'connector', scopes: [...SCOPES, 'network:read', 'network:write'] };
    members.authorize(p); return { member, p };
  };
  const alice = create('alice'), bob = create('bob'), charlie = create('charlie');
  const install = (u: typeof alice) => {
    const id = randomUUID(), secret = randomBytes(32).toString('base64url'), token = 'ACCESS_SECRET_' + randomUUID();
    members.agents.create({ registrationId: id, displayName: 'Agent' }, secret);
    members.agents.bind(id, secret, u.p, u.member.id, token, Date.now() + 3600000, Date.now(), true);
    return { ...u, id, secret, token };
  };
  const a = install(alice), a2 = install(alice), b = install(bob), c = install(charlie);
  const service = new NetworkService(store, members, { memberIds: [a.member.id, b.member.id, c.member.id], operatorIds: [a, b, c].filter(u => options.operatorSubjects?.includes(u.p.subject)).map(u => u.member.id), catalog: options.catalog, collaborationLimits: options.collaborationLimits });
  const control = (action: object, memberId = a.member.id) => service.control(memberId, { version: 1, requestId: randomUUID(), ...action });
  const profileId = control({ action: 'profile.create', displayName: 'Alice Agent' }).refs[0]!.id;
  const bindingId = control({ action: 'profile.bind_installation', profileId, installationId: a.id, allowedCommands: [...commands] }).refs[0]!.id;
  const command = (body: object, user = a) => service.command(user.p, user.token, { version: 1, requestId: randomUUID(), asProfileId: profileId, ...body });
  const draft = (body = 'Need a quotation, no purchase') => command({ operation: 'draft.create', content: { kind: 'need', body: { title: 'Quote', safeGoal: body, category: 'delivery', coarseArea: '110105', replyDeadline: new Date(now + 86400000).toISOString() } } }).refs[0]!.id;
  const request = (draftId: string, ids = [b.member.id]) => command({ operation: 'publication.request_approval', draftId, expectedRevision: 1, recipientMemberIds: ids,
    publishBefore: new Date(now + 600000).toISOString(), visibleUntil: new Date(now + 3600000).toISOString() }).refs[0]!.id;
  const approval = (id: string) => store.get('approval', id, ownerKey(a.p));
  const approve = (id: string) => { const r = approval(id); return control({ action: 'publication.approve', approvalRequestId: id, expectedDraftRevision: r.draftRevision, reviewDigest: r.reviewDigest }).refs[0]!.id; };
  const grant = (id: string) => store.get('grant', id, ownerKey(a.p));
  const publish = (draftId: string, grantId: string, requestId = randomUUID()) => command({ operation: 'publication.publish', draftId, expectedRevision: 1, grantId, requestId });
  const get = (publicationId: string, user = b) => service.query(user.p, user.token, { version: 1, kind: 'get', publicationId });
  return { dir, path, db, store, members, service, a, a2, b, c, profileId, bindingId, control, command, draft, request, approval, approve, grant, publish, get,
    advance: (ms: number) => { now += ms; store.acquire(service.holder); },
    close: () => { service.close(); members.close(); db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
export type NetworkFixture = ReturnType<typeof networkFixture>;
