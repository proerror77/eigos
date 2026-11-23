import { createHash } from 'node:crypto';
import express, { type Request, type RequestHandler, type Response } from 'express';
import { createRemoteJWKSet, errors, jwtVerify, SignJWT, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import type { Config } from '../../packages/core/config.js';
import { digest } from '../../packages/core/identity.js';
import { Accounts, emailDigest, newAccountSecret } from '../../packages/runtime/accounts.js';
import type { Auth0Management } from './auth0-management.js';
import { rateLimit } from './rate-limit.js';
import { seal, unseal } from './sealed-cookie.js';

/**
 * One sign-in of the portal. `link` is set on the login that verifies the original account for a login that Auth0 paused for
 * linking. Its `first` is the portal sign-in that Auth0 paused, when the browser still held it. A finished merge hands `first` back
 * with `expect`, the account it merged into, which is the only user that sign-in may come back as.
 */
export type LoginAttempt = {
  state: string; nonce: string; verifier: string; expect?: string;
  link?: { auth0State: string; subject: string; primary: string; first?: { state: string; nonce: string; verifier: string } };
};
export type LoginResult =
  | { kind: 'verified'; owner: string; email: string; subject: string }
  | { kind: 'unverified'; subject: string }
  | { kind: 'tenant_missing' };

const attemptFields = { state: z.string().min(1), nonce: z.string().min(1), verifier: z.string().min(1) };
const attemptSchema: z.ZodType<LoginAttempt> = z.strictObject({
  ...attemptFields,
  expect: z.string().min(1).optional(),
  link: z.strictObject({ auth0State: z.string().min(1), subject: z.string().min(1), primary: z.string().min(1),
    first: z.strictObject(attemptFields).optional() }).optional(),
});
// What the Auth0 Action sends to the link page and what the link cookie keeps. The length bounds keep the sealed cookies within
// the 4096 characters `unseal` reads: the longest ASCII values seal to 3842 characters (link cookie) and 3944 (the login cookie of
// a merge, with the paused sign-in inside it). The paused sign-in that a finished merge hands back, with its primary, is far shorter.
const linkText = z.string().min(1).max(256);
const linkClaims = z.object({ sub: linkText, primary: linkText, connection: linkText });
const linkQuery = z.object({ session_token: z.string().min(1).max(4096), state: z.string().min(1).max(2000) });
const linkSchema = z.strictObject({ auth0State: z.string().min(1).max(2000), subject: linkText, primary: linkText, connection: linkText });
const verifySchema = z.strictObject({ subject: z.string().min(1) });
const ttl = 300_000;
const verifyTtl = 600_000;
const resumeSeconds = 300;
const sessionAge = 8 * 60 * 60 * 1000;
const sessionCookie = '__Host-eigos-account';
const loginCookie = '__Host-eigos-account-login';
const linkCookie = '__Host-eigos-account-link';
const verifyCookie = '__Host-eigos-account-verify';
const sessionShape = /^[A-Za-z0-9_-]{43}$/, sealedShape = /^[A-Za-z0-9_-]{1,4096}$/;
const cookieOptions = { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/' };
const statuses = {
  login: '登录没有完成，请重新登录。',
  verify: '请先打开 Auth0 发到你邮箱的验证邮件，验证后再重新登录。',
  tenant: '登录服务的配置不完整，缺少租户信息，请联系 EIGOS 支持。',
  closed: '目前暂停注册新账号。',
  invite: '邀请码无效、已过期，或与你的账号不匹配。',
  application: '请填写已验证的登录邮箱和申请用途。',
  operator: '这是运营者账号，不需要开通，请继续使用原来的客户端。',
  origin: '请回到账号页重新提交。',
  link: '合并没有完成，请用原来的方式重新登录。',
  resent: '验证邮件已重新发送，请查收后重新登录。',
} as const;

/**
 * What a log line says about a failed step. An error message can quote what could not be read: a JSON error shows the start of the
 * answer, a schema error lists its issues, a URL error repeats the address. So a message is kept only when its wording is fixed, which
 * holds for the plain errors of this portal and of the Management client, for jose's errors and for fetch's "fetch failed". Any other
 * error is named by its class. The result is short and has no line break.
 */
function reason(error: unknown) {
  if (!(error instanceof Error)) return 'unknown error';
  const fixed = error.constructor === Error || error instanceof errors.JOSEError || error.message === 'fetch failed';
  return (fixed ? error.message : error.name).replace(/\s+/g, ' ').slice(0, 200);
}
const logFailure = (what: string, error: unknown) => console.error(`EIGOS account: ${what}: ${reason(error)}`);

function cookie(req: Request, key: string, shape: RegExp) {
  const value = req.headers.cookie?.split(';').map(item => item.trim()).find(item => item.startsWith(key + '='))?.slice(key.length + 1);
  return value && shape.test(value) ? value : '';
}

const page = (heading: string, body: string) => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EIGOS 账号</title>
      <style>body{font:1rem system-ui;max-width:42rem;margin:7vh auto;padding:0 1.5rem;line-height:1.6}button,input,textarea,.button{font:inherit;padding:.35rem .6rem}.button{display:inline-block;border:1px solid;border-radius:.25rem;color:inherit;text-decoration:none}form{margin-block:1.3rem}dd{margin:0 0 .75rem;overflow-wrap:anywhere}</style>
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

/**
 * The sign-in that Auth0 paused, read from the login cookie that the browser sends to the continue address: the portal's own first
 * attempt, or the one that an earlier visit for the same paused login already carries. Undefined when the browser holds neither.
 */
function pausedSignIn(held: LoginAttempt | undefined, auth0State: string) {
  if (!held) return undefined;
  if (!held.link) return { state: held.state, nonce: held.nonce, verifier: held.verifier };
  return held.link.auth0State === auth0State ? held.link.first : undefined;
}

/**
 * How Auth0 resumes the paused login: its continue address with the original state, and a five-minute token that names the merged
 * user and the verified account. Auth0 takes the token in the body of a POST to that address.
 */
async function resumeLogin(issuer: string, key: Uint8Array, link: NonNullable<LoginAttempt['link']>) {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ state: link.auth0State, primary: link.primary }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(link.subject).setIssuedAt(now).setExpirationTime(now + resumeSeconds).sign(key);
  const action = new URL('continue', issuer);
  action.search = new URLSearchParams({ state: link.auth0State }).toString();
  return { action, token };
}

/** Text for an HTML attribute in double quotes. */
const attribute = (text: string) => text.replace(/[&"'<>]/g, character => `&#${character.charCodeAt(0)};`);

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

export function mountAccountPortal(app: express.Express, config: Config, accounts: Accounts, login = auth0AccountLogin(config),
  management?: Auth0Management) {
  const secret = config.EIGOS_PORTAL_SECRET!;
  // The Action and this portal share this secret to sign tokens. The cookies use the portal secret, which Auth0 never sees.
  const linkKey = new TextEncoder().encode(config.EIGOS_ACCOUNT_LINK_SECRET!);
  // One counter per group and client address: every login-flow GET shares one, every POST of the session forms shares the other.
  const flowLimit = rateLimit({ windowMs: 60_000, max: 20 }), postLimit = rateLimit({ windowMs: 60_000, max: 30 });
  // A resend sends a mail to whoever owns the address that signed up, so it has a small counter of its own that counts hours, not minutes.
  const resendLimit = rateLimit({ windowMs: 3_600_000, max: 5 });
  const sameOrigin: RequestHandler = (req, res, next) => {
    if (req.headers.origin !== config.PUBLIC_URL) { res.status(403).send(statuses.origin); return; }
    next();
  };
  const redirect = (res: Response, status?: keyof typeof statuses) =>
    res.redirect(303, '/account' + (status ? '?status=' + status : ''));
  app.use('/account', express.urlencoded({ extended: false, limit: '5kb' }), (_req, res, next) => {
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
    if (!session) content = `${config.EIGOS_SIGNUP === 'invite' ? '<p>注册并验证邮箱后，即可加入 EIGOS Beta 候补名单。</p>' : ''}
      <p><a href="/account/login?signup=1">注册</a> · <a href="/account/login">登录</a></p>`;
    else if (!account) {
      if (await accounts.isOperator(session.owner)) { explains = 'operator'; content = `<p>${statuses.operator}</p>`; }
      else if (config.EIGOS_SIGNUP === 'invite') {
        const application = await accounts.applicationStatus(session);
        const apply = application === 'invited' ? '<p>申请已通过。可以使用此前收到的有效邀请码，或等待运营直接开通。</p>'
          : application === 'pending' ? '<p>已加入候补名单，等待运营审核。通过后在此页面接入你的 Agent。</p>'
          : `<form method="post" action="/account/apply">
              <p><label>已验证的登录邮箱 <input type="email" name="email" autocomplete="email" maxlength="254" required></label></p>
              <p><label>你计划用 Agent 做什么？<br><textarea name="purpose" maxlength="300" rows="3" required></textarea></label></p>
              <p>运营审核通过后会直接开通账号。</p><button>加入 Beta 候补名单</button>
            </form>`;
        content = apply + '<details><summary>使用此前收到的邀请码</summary><form method="post" action="/account/activate"><label>邀请码 <input name="code" autocomplete="off" maxlength="43" required></label> <button>开通账号</button></form></details>';
      } else if (config.EIGOS_SIGNUP === 'closed') { explains = 'closed'; content = `<p>${statuses.closed}</p>`; }
      else content = '<p>账号还没有开通，请重新登录。</p>';
    } else if (account.status === 'suspended') content = '<p>这个账号已停用，请联系 EIGOS 支持。</p>';
    else {
      const connection = account.has_agent_token
        ? '<p>重新生成后，旧的接入令牌立即失效。</p><button>重新生成接入令牌</button>'
        : '<button>生成接入令牌</button>';
      const direct = `<h2>MCP 或 A2A</h2><p>把接入令牌配置到客户端。每次请求由客户端自动携带，无需重复登录。</p>
        <form method="post" action="/account/agent-token">${connection}</form>`;
      const oauth = account.revoked_at
        ? '<p>已撤销 Agent 接入。</p><form method="post" action="/account/approve"><button>重新授权 Grok</button></form>'
        : account.approved_at ? `<p>在支持的客户端添加远程 HTTPS MCP，使用 EIGOS 账号完成 OAuth。</p>
          <dl><dt>MCP 地址</dt><dd><code>${new URL('/mcp', config.PUBLIC_URL).href}</code></dd><dt>OAuth Client ID</dt><dd><code>${config.OAUTH_MEMBER_MCP_CLIENT_ID}</code></dd></dl>`
          : '<form method="post" action="/account/approve"><button>授权 Grok</button></form>';
      const revoke = account.approved_at && !account.revoked_at
        ? '<form method="post" action="/account/revoke"><button>撤销 Agent 接入</button></form>' : '';
      content = `<p>Beta 账号已开通。</p>${direct}<h2>Grok OAuth</h2>${oauth}${revoke}`;
    }
    // A status the page body already spells out is not repeated as a banner.
    const banner = status && status !== explains ? `<p role="status">${statuses[status]}</p>` : '';
    // The verify status offers a new verification email when there is a Management API client to ask for it.
    const resend = status === 'verify' && management
      ? '<form method="post" action="/account/resend-verification"><button>重新发送验证邮件</button></form>' : '';
    // Browser form navigation must preserve Origin for the POST checks. The OIDC callback remains no-referrer.
    res.set('Referrer-Policy', 'same-origin').type('html').send(page('EIGOS 账号', `${banner}${resend}${content}
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
    // The browser may still hold the sign-in that Auth0 paused. It goes inside this attempt, because the login cookie is replaced here.
    const first = pausedSignIn(unseal(secret, 'login', cookie(req, loginCookie, sealedShape), attemptSchema), paused.auth0State);
    const attempt: LoginAttempt = { state: newAccountSecret(), nonce: newAccountSecret(), verifier: newAccountSecret(), link: { ...paused, ...(first && { first }) } };
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
    try { result = await login.finish(code.data, attempt); } catch (error) {
      logFailure('sign-in could not be completed', error);
      redirect(res, 'login'); return;
    }
    if (attempt.link) {
      // This login only proves the original account to Auth0. Anything but that account's verified sign-in turns back, and
      // neither outcome opens a session or an account here.
      if (result.kind !== 'verified' || result.subject !== attempt.link.primary) { redirect(res, 'link'); return; }
      // Whoever just proved they own the account authorizes its agents again: an agent that someone connected before the merge, for
      // example to an address they registered first, loses its access here. The account page then offers to authorize again.
      await accounts.revoke(result.owner);
      const { action, token } = await resumeLogin(config.OAUTH_ISSUER!, linkKey, attempt.link);
      // Auth0 now resumes the sign-in it paused and sends the browser back to this callback with that sign-in's own state, so the
      // first attempt goes back into the login cookie, bound to the account it merges into. A browser keeps the last Set-Cookie of a
      // name, which replaces the drop above. Only a finished merge gets here: a failed one leaves the paused sign-in dropped and the
      // link cookie in place.
      if (attempt.link.first) {
        res.cookie(loginCookie, seal(secret, 'login', { ...attempt.link.first, expect: attempt.link.primary }, ttl), { ...cookieOptions, maxAge: ttl });
      }
      res.clearCookie(linkCookie, cookieOptions);
      // Auth0 takes the token in a POST, and no script may send one under this policy, so the user presses the button. The form may go
      // to Auth0, and to this origin too, because browsers check the redirect that answers the POST, back to this callback, as well.
      // This address carries the code, so the POST tells Auth0 only the origin it comes from.
      res.set({
        'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${new URL(config.OAUTH_ISSUER!).origin}; frame-ancestors 'none'; base-uri 'none'`,
        'Referrer-Policy': 'strict-origin',
      }).type('html').send(page('合并账号', `<p>已确认是你原来的账号。点「继续」完成合并，回到刚才的登录。</p>
      <form method="post" action="${attribute(action.href)}"><input type="hidden" name="session_token" value="${attribute(token)}"><button>继续</button></form>`));
      return;
    }
    // The sign-in that a merge handed back has to return as the account it merged into. Anything else, such as the merged user on
    // its own because Auth0 did not switch the login, turns back with no session and no account.
    if (attempt.expect !== undefined && (result.kind !== 'verified' || result.subject !== attempt.expect)) { redirect(res, 'link'); return; }
    if (result.kind === 'tenant_missing') { redirect(res, 'tenant'); return; }
    const previous = cookie(req, sessionCookie, sessionShape);
    if (result.kind === 'unverified') {
      if (previous) await accounts.endSession(previous);
      res.clearCookie(sessionCookie, cookieOptions);
      // The browser has no session to name this user, so a sealed cookie holds the Auth0 user for the resend on the verify page.
      res.cookie(verifyCookie, seal(secret, 'verify', { subject: result.subject }, verifyTtl), { ...cookieOptions, maxAge: verifyTtl });
      redirect(res, 'verify'); return;
    }
    const opened = await accounts.provision(result.owner, emailDigest(result.email));
    const session = await accounts.startSession(result.owner, result.email, previous);
    res.cookie(sessionCookie, session, { ...cookieOptions, maxAge: sessionAge });
    // The account page shows the review status for applicants in invite mode.
    redirect(res, opened === 'signup_closed' ? 'closed' : opened === 'operator_account' ? 'operator' : undefined);
  });
  // Unlike the forms below, this one has no session: the sign-in ended at an unverified email, and only the verify cookie names the user.
  // The route exists only when there is a Management API client to ask.
  if (management) {
    app.post('/account/resend-verification', sameOrigin, resendLimit, async (req, res) => {
      const held = unseal(secret, 'verify', cookie(req, verifyCookie, sealedShape), verifySchema);
      if (!held) { redirect(res, 'verify'); return; }
      // Whatever went wrong at Auth0 goes to the log and not to the browser, which lands on the same page as without a cookie.
      try { await management.resendVerification(held.subject); } catch (error) {
        logFailure('verification email resend failed', error);
        redirect(res, 'verify'); return;
      }
      redirect(res, 'resent');
    });
  }
  app.post(['/account/apply', '/account/activate', '/account/agent-token', '/account/approve', '/account/revoke', '/account/logout'], postLimit, sameOrigin, async (req, res) => {
    const token = cookie(req, sessionCookie, sessionShape), session = await accounts.session(token);
    if (!session) { res.sendStatus(401); return; }
    if (req.path === '/account/apply') {
      const application = z.object({ email: z.string().trim().max(254).pipe(z.email()), purpose: z.string().trim().min(1).max(300) }).safeParse(req.body);
      const submitted = application.success && await accounts.apply(session, application.data.email, application.data.purpose);
      redirect(res, submitted ? undefined : 'application'); return;
    }
    if (req.path === '/account/activate') {
      const code = z.string().regex(/^[A-Za-z0-9_-]{43}$/).safeParse(req.body?.code);
      const outcome = code.success ? await accounts.activate(session, code.data) : 'invalid';
      redirect(res, outcome === 'activated' ? undefined : outcome === 'operator_account' ? 'operator'
        : config.EIGOS_SIGNUP === 'closed' ? 'closed' : 'invite'); return;
    }
    if (req.path === '/account/agent-token') {
      const credential = await accounts.issueAgentToken(session.owner);
      if (!credential) { res.sendStatus(403); return; }
      res.type('html').send(page('Agent 接入令牌', `<p>令牌只显示一次，请保存到客户端的凭据配置。</p>
        <dl><dt>MCP</dt><dd><code>${new URL('/mcp', config.PUBLIC_URL).href}</code></dd>
        <dt>A2A</dt><dd><code>${new URL('/a2a', config.PUBLIC_URL).href}</code></dd>
        <dt>请求头</dt><dd><code>Authorization: Bearer ${credential}</code></dd></dl>
        <p><a href="/account">返回账号页</a></p>`));
      return;
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
