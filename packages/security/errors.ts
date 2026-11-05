import { DomainError } from '../core/domain.js';

export class SecurityError extends DomainError {
  constructor(readonly reason: 'AUTHORIZATION_REQUIRED' | 'ACCESS_REVOKED' | 'AUTHORITY_UNAVAILABLE' | 'REVOCATION_PENDING' | 'POLICY_CHANGED' | 'SOURCE_NOT_AUTHORIZED' | 'OUTPUT_NOT_ALLOWED' | 'INSUFFICIENT_ACCESS', message: string = reason, readonly context?: 'personal_context') { super('FORBIDDEN', message); }
}
export class SecurityLineageLimitError extends SecurityError {
  constructor() { super('OUTPUT_NOT_ALLOWED'); }
}
