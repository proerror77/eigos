import { escape, form } from './html.js';
import { directoryControls, directoryBrowserPage, directoryDetailPage } from './directory-page.js';
import type { Express, Request, RequestHandler } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../../../packages/core/config.js';
import { DomainError, type Principal } from '../../../packages/core/domain.js';
import { MemberAccessError, type MemberStore } from '../../../packages/members/store.js';
import { AgentAccessError } from '../../../packages/members/agents.js';
import { NetworkService } from '../../../packages/network/service.js';
import { NetworkError, commands } from '../../../packages/network/contracts.js';

export function networkFailure(error: unknown): { status: number; body: object } {
  if (error instanceof NetworkError) return { status: error.status, body: { version: 1, error: { code: error.code, retryable: false } } };
  if (error instanceof z.ZodError) return { status: 422, body: { version: 1, error: { code: 'INVALID_INPUT', retryable: false } } };
  if (error instanceof DomainError) return { status: error.code === 'NOT_FOUND' ? 404 : error.code === 'FORBIDDEN' ? 403 : 409, body: { version: 1, error: { code: error.code, retryable: false } } };
  if (error instanceof AgentAccessError || error instanceof MemberAccessError) return { status: 403, body: { version: 1, error: { code: 'ACTOR_REQUIRED', retryable: false } } };
  return { status: 503, body: { version: 1, error: { code: 'TEMPORARILY_UNAVAILABLE', retryable: true } } };
}
export function networkPage(service: NetworkService, memberId: string, csrf: string): string {
  const p = service.panel(memberId);
  const profiles = p.profiles.map(profile => `<section><h2>${escape(profile.displayName)}</h2><p>身份 ${escape(profile.id)}</p>` + form(csrf, { action: 'profile.update', profileId: profile.id, expectedRevision: profile.revision, displayName: profile.displayName }, '修改显示名称', `<label>显示名称 <input name="displayName" value="${escape(profile.displayName)}" required></label>`) + form(csrf, { action: 'profile.set_state', profileId: profile.id, expectedRevision: profile.revision, state: profile.state === 'suspended' ? 'active' : 'suspended' }, profile.state === 'suspended' ? '重新启用身份（不恢复旧许可）' : '停用身份并撤销共享') +
    (p.installations.length ? form(csrf, { action: 'profile.bind_installation', profileId: profile.id, installationId: p.installations[0]!.id, allowedCommands: [...commands] }, '绑定所选助手', `<label>助手 <select name="installationId">${p.installations.map(i => `<option value="${escape(i.id)}">${escape(i.displayName)} (${escape(i.id)})</option>`).join('')}</select></label><p>允许准备草稿、提交服务资料和代表关系申请、请求批准、发布已批准内容和撤回自己的内容。助手不能批准或审核。</p>`) : '<p>请先登记一个助手。</p>') +
    p.bindings.filter(b => b.profileId === profile.id && !b.revoked).map(b => form(csrf, { action: 'profile.revoke_binding', bindingId: b.id, expectedRevision: b.revision }, `停用绑定 ${b.installationId}`)).join('') + '</section>').join('');
  const reviews = p.approvals.filter(r => r.status === 'pending').map(r => `<section><h2>待批准内容</h2>${r.replacementId ? `<p>此次操作将替换原发布 ${escape(r.replacementId)}（版本 ${escape(r.replacementRevision)}），旧版本将停止共享。</p>` : '<p>此次操作为新增发布。</p>'}<pre>${escape(JSON.stringify(r.content, null, 2))}</pre><p>接收者：${escape(r.recipientMemberIds.map(id => (p.recipients.find(m => m.id === id)?.displayName ?? '当前不可用的成员') + ' (' + id + ')' ).join('、'))}</p><p>发布截止：${escape(r.publishBefore)}；可见截止：${escape(r.visibleUntil)}</p><p>仅批准此内容版本和这些接收者，之后加入的成员不会获得访问权。</p>` + form(csrf, { action: 'publication.approve', approvalRequestId: r.id, expectedDraftRevision: r.draftRevision, reviewDigest: r.reviewDigest }, '批准这一次发布') + '</section>').join('');
  const grants = p.grants.filter(g => g.status !== 'revoked').map(g => `<section><p>许可 ${escape(g.id)} · ${escape(g.status)}</p>` + form(csrf, { action: 'publication.revoke', grantId: g.id, expectedRevision: g.revision }, '撤销许可并停止共享') + '</section>').join('');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>EIGOS · 身份与发布权限</title><style>body{font:16px system-ui;max-width:850px;margin:40px auto;padding:0 20px;color:#181818}section{border-top:1px solid #ddd;padding:20px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f5f5;padding:16px}button,input,select{font:inherit;padding:8px;margin:6px 0}button{cursor:pointer}form{margin:10px 0}p{line-height:1.6}</style><h1>身份与发布权限</h1><p>此处管理封闭试点的身份和单次发布许可，不批准下单或付款。批准只能使用本人的登录会话。</p><a href="/members">返回会员资料</a>${form(csrf, { action: 'profile.create', displayName: '' }, '创建身份', '<label>显示名称 <input name="displayName" maxlength="80" required></label>')}${profiles}<h2>发布审核</h2>${reviews || '<p>没有待审核内容。</p>'}<h2>有效或已使用许可</h2>${grants || '<p>没有许可。</p>'}${directoryControls(service, memberId, csrf)}</html>`;
}

export function mountNetworkRoutes(app: Express, config: Config, members: MemberStore, service: NetworkService | undefined, authenticate: RequestHandler, principal: (req: Request) => Principal) {
  const enabled: RequestHandler = (_req, res, next) => { if (!service) { res.status(403).json({ version: 1, error: { code: 'NETWORK_DISABLED' } }); return; } next(); };
  for (const [path, method] of [['commands', 'command'], ['query', 'query'], ['receipts/get', 'receipt']] as const) app.post('/network/v1/' + path, enabled, authenticate, (req, res) => {
    try {
      if (Buffer.byteLength(JSON.stringify(req.body)) > 32768) throw new NetworkError('INVALID_INPUT', 422);
      const token = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '';
      res.json(service![method](principal(req), token, req.body));
    } catch (error) { const failure = networkFailure(error); res.status(failure.status).json(failure.body); }
  });
  const cookieName = new URL(config.PUBLIC_URL).protocol === 'https:' ? '__Host-eigos-member' : 'eigos-member';
  const session = (req: Request) => {
    const pair = (req.headers.cookie ?? '').split(';').map(p => p.trim().split('=')).find(p => p[0] === cookieName);
    return members.session(pair?.[1] ?? '');
  };
  app.get('/members/network', enabled, (req, res) => {
    const s = session(req); if (!s) { res.status(401).json({ error: 'MEMBER_SESSION_REQUIRED' }); return; }
    try { res.set('Referrer-Policy', 'same-origin').type('html').send(networkPage(service!, s.member.id, s.csrf)); }
    catch (error) { const failure = networkFailure(error); res.status(failure.status).json(failure.body); }
  });
  app.get('/members/network/spaces/:spaceId', enabled, (req, res) => {
    const s = session(req); if (!s) { res.status(401).json({ error: 'MEMBER_SESSION_REQUIRED' }); return; }
    try {
      const spaceId = z.uuid().parse(req.params.spaceId);
      const query = z.object({ kind: z.enum(['profile', 'listing']).default('profile'), q: z.string().max(100).optional(), cursor: z.string().max(2048).optional() }).strict().parse(req.query);
      res.type('html').send(directoryBrowserPage(service!, s.member.id, spaceId, query.kind, { search: query.q, cursor: query.cursor }));
    } catch (error) { const f = networkFailure(error); res.status(f.status).json(f.body); }
  });
  for (const kind of ['profiles', 'listings'] as const) app.get(`/members/network/spaces/:spaceId/${kind}/:id`, enabled, (req, res) => {
    const s = session(req); if (!s) { res.status(401).json({ error: 'MEMBER_SESSION_REQUIRED' }); return; }
    try { res.type('html').send(directoryDetailPage(service!, s.member.id, z.uuid().parse(req.params.spaceId), kind === 'profiles' ? 'profile' : 'listing', z.uuid().parse(req.params.id))); }
    catch (error) { const f = networkFailure(error); res.status(f.status).json(f.body); }
  });
  app.post('/members/network/commands', enabled, (req, res) => {
    const s = session(req); if (!s) { res.status(401).json({ error: 'MEMBER_SESSION_REQUIRED' }); return; }
    const supplied = Buffer.from(typeof req.body?._csrf === 'string' ? req.body._csrf : ''), expected = Buffer.from(s.csrf);
    if (req.headers.origin !== config.PUBLIC_URL || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.status(403).json({ error: 'INVALID_CSRF' }); return; }
    try {
      let input: unknown;
      if (req.is('application/x-www-form-urlencoded')) {
        const body = z.object({ _csrf: z.string(), payload: z.string().max(8192), displayName: z.string().optional(), installationId: z.uuid().optional(), name: z.string().optional(), memberId: z.uuid().optional(), proofRef: z.string().optional(), validUntil: z.string().optional(), bindingId: z.string().optional(), bindingVersion: z.string().optional() }).strict().parse(req.body);
        input = JSON.parse(body.payload);
        if (body.displayName !== undefined) input = { ...(input as object), displayName: body.displayName };
        if (body.installationId !== undefined) input = { ...(input as object), installationId: body.installationId };
        for (const field of ['name', 'memberId', 'proofRef', 'validUntil'] as const) if (body[field] !== undefined) input = { ...(input as object), [field]: body[field] };
        if (body.bindingId || body.bindingVersion) input = { ...(input as object), bindingRef: { id: body.bindingId, version: body.bindingVersion } };
      } else { const { _csrf: _csrf, ...command } = req.body; input = command; }
      const result = service!.control(s.member.id, input);
      if (req.is('application/json')) res.json(result); else res.redirect(303, '/members/network');
    } catch (error) { const failure = networkFailure(error instanceof SyntaxError ? new NetworkError('INVALID_INPUT', 422) : error); res.status(failure.status).json(failure.body); }
  });
}
