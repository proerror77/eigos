import { createHash } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import type { Config } from '../../packages/core/config.js';
import { digest } from '../../packages/core/identity.js';
import { Accounts, newAccountSecret } from '../../packages/runtime/accounts.js';

type Attempt = { state: string; nonce: string; verifier: string; expires: number };
const ttl = 300_000;
const sessionAge = 8 * 60 * 60 * 1000;
const sessionCookie = '__Host-eigos-member';
const loginCookie = '__Host-eigos-member-login';
const cookieOptions = { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/' };
const statuses = {
  login: '登录未完成，请重新登录。',
  verify: '请在邮箱打开 Auth0 验证邮件，然后重新登录。',
  invite: '邀请无效、已过期或与已验证邮箱不匹配。',
  origin: '请在会员页面重新提交。',
} as const;

function cookie(req: Request, key: string) {
  const value = req.headers.cookie?.split(';').map(item => item.trim()).find(item => item.startsWith(key + '='))?.slice(key.length + 1);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : '';
}

export function auth0MemberLogin(config: Config, exchange: typeof fetch = fetch,
  keys: JWTVerifyGetKey = createRemoteJWKSet(new URL(config.OAUTH_JWKS_URL!))) {
  const issuer = config.OAUTH_ISSUER!, clientId = config.OAUTH_MEMBER_CLIENT_ID!;
  const redirectUri = config.PUBLIC_URL + '/members/callback';
  return {
    start(attempt: Attempt, signup: boolean) {
      const url = new URL('authorize', issuer);
      url.search = new URLSearchParams({
        client_id: clientId, response_type: 'code', redirect_uri: redirectUri, scope: 'openid email',
        state: attempt.state, nonce: attempt.nonce, code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url'),
        ...(signup ? { screen_hint: 'signup', prompt: 'login' } : {}),
      }).toString();
      return url;
    },
    async finish(code: string, attempt: Attempt) {
      const response = await exchange(new URL('oauth/token', issuer), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        body: new URLSearchParams({ grant_type: 'authorization_code', code,
          client_id: clientId, client_secret: config.OAUTH_MEMBER_CLIENT_SECRET!,
          code_verifier: attempt.verifier, redirect_uri: redirectUri }),
      });
      if (!response.ok) throw new Error('Identity provider rejected the authorization code');
      const { id_token } = z.object({ id_token: z.string() }).parse(await response.json());
      const { payload } = await jwtVerify(id_token, keys, { issuer, audience: clientId, algorithms: ['RS256'],
        requiredClaims: ['sub', 'iat', 'exp', 'nonce', config.OAUTH_TENANT_CLAIM] });
      if (payload.nonce !== attempt.nonce || (payload.azp !== undefined && payload.azp !== clientId) ||
          (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)) {
        throw new Error('Identity token did not match this login');
      }
      const tenant = z.string().min(1).parse(payload[config.OAUTH_TENANT_CLAIM]);
      if (payload.email_verified !== true) return;
      const subject = z.string().min(1).parse(payload.sub);
      return { owner: digest([issuer, tenant, subject]), email: z.email().parse(payload.email) };
    },
  };
}

export function mountMembers(app: express.Express, config: Config, members: Accounts, login = auth0MemberLogin(config)) {
  const flows = new Map<string, Attempt>();
  const redirect = (res: Response, status?: keyof typeof statuses) =>
    res.redirect(303, '/members' + (status ? '?status=' + status : ''));
  app.use('/members', express.urlencoded({ extended: false, limit: '2kb' }), (_req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
    });
    next();
  });
  app.get('/members', async (req, res) => {
    const session = await members.session(cookie(req, sessionCookie));
    const account = session && await members.account(session.owner);
    const status = typeof req.query.status === 'string' && Object.hasOwn(statuses, req.query.status)
      ? statuses[req.query.status as keyof typeof statuses] : '';
    let content: string;
    if (!session) content = '<p><a href="/members/login?signup=1">注册</a> · <a href="/members/login">登录</a></p>';
    else if (!account) content = '<form method="post" action="/members/activate"><label>会员邀请码 <input name="code" autocomplete="off" maxlength="43" required></label> <button>开通会员</button></form>';
    else if (account.revoked_at) content = '<p>Grok 的 EIGOS 授权已撤销。需要重新接入时，请联系 EIGOS 支持。</p>';
    else if (account.approved_at) content = `<p>已允许 Grok 请求访问。请在 Grok 添加远程 HTTPS MCP，使用 EIGOS 账号完成 OAuth。</p>
      <dl><dt>服务地址</dt><dd><code>${new URL('/mcp', config.PUBLIC_URL).href}</code></dd><dt>OAuth Client ID</dt><dd><code>${config.OAUTH_MEMBER_MCP_CLIENT_ID}</code></dd></dl>
      <form method="post" action="/members/revoke"><button>撤销 Grok 授权</button></form>`;
    else content = '<p>会员已开通。授权后，Grok 可提交和读取你自己的查询任务。</p><form method="post" action="/members/approve"><button>授权 Grok</button></form>';
    // Browser form navigation must preserve Origin for the POST checks. The OIDC callback remains no-referrer.
    res.set('Referrer-Policy', 'same-origin').type('html').send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EIGOS 会员</title>
      <style>body{font:1rem system-ui;max-width:42rem;margin:7vh auto;padding:0 1.5rem;line-height:1.6}button,input{font:inherit;padding:.35rem .6rem}form{margin-block:1.3rem}dd{margin:0 0 .75rem;overflow-wrap:anywhere}</style>
      <main><h1>EIGOS 会员</h1>${status ? '<p role="status">' + status + '</p>' : ''}${content}
      ${session ? '<form method="post" action="/members/logout"><button>退出会员中心</button></form>' : ''}</main></html>`);
  });
  app.get('/members/login', (req, res) => {
    const now = Date.now();
    for (const [key, attempt] of flows) if (attempt.expires <= now) flows.delete(key);
    const previous = cookie(req, loginCookie);
    if (previous) flows.delete(digest(previous));
    if (flows.size >= 500) { res.sendStatus(429); return; }
    const token = newAccountSecret(), attempt = {
      state: newAccountSecret(), nonce: newAccountSecret(), verifier: newAccountSecret(), expires: now + ttl,
    };
    flows.set(digest(token), attempt);
    res.cookie(loginCookie, token, { ...cookieOptions, maxAge: ttl });
    res.redirect(303, login.start(attempt, req.query.signup === '1').href);
  });
  app.get('/members/callback', async (req, res) => {
    const key = digest(cookie(req, loginCookie)), attempt = flows.get(key);
    flows.delete(key);
    res.clearCookie(loginCookie, cookieOptions);
    const code = z.string().min(1).max(3000).safeParse(req.query.code);
    if (!attempt || attempt.expires <= Date.now() || req.query.state !== attempt.state || !code.success) {
      redirect(res, 'login'); return;
    }
    try {
      const previous = cookie(req, sessionCookie);
      const identity = await login.finish(code.data, attempt);
      if (!identity) {
        if (previous) await members.endSession(previous);
        res.clearCookie(sessionCookie, cookieOptions);
        redirect(res, 'verify'); return;
      }
      const session = await members.startSession(identity.owner, identity.email, previous);
      res.cookie(sessionCookie, session, { ...cookieOptions, maxAge: sessionAge });
      redirect(res);
    } catch { redirect(res, 'login'); }
  });
  app.use('/members', async (req, res, next) => {
    if (req.method !== 'POST') { next(); return; }
    if (req.headers.origin !== config.PUBLIC_URL) { res.status(403).send(statuses.origin); return; }
    const token = cookie(req, sessionCookie), session = await members.session(token);
    if (!session) { res.sendStatus(401); return; }
    if (req.path === '/activate') {
      const code = z.string().regex(/^[A-Za-z0-9_-]{43}$/).safeParse(req.body?.code);
      const activated = code.success && await members.activate(session, code.data) === 'activated';
      redirect(res, activated ? undefined : 'invite'); return;
    }
    if (req.path === '/approve') await members.approve(session.owner);
    else if (req.path === '/revoke') await members.revoke(session.owner);
    else if (req.path === '/logout') {
      await members.endSession(token);
      res.clearCookie(sessionCookie, cookieOptions);
    } else { res.sendStatus(404); return; }
    redirect(res);
  });
}
