import { createHash } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import type { Config } from '../../packages/core/config.js';
import { digest } from '../../packages/core/identity.js';
import { Accounts, emailDigest, newAccountSecret } from '../../packages/runtime/accounts.js';
import { rateLimit } from './rate-limit.js';
import { seal, unseal } from './sealed-cookie.js';

export type LoginAttempt = { state: string; nonce: string; verifier: string; link?: { auth0State: string; subject: string; primary: string } };
export type LoginResult =
  | { kind: 'verified'; owner: string; email: string; subject: string }
  | { kind: 'unverified'; subject: string }
  | { kind: 'tenant_missing' };

const attemptSchema: z.ZodType<LoginAttempt> = z.strictObject({
  state: z.string().min(1), nonce: z.string().min(1), verifier: z.string().min(1),
  link: z.strictObject({ auth0State: z.string().min(1), subject: z.string().min(1), primary: z.string().min(1) }).optional(),
});
// What the Auth0 Action sends to the link page and what the link cookie keeps. The length bounds keep the sealed cookies within
// the 4096 characters `unseal` reads: the longest ASCII values seal to 3842 characters (link cookie) and 3711 (login cookie).
const linkText = z.string().min(1).max(256);
const linkClaims = z.object({ sub: linkText, primary: linkText, connection: linkText });
const linkQuery = z.object({ session_token: z.string().min(1).max(4096), state: z.string().min(1).max(2000) });
const linkSchema = z.strictObject({ auth0State: z.string().min(1).max(2000), subject: linkText, primary: linkText, connection: linkText });
const ttl = 300_000;
const resumeSeconds = 300;
const sessionAge = 8 * 60 * 60 * 1000;
const sessionCookie = '__Host-eigos-account';
const loginCookie = '__Host-eigos-account-login';
const linkCookie = '__Host-eigos-account-link';
const sessionShape = /^[A-Za-z0-9_-]{43}$/, sealedShape = /^[A-Za-z0-9_-]{1,4096}$/;
const cookieOptions = { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/' };
const statuses = {
  login: '登录没有完成，请重新登录。',
  verify: '请先打开 Auth0 发到你邮箱的验证邮件，验证后再重新登录。',
  tenant: '登录服务的配置不完整，缺少租户信息，请联系 EIGOS 支持。',
  closed: '目前暂停注册新账号。',
  invite: '邀请码无效、已过期，或者和已验证的邮箱不一致。',
  operator: '这是运营者账号，不需要开通，请继续使用原来的客户端。',
  origin: '请回到账号页重新提交。',
  link: '合并没有完成，请用原来的方式重新登录。',
} as const;

function cookie(req: Request, key: string, shape: RegExp) {
  const value = req.headers.cookie?.split(';').map(item => item.trim()).find(item => item.startsWith(key + '='))?.slice(key.length + 1);
  return value && shape.test(value) ? value : '';
}

const page = (heading: string, body: string) => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EIGOS 账号</title>
      <style>body{font:1rem system-ui;max-width:42rem;margin:7vh auto;padding:0 1.5rem;line-height:1.6}button,input,.button{font:inherit;padding:.35rem .6rem}.button{display:inline-block;border:1px solid;border-radius:.25rem;color:inherit;text-decoration:none}form{margin-block:1.3rem}dd{margin:0 0 .75rem;overflow-wrap:anywhere}</style>
      <main><h1>${heading}</h1>${body}</main></html>`;

/**
 * The link context of a request from Auth0's paused login, or undefined unless it carries a fresh HS256 session token that
 * the Action signed with the account link secret. `sub` is the user who is being merged, `primary` the account they merge
 * into, `connection` the login method of that account and `state` the paused Auth0 login.
 */
async function pausedLogin(key: Uint8Array, query: unknown) {
  const request = linkQuery.safeParse(query);
  if (!request.success) return undefined;
  try {
    const { payload } = await jwtVerify(request.data.session_token, key, { algorithms: ['HS256'], requiredClaims: ['sub', 'exp'] });
    const claims = linkClaims.safeParse(payload);
    return claims.success
      ? { auth0State: request.data.state, subject: claims.data.sub, primary: claims.data.primary, connection: claims.data.connection }
      : undefined;
  } catch { return undefined; }
}

/** Where Auth0 resumes the paused login: its original state and a five-minute token that names the merged user and the verified account. */
async function resumeUrl(issuer: string, key: Uint8Array, link: NonNullable<LoginAttempt['link']>) {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ state: link.auth0State, primary: link.primary }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(link.subject).setIssuedAt(now).setExpirationTime(now + resumeSeconds).sign(key);
  const url = new URL('continue', issuer);
  url.search = new URLSearchParams({ state: link.auth0State, session_token: token }).toString();
  return url;
}

export function auth0AccountLogin(config: Config, exchange: typeof fetch = fetch,
  keys: JWTVerifyGetKey = createRemoteJWKSet(new URL(config.OAUTH_JWKS_URL!))) {
  const issuer = config.OAUTH_ISSUER!, clientId = config.OAUTH_MEMBER_CLIENT_ID!;
  const redirectUri = config.PUBLIC_URL + '/account/callback';
  return {
    /** `signup` opens Auth0's sign-up screen. `linking` asks for a fresh login, never a sign-up, and `connection` pins the login method. */
    start(attempt: LoginAttempt, options: { signup: boolean; connection?: string; linking?: boolean }) {
      const url = new URL('authorize', issuer);
      url.search = new URLSearchParams({
        client_id: clientId, response_type: 'code', redirect_uri: redirectUri, scope: 'openid email',
        state: attempt.state, nonce: attempt.nonce, code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url'),
        ...(options.connection ? { connection: options.connection } : {}),
        ...(options.linking ? { prompt: 'login' } : options.signup ? { screen_hint: 'signup', prompt: 'login' } : {}),
      }).toString();
      return url;
    },
    async finish(code: string, attempt: LoginAttempt): Promise<LoginResult> {
      const response = await exchange(new URL('oauth/token', issuer), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        body: new URLSearchParams({ grant_type: 'authorization_code', code,
          client_id: clientId, client_secret: config.OAUTH_MEMBER_CLIENT_SECRET!,
          code_verifier: attempt.verifier, redirect_uri: redirectUri }),
      });
      if (!response.ok) throw new Error('Identity provider rejected the authorization code');
      const { id_token } = z.object({ id_token: z.string() }).parse(await response.json());
      const { payload } = await jwtVerify(id_token, keys, { issuer, audience: clientId, algorithms: ['RS256'],
        requiredClaims: ['sub', 'iat', 'exp', 'nonce'] });
      if (payload.nonce !== attempt.nonce || (payload.azp !== undefined && payload.azp !== clientId) ||
          (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)) {
        throw new Error('Identity token did not match this login');
      }
      const subject = z.string().min(1).parse(payload.sub), tenant = payload[config.OAUTH_TENANT_CLAIM];
      if (typeof tenant !== 'string' || !tenant) return { kind: 'tenant_missing' };
      if (payload.email_verified !== true) return { kind: 'unverified', subject };
      return { kind: 'verified', owner: digest([issuer, tenant, subject]), email: z.email().parse(payload.email), subject };
    },
  };
}

export function mountAccountPortal(app: express.Express, config: Config, accounts: Accounts, login = auth0AccountLogin(config)) {
  const secret = config.EIGOS_PORTAL_SECRET!;
  // The Action and this portal share this secret to sign tokens. The cookies use the portal secret, which Auth0 never sees.
  const linkKey = new TextEncoder().encode(config.EIGOS_ACCOUNT_LINK_SECRET!);
  // One counter per group and client address: every login-flow GET shares one, every POST shares the other.
  const flowLimit = rateLimit({ windowMs: 60_000, max: 20 }), postLimit = rateLimit({ windowMs: 60_000, max: 30 });
  const redirect = (res: Response, status?: keyof typeof statuses) =>
    res.redirect(303, '/account' + (status ? '?status=' + status : ''));
  app.use('/account', express.urlencoded({ extended: false, limit: '2kb' }), (_req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
    });
    next();
  });
  app.get('/account', async (req, res) => {
    const session = await accounts.session(cookie(req, sessionCookie, sessionShape));
    const account = session && await accounts.account(session.owner);
    const status = typeof req.query.status === 'string' && Object.hasOwn(statuses, req.query.status)
      ? req.query.status as keyof typeof statuses : undefined;
    let content: string, explains: keyof typeof statuses | undefined;
    if (!session) content = '<p><a href="/account/login?signup=1">注册</a> · <a href="/account/login">登录</a></p>';
    else if (!account) {
      if (await accounts.isOperator(session.owner)) { explains = 'operator'; content = `<p>${statuses.operator}</p>`; }
      else if (config.EIGOS_SIGNUP === 'invite') content = '<form method="post" action="/account/activate"><label>邀请码 <input name="code" autocomplete="off" maxlength="43" required></label> <button>开通账号</button></form>';
      else if (config.EIGOS_SIGNUP === 'closed') { explains = 'closed'; content = `<p>${statuses.closed}</p>`; }
      else content = '<p>账号还没有开通，请重新登录。</p>';
    } else if (account.status === 'suspended') content = '<p>这个账号已停用，请联系 EIGOS 支持。</p>';
    else if (account.revoked_at) content = '<p>已撤销 Grok 的访问，需要时可以重新授权。</p><form method="post" action="/account/approve"><button>重新授权 Grok</button></form>';
    else if (account.approved_at) content = `<p>已允许 Grok 请求访问。请在 Grok 添加远程 HTTPS MCP，使用 EIGOS 账号完成 OAuth。</p>
      <dl><dt>服务地址</dt><dd><code>${new URL('/mcp', config.PUBLIC_URL).href}</code></dd><dt>OAuth Client ID</dt><dd><code>${config.OAUTH_MEMBER_MCP_CLIENT_ID}</code></dd></dl>
      <form method="post" action="/account/revoke"><button>撤销 Grok 授权</button></form>`;
    else content = '<p>账号已开通。授权后，Grok 可以提交和读取你自己的查询任务。</p><form method="post" action="/account/approve"><button>授权 Grok</button></form>';
    // A status the page body already spells out is not repeated as a banner.
    const banner = status && status !== explains ? `<p role="status">${statuses[status]}</p>` : '';
    // Browser form navigation must preserve Origin for the POST checks. The OIDC callback remains no-referrer.
    res.set('Referrer-Policy', 'same-origin').type('html').send(page('EIGOS 账号', `${banner}${content}
      ${session ? '<form method="post" action="/account/logout"><button>退出登录</button></form>' : ''}`));
  });
  app.get('/account/login', flowLimit, (req, res) => {
    // The attempt travels in a sealed cookie, so any Gateway replica can finish the login.
    const attempt: LoginAttempt = { state: newAccountSecret(), nonce: newAccountSecret(), verifier: newAccountSecret() };
    res.cookie(loginCookie, seal(secret, 'login', attempt, ttl), { ...cookieOptions, maxAge: ttl });
    res.redirect(303, login.start(attempt, { signup: req.query.signup === '1' }).href);
  });
  // Auth0 pauses a login whose verified email already belongs to an older account and sends the browser here. The page keeps
  // that context in a sealed cookie and asks for a second login with the original method. The address carries a token, so the
  // portal-wide `Referrer-Policy: no-referrer` stays in force and the page repeats nothing it was given.
  app.get('/account/link', flowLimit, async (req, res) => {
    const link = await pausedLogin(linkKey, req.query);
    if (!link) { redirect(res, 'link'); return; }
    res.cookie(linkCookie, seal(secret, 'link', link, ttl), { ...cookieOptions, maxAge: ttl });
    res.type('html').send(page('合并账号', `<p>这个邮箱已经有 EIGOS 账号。为了确认是你本人，请用原来的方式再登录一次，登录后两个登录方式会合并成一个账号。</p>
      <p><a class="button" href="/account/link/continue">用原来的方式登录</a></p>`));
  });
  app.get('/account/link/continue', flowLimit, (req, res) => {
    const link = unseal(secret, 'link', cookie(req, linkCookie, sealedShape), linkSchema);
    if (!link) { redirect(res, 'link'); return; }
    const { connection, ...paused } = link;
    const attempt: LoginAttempt = { state: newAccountSecret(), nonce: newAccountSecret(), verifier: newAccountSecret(), link: paused };
    res.cookie(loginCookie, seal(secret, 'login', attempt, ttl), { ...cookieOptions, maxAge: ttl });
    res.redirect(303, login.start(attempt, { signup: false, connection, linking: true }).href);
  });
  app.get('/account/callback', flowLimit, async (req, res) => {
    const attempt = unseal(secret, 'login', cookie(req, loginCookie, sealedShape), attemptSchema);
    res.clearCookie(loginCookie, cookieOptions);
    const code = z.string().min(1).max(3000).safeParse(req.query.code);
    if (!attempt || req.query.state !== attempt.state || !code.success) { redirect(res, 'login'); return; }
    let result: LoginResult;
    // The authorization code works once, so a replayed callback fails here as well.
    try { result = await login.finish(code.data, attempt); } catch { redirect(res, 'login'); return; }
    if (attempt.link) {
      // This login only proves the original account to Auth0. Anything but that account's verified sign-in turns back, and
      // neither outcome opens a session or an account here.
      if (result.kind === 'verified' && result.subject === attempt.link.primary)
        res.redirect(303, (await resumeUrl(config.OAUTH_ISSUER!, linkKey, attempt.link)).href);
      else redirect(res, 'link');
      return;
    }
    if (result.kind === 'tenant_missing') { redirect(res, 'tenant'); return; }
    const previous = cookie(req, sessionCookie, sessionShape);
    if (result.kind === 'unverified') {
      if (previous) await accounts.endSession(previous);
      res.clearCookie(sessionCookie, cookieOptions);
      redirect(res, 'verify'); return;
    }
    const opened = await accounts.provision(result.owner, emailDigest(result.email));
    const session = await accounts.startSession(result.owner, result.email, previous);
    res.cookie(sessionCookie, session, { ...cookieOptions, maxAge: sessionAge });
    // An invitation-only deployment opens the account on the page, so `invite_required` needs no status.
    redirect(res, opened === 'signup_closed' ? 'closed' : opened === 'operator_account' ? 'operator' : undefined);
  });
  app.post(['/account/activate', '/account/approve', '/account/revoke', '/account/logout'], postLimit, async (req, res) => {
    if (req.headers.origin !== config.PUBLIC_URL) { res.status(403).send(statuses.origin); return; }
    const token = cookie(req, sessionCookie, sessionShape), session = await accounts.session(token);
    if (!session) { res.sendStatus(401); return; }
    if (req.path === '/account/activate') {
      const code = z.string().regex(/^[A-Za-z0-9_-]{43}$/).safeParse(req.body?.code);
      const outcome = code.success ? await accounts.activate(session, code.data) : 'invalid';
      redirect(res, outcome === 'activated' ? undefined : outcome === 'operator_account' ? 'operator'
        : config.EIGOS_SIGNUP === 'closed' ? 'closed' : 'invite'); return;
    }
    if (req.path === '/account/approve') await accounts.approve(session.owner);
    else if (req.path === '/account/revoke') await accounts.revoke(session.owner);
    else {
      await accounts.endSession(token);
      res.clearCookie(sessionCookie, cookieOptions);
    }
    redirect(res);
  });
  // The portal used to live at /members.
  app.get(['/members', '/members/*path'], (_req, res) => res.redirect(302, '/account'));
}
