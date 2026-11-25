import { AsyncLocalStorage } from 'node:async_hooks';

/** Database work observed while an operation ran, in milliseconds where timed. */
export interface DatabaseProfile {
  /** Statements sent through the runtime database client. */
  statements: number;
  /** Sum of their round trips, including any lock waits inside them. */
  durationMs: number;
  /** Time spent acquiring Ontology edit locks, including waits that timed out. */
  editLockWaitMs: number;
  /** Time from acquiring an Ontology edit lock until its transaction ended. */
  editLockHoldMs: number;
  /** Statements that failed because a lock wait exceeded lock_timeout. */
  lockTimeouts: number;
  /** Optimistic commits rerun with the exclusive edit lock after a serialization failure or deadlock. */
  commitFallbacks: number;
}
type Counter = keyof DatabaseProfile;

const active = new AsyncLocalStorage<readonly DatabaseProfile[]>();

/** Runs an operation with its own profile. Work in nested profiles also counts toward enclosing ones. */
export function profileDatabase<T>(run: (profile: DatabaseProfile) => Promise<T>): Promise<T> {
  const profile: DatabaseProfile = { statements: 0, durationMs: 0, editLockWaitMs: 0, editLockHoldMs: 0, lockTimeouts: 0, commitFallbacks: 0 };
  return active.run([...(active.getStore() ?? []), profile], () => run(profile));
}

/** The profiles charged for work started now, kept for work that finishes later, such as a held lock. */
export function activeProfiles(): readonly DatabaseProfile[] {
  return active.getStore() ?? [];
}

export function chargeProfiles(profiles: readonly DatabaseProfile[], counter: Counter, amount: number) {
  for (const profile of profiles) profile[counter] += amount;
}

/** Log form: counts as recorded and times rounded to 0.1 ms. */
export function profileSummary(profile: DatabaseProfile): DatabaseProfile {
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    statements: profile.statements, durationMs: round(profile.durationMs), editLockWaitMs: round(profile.editLockWaitMs),
    editLockHoldMs: round(profile.editLockHoldMs), lockTimeouts: profile.lockTimeouts, commitFallbacks: profile.commitFallbacks,
  };
}
