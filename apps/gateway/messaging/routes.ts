import type { Express, Request } from 'express';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../../../packages/core/config.js';
import type { MemberStore, Member } from '../../../packages/members/store.js';
import type { AgentMessagingService } from '../../../packages/agent-messaging/service.js';
import { communicationGrantInputSchema, MessagingError, type CommunicationGrantInput } from '../../../packages/agent-messaging/contracts.js';

const escape = (value: unknown) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const hidden = (name: string, value: string) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`;
const time = (value: number, member: Member) => new Intl.DateTimeFormat(member.locale, { timeZone: member.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const page = (body: string) => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>EIGOS · 个人 Agent 通信</title><main><h1>个人 Agent 通信</h1>${body}<p><a href="/members">返回会员中心</a></p></main></html>`;

export function mountMessagingMemberRoutes(app: Express, config: Config, members: MemberStore, messaging: AgentMessagingService) {
  const cookieName = new URL(config.PUBLIC_URL).protocol === 'https:' ? '__Host-eigos-member' : 'eigos-member';
  const reviews = new Map<string, { memberId: string; sessionHash: string; expiresAt: number; input: CommunicationGrantInput }>();
  function session(req: Request) {
    const cookies = Object.fromEntries((req.headers.cookie ?? '').split(';').map(v => v.trim().split('=')).filter(v => v.length === 2));
    const token = cookies[cookieName] ?? '', current = members.session(token);
    return current?.member.status === 'active' ? { ...current, sessionHash: hash(token) } : undefined;
  }
  app.get('/members/communications', (req, res) => {
    const current = session(req);
    if (!current) { res.status(401).type('html').send(page('<p>请先登录并开通会员。</p>')); return; }
    const grants = messaging.store.grants(current.member.id);
    const installations = members.agents.list(current.member.id).filter(i => !i.revoked && !grants.some(g => g.installationId === i.id && !g.revoked && g.expiresAt > Date.now()));
    const granted = grants.map(g => `<section><h2>${escape(g.displayName)}</h2><p>${g.revoked ? '已撤销' : g.expiresAt <= Date.now() ? '已到期' : '已授权'} · 有效至 ${escape(time(g.expiresAt, current.member))}</p><p>${g.visibility === 'members' ? '允许其他已开通通信的会员发现这个 Agent' : '不在会员目录公开；可分享准确名片'}</p><p>由 EIGOS 受托保管通信信箱和节点密钥，可以处理消息正文；Relay 只保存密文。该许可不授予服务、来源或付款权限。</p>${!g.revoked && g.expiresAt > Date.now() ? `<form method="post" action="/members/communications/revoke">${hidden('_csrf', current.csrf)}${hidden('id', g.id)}${hidden('revision', String(g.revision))}<button type="submit">撤销这项通信许可</button></form>` : ''}</section>`).join('');
    const form = installations.length ? `<form method="post" action="/members/communications/review">${hidden('_csrf', current.csrf)}<label>代表我的 Agent <select name="installationId">${installations.map(i => `<option value="${escape(i.id)}">${escape(i.displayName)}</option>`).join('')}</select></label><p><label>通信显示名称 <input name="displayName" maxlength="80" value="${escape(current.member.displayName)}" required></label></p><p><label><input type="checkbox" name="scopes" value="messaging:read" checked>读取本人信箱与获准发现的 Agent</label><br><label><input type="checkbox" name="scopes" value="messaging:write" checked>发送、回复并管理本人联系</label></p><p><label>可发现范围 <select name="visibility"><option value="private">仅分享准确名片</option><option value="members">其他已开通通信的会员</option></select></label></p><p><label>有效期 <select name="durationHours"><option value="24">24 小时</option><option value="72">3 天</option><option value="168">7 天</option></select></label></p><p><label><input type="checkbox" name="custodyConsent" value="true" required>我同意由 EIGOS 受托处理这些通信消息，并保管本次通信信箱的密钥。我的 PA 原有凭据和来源权限保持由其自身管理。</label></p><button type="submit">查看本次许可</button></form>` : '<p>可用安装均已有通信许可，或尚未登记 Agent。</p>';
    res.set('Referrer-Policy', 'same-origin').type('html').send(page(`<p>个人 Agent 之间通过 Relay 沟通；需要服务时再明确委托 EIGOS 服务 Agent。手机无需安装常驻程序。未读消息按返回期限保存，当前最长 24 小时。</p>${granted}<h2>允许我的 Agent 通信</h2>${form}`));
  });
  for (const action of ['review', 'approve', 'revoke'] as const) app.post(`/members/communications/${action}`, async (req, res) => {
    const current = session(req);
    const supplied = Buffer.from(typeof req.body?._csrf === 'string' ? req.body._csrf : ''), expected = Buffer.from(current?.csrf ?? '');
    if (!current || req.headers.origin !== config.PUBLIC_URL || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.status(403).send('需要本人的有效登录及同源确认。'); return; }
    for (const [id, review] of reviews) if (review.expiresAt <= Date.now()) reviews.delete(id);
    try {
      if (action === 'review') {
        const input = communicationGrantInputSchema.parse({ installationId: req.body.installationId, displayName: req.body.displayName,
          scopes: Array.isArray(req.body.scopes) ? req.body.scopes : req.body.scopes ? [req.body.scopes] : [], visibility: req.body.visibility,
          expiresAt: req.body.expiresAt ?? new Date(Date.now() + z.coerce.number().int().min(1).max(168).parse(req.body.durationHours) * 3600000).toISOString(), custodyConsent: req.body.custodyConsent === 'true' || req.body.custodyConsent === true });
        const facts = members.authorizationFacts(current.member.id, input.installationId);
        if (!facts.active || messaging.store.installation(input.installationId)) throw new MessagingError('CONFLICT', 409);
        if (reviews.size >= 1000) throw new MessagingError('QUOTA_EXCEEDED', 429);
        const id = randomUUID();
        reviews.set(id, { memberId: current.member.id, sessionHash: current.sessionHash, expiresAt: Date.now() + 300000, input });
        res.set('Referrer-Policy', 'same-origin').type('html').send(page(`<h2>确认通信许可</h2><p>${escape(input.displayName)} 可以${input.scopes.includes('messaging:read') ? '读取本人信箱' : ''}${input.scopes.includes('messaging:write') ? '、发送和回复消息' : ''}，有效至 ${escape(time(Date.parse(input.expiresAt), current.member))}。</p><p>${input.visibility === 'members' ? '其他已开通通信的会员可以发现其通信名片。' : '不向会员目录公开其通信名片。'}</p><p>EIGOS 将作为受托通信端处理正文并保管本次信箱密钥。此许可不代表批准任何服务任务、来源访问或付款。本人可随时撤销。</p><form method="post" action="/members/communications/approve">${hidden('_csrf', current.csrf)}${hidden('reviewId', id)}<button type="submit" name="confirm" value="approve">确认以上通信范围</button></form>`));
        return;
      }
      if (action === 'revoke') {
        messaging.revoke(current.member.id, z.uuid().parse(req.body.id), z.coerce.number().int().positive().parse(req.body.revision));
      } else {
        const id = z.uuid().parse(req.body.reviewId), review = reviews.get(id);
        if (!review || review.memberId !== current.member.id || review.sessionHash !== current.sessionHash || review.expiresAt <= Date.now() || req.body.confirm !== 'approve')
          throw new MessagingError('MESSAGING_AUTHORIZATION_REQUIRED');
        reviews.delete(id);
        const grant = messaging.approve(current.member.id, review.input);
        // Approval is durable even if the transport is temporarily offline. A later authenticated call resumes preparation.
        try { await messaging.prepareEndpoint(grant.id); } catch { /* Do not turn transport unavailability into broader authorization. */ }
      }
      res.redirect(303, '/members/communications');
    } catch (error) {
      const status = error instanceof MessagingError ? error.status : error instanceof z.ZodError ? 400 : 403;
      res.status(status).type('html').send(page('<p>许可或安装状态已变化，请返回重新查看。</p>'));
    }
  });
}
