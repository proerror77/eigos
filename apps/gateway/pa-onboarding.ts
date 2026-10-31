import type { Express } from 'express';
import type { Config } from '../../packages/core/config.js';
import { paConnectionInfo, paOnboardingAvailable, paSkillArchive, paSkillFiles } from '../../packages/members/pa-onboarding.js';
import { onboardingScript, paOnboardingPage } from './pa-onboarding-page.js';

export function mountPaOnboarding(app: Express, config: Config): void {
  if (!paOnboardingAvailable(config)) return;
  const connection = paConnectionInfo(config), files = paSkillFiles(connection), archive = paSkillArchive(files);
  app.get(['/', '/connect'], (_req, res) => {
    res.set('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.set('Referrer-Policy', 'same-origin').type('html').send(paOnboardingPage(config));
  });
  app.get('/connect/agent.json', (_req, res) => { res.json(connection); });
  app.get('/connect/onboarding.js', (_req, res) => { res.type('application/javascript').send(onboardingScript); });
  for (const [name, body] of Object.entries(files)) app.get(`/connect/${name}`, (_req, res) => {
    res.type(name.endsWith('.json') ? 'application/json' : 'text/plain').send(body.toString('utf8'));
  });
  app.get('/connect/eigos-delegate.tar.gz', (_req, res) => {
    res.set('Content-Disposition', 'attachment; filename="eigos-delegate.tar.gz"').type('application/gzip').send(archive);
  });
}
