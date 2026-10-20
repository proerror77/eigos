import type { Express, Request, RequestHandler } from 'express';
import { z } from 'zod';
import { DomainError, type Principal } from '../../packages/core/domain.js';
import type { MemberSourceService } from '../../packages/members/source-service.js';
import { taskSummary } from '../../packages/core/task-summary.js';

export function mountSourceRoutes(app: Express, service: MemberSourceService | undefined, authenticate: RequestHandler, principal: (req: Request) => Principal) {
  if (!service) return;
  const operations = { begin: 'begin', credential: 'complete', revoke: 'revoke', resume: 'resume' } as const;
  app.get('/sources/meituan-paotui', authenticate, (req, res) => {
    try { res.json(service.status(principal(req), req.headers.authorization!.slice(7))); }
    catch { res.status(403).json({ error: 'source_access_denied' }); }
  });
  for (const [path, operation] of Object.entries(operations)) app.post(`/sources/meituan-paotui/${path}`, authenticate, (req, res) => {
    // Browser cross-origin posts cannot be a credential upload channel.
    try {
      if (req.headers.origin || !req.is('application/json')) throw new DomainError('FORBIDDEN', 'Use the PA private JSON transport');
      const p = principal(req), token = req.headers.authorization!.slice(7);
      res.json(operation === 'resume' ? taskSummary(service.resume(p, token, req.body)) : service[operation](p, token, req.body));
    } catch (error) {
      const status = error instanceof DomainError ? ({ NOT_FOUND: 404, FORBIDDEN: 403, CONFLICT: 409, INVALID_INPUT: 400 })[error.code] : error instanceof z.ZodError ? 400 : 403;
      // Never echo input, parser issue values, provider stderr or credentials.
      res.status(status).json({ error: error instanceof DomainError ? error.code : 'source_request_rejected', message: error instanceof DomainError ? error.message : 'Source request rejected' });
    }
  });
}
