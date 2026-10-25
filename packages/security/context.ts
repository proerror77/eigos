import { AsyncLocalStorage } from 'node:async_hooks';
import type { AccessContext } from './contracts.js';
import type { TaskDataGrant } from './store.js';
import type { SecurityEnvelope } from './envelope.js';
import type { SecurityPolicies } from './policy-store.js';

/** Server-only dynamic scope. Request JSON is never passed to this constructor. */
export interface AuthorizationScope {
  actor: Extract<AccessContext, { actorKind: 'agent' | 'worker' }>;
  policies: SecurityPolicies;
  grant?: TaskDataGrant;
  policyRevision: number;
  operation: 'task.query' | 'task.process' | 'task.result.read';
  lineage: Map<string, SecurityEnvelope>;
  assertCurrent: () => void;
  projection?: { programId: string; programDigest: string; sourceBindingId: string };
  inference?: boolean;
  integrity?: boolean;
  synchronousRead?: boolean;
  readBindings?: Map<string,unknown>;
}
const contexts = new AsyncLocalStorage<AuthorizationScope>();
export const authorizationScope = () => contexts.getStore();
export const withAuthorization = <T>(scope: AuthorizationScope, action: () => T): T => contexts.run(scope, action);
export const withoutAuthorization = <T>(action: () => T): T => contexts.exit(action);
export function withProjection<T>(origin: NonNullable<AuthorizationScope['projection']>, action: () => T): T {
  const scope = contexts.getStore();
  return scope ? contexts.run({ ...scope, projection: origin }, action) : action();
}
export function withInference<T>(action: () => T): T {
  const scope = contexts.getStore();
  return scope ? contexts.run({ ...scope, inference: true }, action) : action();
}
export function withIntegrity<T>(action:()=>T):T {
  const scope=contexts.getStore();return scope?contexts.run({...scope,integrity:true},action):action();
}
