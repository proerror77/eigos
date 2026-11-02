import { DomainError } from '../core/domain.js';
import type { MemberStore } from './store.js';
import type { AgentRegistrations } from './agents.js';
import type { AuthorizationCoordinator } from '../security/coordinator.js';
import type { SecurityStore } from '../security/store.js';
import type { AgentMessagingService } from '../agent-messaging/service.js';

export type MemberAwaitable<T> = T | Promise<T>;
type AwaitedMethods<T, K extends keyof T> = {
  [P in K]: T[P] extends (...args: infer A) => infer R ? (...args: A) => MemberAwaitable<Awaited<R>> : never;
};

export type MemberRegistrationPort = AwaitedMethods<AgentRegistrations,
  'create' | 'get' | 'list' | 'lookup' | 'status' | 'requireOwner' | 'bind' | 'authorize' |
  'ensureNativeInstallation' | 'authorizeNative' | 'revoke' | 'invite' | 'revokeInvitation' | 'redeem' | 'redeemForMember'>;
export type MemberStoragePort = AwaitedMethods<MemberStore,
  'find' | 'get' | 'list' | 'login' | 'apply' | 'update' | 'setStatus' | 'createSession' | 'session' |
  'logout' | 'connections' | 'authorizationFacts' | 'block' | 'authorize'> & { agents: MemberRegistrationPort };
export type MemberAgentReadinessPort = AwaitedMethods<AgentMessagingService, 'readiness'>;
export type MemberPermissionReview = {
  kind: 'agent' | 'source' | 'task' | 'revoke' | 'revoke_source' | 'recovery';
  input: Record<string, unknown>;
  policyRevision: number;
};
export type MemberPermissionCoordinatorPort = AwaitedMethods<AuthorizationCoordinator,
  'managementView' | 'grants' | 'sourceProfiles' | 'recoveries' | 'recoveryPreview' | 'approveAgentGrant' |
  'approveSource' | 'approveTaskGrant' | 'approveRecovery' | 'revokeSource' | 'revokeGrant' |
  'revokeInstallation' | 'setConnectionBlocked'> & {
  agentGrant(installationId: string): MemberAwaitable<ReturnType<SecurityStore['agentGrant']>>;
  /** Recheck the reviewed policy revision and apply exactly one reviewed change
   * in one transaction. An async implementation must own its SQL boundary. */
  applyPermissionReview(memberId: string, review: MemberPermissionReview): MemberAwaitable<void>;
};
export type MemberPermissionCoordinatorInput = MemberPermissionCoordinatorPort | AuthorizationCoordinator;

function requireSynchronous(value: unknown): void {
  if (value && (typeof value === 'object' || typeof value === 'function') && 'then' in value && typeof value.then === 'function') {
    void Promise.resolve(value).catch(() => {});
    throw new DomainError('CONFLICT', 'Asynchronous permission storage requires the atomic review port');
  }
}

/** Preserve existing synchronous callers without ever passing an async
 * callback to SQLite's synchronous atomic(). PostgreSQL supplies the explicit
 * async port above; the route cannot approximate its transaction boundary. */
export function memberPermissionCoordinatorPort(value: MemberPermissionCoordinatorInput): MemberPermissionCoordinatorPort {
  if ('applyPermissionReview' in value) return value;
  return {
    managementView: memberId => value.managementView(memberId),
    grants: memberId => value.grants(memberId),
    sourceProfiles: memberId => value.sourceProfiles(memberId),
    recoveries: memberId => value.recoveries(memberId),
    recoveryPreview: (memberId, taskId) => value.recoveryPreview(memberId, taskId),
    approveAgentGrant: (memberId, input) => value.approveAgentGrant(memberId, input),
    approveSource: (memberId, input) => value.approveSource(memberId, input),
    approveTaskGrant: (memberId, input) => value.approveTaskGrant(memberId, input),
    approveRecovery: (memberId, input) => value.approveRecovery(memberId, input),
    revokeSource: (memberId, input) => value.revokeSource(memberId, input),
    revokeGrant: (memberId, id, revision) => value.revokeGrant(memberId, id, revision),
    revokeInstallation: (memberId, id) => value.revokeInstallation(memberId, id),
    setConnectionBlocked: (memberId, id, blocked) => value.setConnectionBlocked(memberId, id, blocked),
    agentGrant: id => value.store.agentGrant(id),
    applyPermissionReview(memberId, review) {
      requireSynchronous(value.store.atomic(() => {
        if (review.policyRevision !== value.store.policies.revision()) throw new DomainError('CONFLICT', 'Permissions changed; review the current scope again');
        const result = review.kind === 'agent' ? value.approveAgentGrant(memberId, review.input)
          : review.kind === 'source' ? value.approveSource(memberId, review.input)
          : review.kind === 'task' ? value.approveTaskGrant(memberId, review.input)
          : review.kind === 'recovery' ? value.approveRecovery(memberId, review.input)
          : review.kind === 'revoke_source' ? value.revokeSource(memberId, review.input)
          : value.revokeGrant(memberId, String(review.input.grantId), Number(review.input.expectedRevision));
        requireSynchronous(result);
      }));
    },
  };
}
