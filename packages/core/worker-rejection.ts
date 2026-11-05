import { DomainError } from './domain.js';
import { SecurityError } from '../security/errors.js';

const securityReasons = new Set<SecurityError['reason']>(['AUTHORIZATION_REQUIRED', 'ACCESS_REVOKED', 'AUTHORITY_UNAVAILABLE',
  'REVOCATION_PENDING', 'POLICY_CHANGED', 'SOURCE_NOT_AUTHORIZED', 'OUTPUT_NOT_ALLOWED', 'INSUFFICIENT_ACCESS']);
const domainCodes = new Set<DomainError['code']>(['NOT_FOUND', 'FORBIDDEN', 'CONFLICT', 'INVALID_INPUT']);

/** Private process diagnostic only. A successful recovery writeback must not
 * erase the original rejection; runtime values still require an allowlist. */
export function recordWorkerRejection(taskId: string, error: unknown): void {
  const reason = error instanceof SecurityError ? securityReasons.has(error.reason) ? error.reason : undefined
    : error instanceof DomainError && domainCodes.has(error.code) ? error.code : undefined;
  if (reason) {
    try { console.error('Worker execution rejected; original task retained', { event: 'worker_execution_rejected', taskId, reason }); }
    catch { /* Diagnostic output cannot change task recovery or claim handling. */ }
  }
}
