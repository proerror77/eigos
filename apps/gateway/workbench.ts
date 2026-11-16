import { readFileSync } from 'node:fs';
import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Config } from '../../packages/core/config.js';
import type { VerifyToken } from './auth.js';
import { z } from 'zod';

const scopes = 'openid ontology:read ontology:write tasks:read tasks:write';
const deviceGrant = 'urn:ietf:params:oauth:grant-type:device_code';

export function mountWorkbench(app: express.Express, config: Config, verify: VerifyToken) {
  const directory = fileURLToPath(new URL('../workbench/', import.meta.url));
  const importMap =
    readFileSync(join(directory, 'index.html'), 'utf8').match(
      /<script type="importmap">([\s\S]*?)<\/script>/,
    )?.[1] ?? '';
  const require = createRequire(import.meta.url),
    three = join(dirname(require.resolve('three')), '..');
  const issuer = config.OAUTH_ISSUER;
  const clientId = config.EIGOS_AUTH_MODE === 'jwt' ? config.OAUTH_WORKBENCH_CLIENT_ID : undefined;
  const cookieOptions = {
    httpOnly: true, secure: new URL(config.PUBLIC_URL).protocol === 'https:',
    sameSite: 'strict', path: '/workbench/login',
  } as const;
  let starting = 0;
  const logins = new Map<
    string,
    { device: string; expires: number; interval: number; next: number; cookie: string; polling?: boolean }
  >();
  const cookie = (req: express.Request) =>
    req.headers.cookie
      ?.split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('eigos_login='))
      ?.slice(12);
  const deviceSchema = z
    .strictObject({
      device_code: z.string(),
      user_code: z.string(),
      verification_uri_complete: z.url(),
      expires_in: z.number().int().positive(),
      interval: z.number().int().positive().optional(),
    })
    .passthrough();
  app.use('/workbench', (_req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self' 'sha256-${createHash('sha256').update(importMap).digest('base64')}'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
    );
    res.setHeader('Permissions-Policy', 'geolocation=(self)');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.get('/workbench/config', (_req, res) =>
    res.json({
      development: config.EIGOS_AUTH_MODE === 'development',
      deviceLogin: Boolean(clientId && issuer),
      scopes,
    }),
  );
  app.use('/workbench/login', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  const providerRequest = (path: string, fields: Record<string, string>) => fetch(new URL(path, issuer), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  app.post('/workbench/login/start', async (req, res) => {
    if (!clientId || !issuer) {
      res.status(503).json({ error: '请先配置工作台登录。' });
      return;
    }
    const now = Date.now(), previous = cookie(req);
    for (const [id, session] of logins)
      if (session.expires <= now || session.cookie === previous) logins.delete(id);
    if (logins.size + starting >= 100) {
      res.status(429).json({ error: '当前登录请求过多，请稍后重试。' });
      return;
    }
    starting++;
    try {
      const response = await providerRequest('oauth/device/code', {
        client_id: clientId, audience: config.OAUTH_AUDIENCE!, scope: scopes,
      });
      if (!response.ok) throw new Error('Device authorization failed');
      const data = deviceSchema.parse(await response.json());
      if (new URL(data.verification_uri_complete).origin !== new URL(issuer).origin)
        throw new Error('Unexpected login provider URL');
      const id = randomUUID(), secret = randomUUID();
      const interval = Math.max(5, data.interval ?? 5), expiresIn = Math.min(data.expires_in, 900);
      const issued = Date.now();
      logins.set(id, {
        device: data.device_code, cookie: secret, interval,
        expires: issued + expiresIn * 1000, next: issued + interval * 1000,
      });
      res.cookie('eigos_login', secret, { ...cookieOptions, maxAge: expiresIn * 1000 });
      res.json({ id, userCode: data.user_code, url: data.verification_uri_complete, interval, expiresIn });
    } catch {
      res.status(502).json({ error: '账户服务无法开始登录，请稍后重试。' });
    } finally {
      starting--;
    }
  });
  app.post('/workbench/login/poll', async (req, res) => {
    const id = z.uuid().parse(req.body.id), session = logins.get(id);
    if (!clientId || !session || session.expires <= Date.now() || session.cookie !== cookie(req)) {
      res.status(403).json({ error: '登录会话已失效，请重新开始。' });
      return;
    }
    if (session.polling || Date.now() < session.next) {
      res.status(202).json({ pending: true, interval: session.interval });
      return;
    }
    session.polling = true;
    try {
      const response = await providerRequest('oauth/token', {
        client_id: clientId, device_code: session.device, grant_type: deviceGrant,
      });
      const data = z.object({
        error: z.string().optional(), access_token: z.string().optional(), expires_in: z.number().optional(),
      }).parse(await response.json());
      if (data.error === 'authorization_pending' || data.error === 'slow_down') {
        if (data.error === 'slow_down') session.interval += 5;
        res.status(202).json({ pending: true, interval: session.interval });
        return;
      }
      logins.delete(id);
      res.clearCookie('eigos_login', cookieOptions);
      if (!response.ok || !data.access_token || session.expires <= Date.now()) {
        res.status(403).json({ error: '登录已被拒绝或过期，请重新开始。' });
        return;
      }
      const identity = await verify(data.access_token).catch(() => null);
      if (identity?.clientId !== clientId || !identity.scopes.includes('ontology:read')) {
        res.status(403).json({ error: '此账户没有可用于工作台的访问权限。' });
        return;
      }
      res.json({ accessToken: data.access_token, expiresIn: data.expires_in });
    } catch {
      res.status(502).json({ error: '账户服务暂时无法验证登录，请重试。' });
    } finally {
      session.polling = false;
      session.next = Date.now() + session.interval * 1000;
    }
  });
  app.use('/workbench/vendor/three', express.static(three, { dotfiles: 'deny', index: false }));
  app.use('/workbench', express.static(directory, { dotfiles: 'deny', index: 'index.html' }));
}
