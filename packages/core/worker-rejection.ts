import { DomainError } from './domain.js';
import { SecurityError } from '../security/errors.js';

const securityReasons = new Set<SecurityError['reason']>(['AUTHORIZATION_REQUIRED', 'ACCESS_REVOKED', 'AUTHORITY_UNAVAILABLE',
  'REVOCATION_PENDING', 'POLICY_CHANGED', 'SOURCE_NOT_AUTHORIZED', 'OUTPUT_NOT_ALLOWED', 'INSUFFICIENT_ACCESS']);
const domainCodes = new Set<DomainError['code']>(['NOT_FOUND', 'FORBIDDEN', 'CONFLICT', 'INVALID_INPUT']);
const diagnosticFiles = new Set(['apps/worker/worker', 'packages/core/store', 'packages/core/task-outcome',
  'packages/security/store', 'packages/security/policy-store', 'packages/security/envelope', 'packages/security/model',
  'packages/security/projection-origin', 'packages/security/task-context', 'packages/security/view',
  'packages/coordinator/coordinator', 'packages/coordinator/agent-runtime', 'packages/coordinator/planning-session', 'packages/coordinator/task-context',
  'packages/ontology/object-store', 'packages/ontology/task-projection', 'packages/ontology/execution-projection']);

/** Report only bounded coordinates in reviewed source files. Stack formatting
 * and diagnostic output must never change recovery or cleanup. */
export function workerErrorOrigins(error: unknown): string[] {
  if (!(error instanceof Error)) return [];
  try {
    return [...new Set((error.stack ?? '').split('\n', 17).slice(1).flatMap(line => {
      if (!line.startsWith('    at ')) return [];
      const match = line.match(/((?:apps|packages)\/[A-Za-z0-9_/-]+)\.(js|ts):(\d{1,7}):(\d{1,5})(?:\)|$)/);
      return match && diagnosticFiles.has(match[1]!) ? [`${match[1]}.${match[2]}:${match[3]}:${match[4]}`] : [];
    }))].slice(0, 4);
  } catch { return []; }
}

/** Private process diagnostic only. A successful recovery writeback must not
 * erase the original rejection; runtime values still require an allowlist. */
export function recordWorkerRejection(taskId: string, error: unknown): void {
  const reason = error instanceof SecurityError ? securityReasons.has(error.reason) ? error.reason : undefined
    : error instanceof DomainError && domainCodes.has(error.code) ? error.code : undefined;
  if (reason) {
    try {
      const origins = reason === 'POLICY_CHANGED' ? workerErrorOrigins(error) : [];
      console.error('Worker execution rejected; original task retained', {
        event: 'worker_execution_rejected', taskId, reason, ...(origins.length ? { origins } : {}),
      });
    }
    catch { /* Diagnostic output cannot change task recovery or claim handling. */ }
  }
}
