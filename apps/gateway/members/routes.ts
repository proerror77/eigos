import express, { type Express, type Request, type Response } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../../../packages/core/config.js';
import { DomainError } from '../../../packages/core/domain.js';
import { MemberStore } from '../../../packages/members/store.js';
import { createLoginProvider, type LoginAttempt } from './oidc.js';
import { memberPage } from './page.js';

function cookies(req: Request): Record<string, string> {
  return Object.fromEntries((req.headers.cookie ?? '').split(';').map(part => part.trim().split('=')).filter(part => part.length === 2));
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const notices: Record<string, string> = {
  login_failed: '登录未完成或已过期，请重新登录。', login_unavailable: '登录服务暂时不可用，请稍后重试。',
  saved: '会员资料已保存。', applied: '会员申请已保存。', revoked: '已停用这个助手的连接。', restored: '已恢复这个助手的连接。',
};

export function mountMemberRoutes(app: Express, c: Config, store: MemberStore, provider = createLoginProvider(c)): void {
  const secure = new URL(c.PUBLIC_URL).protocol === 'https:';
  const sessionCookie = secure ? '__Host-eigos-member' : 'eigos-member';
  const loginCookie = secure ? '__Host-eigos-login' : 'eigos-login';
  const cookieOptions = { httpOnly: true, secure, sameSite: 'lax' as const, path: '/' };
  const flows = new Map<string, LoginAttempt & { expiresAt: number }>();
  const session = (req: Request) => store.session(cookies(req)[sessionCookie] ?? '');
  const sameOrigin = (req: Request) => req.headers.origin === c.PUBLIC_URL;
  const redirect = (res: Response, notice?: string) => res.redirect(303, `/members${notice ? `?notice=${notice}` : ''}`);
  app.use('/members', express.urlencoded({ extended: false, limit: '8kb' }), (_req, res, next) => {
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  app.get('/members', (req, res) => {
    const current = session(req);
    const notice = typeof req.query.notice === 'string' ? notices[req.query.notice] : undefined;
    res.type('html').send(memberPage({
      ...(current ? { member: current.member, csrf: current.csrf, connections: store.connections(current.member.id) } : {}),
      loginAvailable: !!provider, manualApproval: c.EIGOS_MEMBERSHIP_APPROVAL === 'manual', ...(notice ? { notice } : {}),
    }));
  });
  app.get('/members/login', async (req, res) => {
    if (!provider) { res.status(503).json({ error: 'member_login_not_configured' }); return; }
    for (const [key, attempt] of flows) if (attempt.expiresAt <= Date.now()) flows.delete(key);
    if (flows.size >= 500) { res.status(429).json({ error: 'login_busy' }); return; }
    try {
      const attempt = await provider.start();
      if (flows.size >= 500) { res.status(429).json({ error: 'login_busy' }); return; }
      const token = randomBytes(32).toString('base64url');
      const previous = cookies(req)[loginCookie]; if (previous) flows.delete(hash(previous));
      flows.set(hash(token), { state: attempt.state, nonce: attempt.nonce, verifier: attempt.verifier, expiresAt: Date.now() + 300000 });
      res.cookie(loginCookie, token, { ...cookieOptions, maxAge: 300000 });
      res.redirect(303, attempt.url.href);
    } catch { redirect(res, 'login_unavailable'); }
  });
  app.get('/members/callback', async (req, res) => {
    const key = hash(cookies(req)[loginCookie] ?? '');
    const attempt = flows.get(key); flows.delete(key);
    res.clearCookie(loginCookie, cookieOptions);
    if (!provider || !attempt || attempt.expiresAt <= Date.now()) { redirect(res, 'login_failed'); return; }
    try {
      // Fixed origin/path, never a request-supplied Host or return URL. Each attempt is consumed once.
      const identity = await provider.finish(new URL(req.originalUrl, c.PUBLIC_URL), attempt);
      if (identity.issuer !== c.OAUTH_ISSUER) throw new Error('Unexpected identity issuer');
      const member = store.login(identity);
      const oldSession = cookies(req)[sessionCookie]; if (oldSession) store.logout(oldSession);
      const created = store.createSession(member.id);
      res.cookie(sessionCookie, created.token, { ...cookieOptions, maxAge: 8 * 60 * 60 * 1000 });
      redirect(res);
    } catch { redirect(res, 'login_failed'); }
  });

  // A member browser session manages only its own profile/connections; it cannot authenticate MCP or A2A.
  app.post(['/members/apply', '/members/profile', '/members/logout', '/members/connections/:id/:action'], (req, res, next) => {
    const current = session(req);
    if (!current) { res.status(401).json({ error: 'member_login_required' }); return; }
    const supplied = Buffer.from(typeof req.body?._csrf === 'string' ? req.body._csrf : '');
    const expected = Buffer.from(current.csrf);
    if (!sameOrigin(req) || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.status(403).json({ error: 'invalid_csrf' }); return;
    }
    try {
      const { _csrf, ...body } = req.body;
      if (req.path === '/members/logout') {
        store.logout(cookies(req)[sessionCookie]!); res.clearCookie(sessionCookie, cookieOptions); redirect(res); return;
      }
      if (req.path === '/members/apply') {
        store.apply(current.member.id, { ...body, consent: body.consent === true || body.consent === 'true' }, c.EIGOS_MEMBERSHIP_APPROVAL === 'manual');
        redirect(res, 'applied'); return;
      }
      if (req.path === '/members/profile') { store.update(current.member.id, body); redirect(res, 'saved'); return; }
      const action = z.enum(['revoke', 'restore']).parse(req.params.action);
      store.block(current.member.id, z.uuid().parse(req.params.id), action === 'revoke');
      redirect(res, action === 'revoke' ? 'revoked' : 'restored');
    } catch (error) {
      if (error instanceof z.ZodError) {
        const message = '请检查名称、语言和时区；开通会员时需勾选同意。';
        if (req.is('application/json')) res.status(400).json({ error: 'invalid_member_input', message });
        else res.status(400).type('html').send(memberPage({ member: current.member, csrf: current.csrf, connections: store.connections(current.member.id), loginAvailable: !!provider, manualApproval: c.EIGOS_MEMBERSHIP_APPROVAL === 'manual', notice: message }));
        return;
      }
      if (error instanceof DomainError) { res.status(error.code === 'NOT_FOUND' ? 404 : 403).json({ error: error.code }); return; }
      next(error);
    }
  });
}
