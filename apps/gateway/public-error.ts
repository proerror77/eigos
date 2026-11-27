import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Conflict, FunctionFailed, InvalidInput, NotFound, PermissionDenied, ResourceExhausted, ServiceUnavailable, SourceReadFailure } from '../../packages/core/identity.js';
import { Clarification } from '../../packages/runtime/clarification.js';
import { ProviderBudgetExceeded } from '../../packages/runtime/provider-budgets.js';

export function publicError(error: unknown) {
  if (error instanceof PermissionDenied) return { status: 403, message: error.message };
  if (error instanceof NotFound) return { status: 404, message: error.message };
  if (error instanceof Conflict || error instanceof Clarification) return { status: 409, message: error.message };
  if (error instanceof InvalidInput) return { status: 400, message: error.message };
  if (error instanceof ServiceUnavailable) return { status: 503, message: error.message };
  if (error instanceof ProviderBudgetExceeded) return { status: 429, message: error.message };
  // A component Function's own failure or limit: the request reached the Function, which could not complete it.
  if (error instanceof ResourceExhausted || error instanceof FunctionFailed) return { status: 422, message: error.message };
  if (error instanceof SourceReadFailure) return error.unavailable
    ? { status: 503, message: 'Source temporarily unavailable' }
    : { status: 502, message: 'Source request failed' };
  if (error instanceof z.ZodError) return { status: 400, message: 'Invalid request' };
  if (error instanceof SyntaxError && 'type' in error && error.type === 'entity.parse.failed')
    return { status: 400, message: 'Invalid JSON' };
  if (error instanceof Error && 'type' in error && error.type === 'entity.too.large')
    return { status: 413, message: 'Request body is too large' };
  const requestId = randomUUID();
  console.error('Gateway request failed', { requestId, error });
  return { status: 500, message: 'Internal server error', requestId };
}
