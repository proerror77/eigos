import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError, ownerKey, type Principal } from '../core/domain.js';
import { MemberStore } from '../members/store.js';
import { businessModel } from '../ontology/business-model.js';
import { accessContextSchema, agentAccessGrantSchema, POLICY_VERSION, SECURITY_CONTRACT, securityDefaults, type AccessContext } from './contracts.js';
import { SecurityError, SecurityStore, type Fence } from './store.js';

const grantFields = agentAccessGrantSchema.shape;
export const agentGrantRequestSchema = z.strictObject({ installationId: grantFields.installationId, capabilityIds: grantFields.capabilityIds,
  resources: grantFields.resources, sourceBindingIds: grantFields.sourceBindingIds, channels: grantFields.channels, expiresAt: grantFields.expiresAt });

/** The sole online eligibility publisher. Administrative CLI processes may use
 * the same deny/restore methods, but cannot publish eligibility or issue grants
 * without acquiring the Gateway lease. No raw token reaches SecurityStore. */
export class AuthorizationCoordinator {
  private token?: string;
  private timer?: ReturnType<typeof setInterval>;
  constructor(readonly store: SecurityStore, private members: MemberStore) {}
  start() {
    this.token = this.store.acquireManager();
    try { this.refresh(); } catch (error) { this.close(); throw error; }
    this.timer = setInterval(() => {
      try { this.refresh(); }
      catch { this.close(); console.error('Authorization eligibility refresh stopped; new work fails closed'); }
    }, securityDefaults.authorityProjectionRefreshSeconds * 1000);
    this.timer.unref();
  }
  close() { clearInterval(this.timer); if (this.token) this.store.releaseManager(this.token); this.token = undefined; }
  refresh() {
    try {
      if (!this.token || !this.store.renewManager(this.token)) throw new SecurityError('AUTHORITY_UNAVAILABLE');
      for (const old of this.store.subjects()) this.store.publishSubject(this.members.authorizationFacts(old.memberId, old.installationId), this.token);
    } catch { this.close(); throw new SecurityError('AUTHORITY_UNAVAILABLE'); }
  }
  authenticate(principal: Principal, bearer: string): AccessContext {
    if (!this.token) throw new SecurityError('AUTHORITY_UNAVAILABLE');
    // Both checks are existing membership/installation mechanisms. A client_id
    // or installation id supplied in a JSON body is never evidence of identity.
    const registration = this.members.agents.authorize(principal, bearer);
    this.members.authorize(principal);
    const facts = this.members.authorizationFacts(registration.memberId!, registration.id);
    if (facts.ownerKey !== ownerKey(principal) || facts.clientId !== principal.clientId) throw new SecurityError('ACCESS_REVOKED');
    const subject = this.store.publishSubject(facts, this.token), grant = this.store.agentGrant(subject.installationId);
    return accessContextSchema.parse({ version: SECURITY_CONTRACT, actorKind: 'agent', ownerKey: subject.ownerKey,
      memberId: subject.memberId, installationId: subject.installationId, clientId: subject.clientId,
      tokenScopes: [...new Set(principal.scopes)], agentGrant: { id: grant.id, revision: grant.revision },
      authEpoch: subject.epoch, policyVersion: POLICY_VERSION, checkedAt: new Date(this.store.now()).toISOString() });
  }
  approveAgentGrant(memberId: string, input: unknown) {
    if (!this.token) throw new SecurityError('AUTHORITY_UNAVAILABLE');
    const args = agentGrantRequestSchema.parse(input), facts = this.members.authorizationFacts(memberId, args.installationId);
    if (!facts.active) throw new SecurityError('ACCESS_REVOKED');
    this.store.publishSubject(facts, this.token);
    for (const resource of args.resources) {
      const definition = businessModel.object(resource.type);
      for (const field of resource.fields) {
        if (!Object.hasOwn(definition.properties, field)) throw new DomainError('INVALID_INPUT', 'Grant fields must be registered');
        if (definition.properties[field]!.restricted) throw new DomainError('FORBIDDEN', 'Grant cannot expose an existing restricted property');
      }
    }
    return this.store.issueAgentGrant({ ...args, version: SECURITY_CONTRACT, id: randomUUID(), revision: 1,
      kind: 'agent_access', scope: 'task_only', ownerKey: facts.ownerKey, memberId,
      approvedByMemberId: memberId, issuedAt: new Date(this.store.now()).toISOString(), status: 'active' });
  }
  private owned(memberId: string) {
    const m = this.members.get(memberId); return ownerKey({ ...m, clientId: '', scopes: [] });
  }
  grants(memberId: string) {
    return this.store.listGrants(this.owned(memberId)).map(({ ownerKey: _owner, memberId: _member, approvedByMemberId: _approver, ...safe }) => safe);
  }
  revokeGrant(memberId: string, grantId: string, expectedRevision: number) { this.store.revokeGrant(this.owned(memberId), grantId, expectedRevision); }
  private coordinate(target: Pick<Fence, 'ownerKey' | 'kind' | 'targetId'>, change: () => void, restore = false) {
    const fence = this.store.deny(target);
    try { this.store.completeFence(fence, restore ? 'cleared' : 'applied', change); }
    catch { throw new SecurityError('REVOCATION_PENDING', 'Access remains denied; membership reconciliation is required'); }
  }
  setMemberStatus(memberId: string, status: 'active' | 'suspended') {
    const ownerKey = this.owned(memberId);
    if (status === 'active' && this.members.get(memberId).status === 'active' && !this.store.hasFence({ ownerKey, kind: 'member', targetId: memberId })) return this.members.get(memberId);
    this.coordinate({ ownerKey, kind: 'member', targetId: memberId }, () => { this.members.setStatus(memberId, status); }, status === 'active');
    return this.members.get(memberId);
  }
  setConnectionBlocked(memberId: string, connectionId: string, blocked: boolean) {
    const connection = this.members.connections(memberId).find(c => c.id === connectionId);
    if (!connection) throw new DomainError('NOT_FOUND', 'Connection not found');
    if (!blocked && !connection.blocked && !this.store.hasFence({ ownerKey: this.owned(memberId), kind: 'connection', targetId: connection.clientId })) return;
    this.coordinate({ ownerKey: this.owned(memberId), kind: 'connection', targetId: connection.clientId }, () => this.members.block(memberId, connectionId, blocked), !blocked);
  }
  revokeInstallation(memberId: string, installationId: string) {
    const registration = this.members.agents.lookup(installationId);
    if (!registration || registration.memberId !== memberId) throw new DomainError('NOT_FOUND', 'Installation not found');
    this.coordinate({ ownerKey: this.owned(memberId), kind: 'installation', targetId: installationId }, () => this.members.agents.revoke(memberId, installationId));
  }
}
