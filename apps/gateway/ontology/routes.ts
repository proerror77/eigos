import type { Express, Request, RequestHandler } from 'express';
import { z } from 'zod';
import { DomainError, type Principal } from '../../../packages/core/domain.js';
import type { DefinitionService } from '../../../packages/ontology/definition-service.js';
import { ontologyManagerPage, ontologyManagerScript } from './page.js';

export function mountDefinitionRoutes(app: Express, service: DefinitionService, authenticate: RequestHandler, principal: (request: Request) => Principal): void {
  for (const [path, method] of [['query', 'query'], ['commands', 'command'], ['actions/prepare', 'prepare'], ['actions/approve', 'approve']] as const) {
    if (service.secured && path.startsWith('actions/')) continue;
    app.post(`/ontology/v1/${path}`, authenticate, (req, res, next) => {
      try { res.json(service[method](principal(req), req.body)); }
      catch (error) {
        if (error instanceof DomainError || error instanceof z.ZodError) {
          const code = error instanceof DomainError ? error.code : 'INVALID_INPUT';
          res.status(code === 'FORBIDDEN' ? 403 : code === 'NOT_FOUND' ? 404 : code === 'INVALID_INPUT' ? 400 : 409).json({ version: 1, error: { code, message: error instanceof DomainError ? error.message : 'Invalid metadata request' } }); return;
        }
        next(error);
      }
    });
  }
  if (service.secured) return;
  app.get('/ontology/manager', (_req, res) => {
    res.set({ 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'", 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' }).type('html').send(ontologyManagerPage());
  });
  app.get('/ontology/manager.js', (_req, res) => res.set('Cache-Control', 'no-store').type('application/javascript').send(ontologyManagerScript));
}
