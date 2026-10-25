import express, { type Express, type Request, type Response } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../../../packages/core/config.js';
import { DomainError } from '../../../packages/core/domain.js';
import { MemberStore } from '../../../packages/members/store.js';
import { createLoginProvider, type LoginAttempt } from './oidc.js';
import { memberPage } from './page.js';
import type { AuthorizationCoordinator } from '../../../packages/security/coordinator.js';
import { SecurityError } from '../../../packages/security/store.js';
import {permissionsPage,permissionReviewPage,preparePermissionReview,type PermissionReview} from './permissions-page.js';

function cookies(req: Request): Record<string, string> {
  return Object.fromEntries((req.headers.cookie ?? '').split(';').map(part => part.trim().split('=')).filter(part => part.length === 2));
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const notices: Record<string, string> = {
  login_failed: '登录未完成或已过期，请重新登录。', login_unavailable: '登录服务暂时不可用，请稍后重试。',
  saved: '会员资料已保存。', applied: '会员申请已保存。', revoked: '已停用这个助手的连接。', restored: '已恢复这个助手的连接。',
};

export function mountMemberRoutes(app: Express, c: Config, store: MemberStore, provider = createLoginProvider(c), security?: AuthorizationCoordinator): void {
  const secure = new URL(c.PUBLIC_URL).protocol === 'https:';
  const sessionCookie = secure ? '__Host-eigos-member' : 'eigos-member';
  const loginCookie = secure ? '__Host-eigos-login' : 'eigos-login';
  const cookieOptions = { httpOnly: true, secure, sameSite: 'lax' as const, path: '/' };
  const flows = new Map<string, LoginAttempt & { expiresAt: number }>();
  const reviews=new Map<string,{memberId:string;sessionHash:string;expiresAt:number;review:PermissionReview}>();
  const session = (req: Request) => store.session(cookies(req)[sessionCookie] ?? '');
  const sameOrigin = (req: Request) => req.headers.origin === c.PUBLIC_URL;
  const redirect = (res: Response, notice?: string) => res.redirect(303, `/members${notice ? `?notice=${notice}` : ''}`);
  app.use('/members', express.urlencoded({ extended: false, limit: '64kb' }), (_req, res, next) => {
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  app.get('/members', (req, res) => {
    const current = session(req);
    const notice = (typeof req.query.notice === 'string' ? notices[req.query.notice] : undefined)
      ?? (security ? '助手只能在已批准的任务、数据、来源和交付范围内工作。' : undefined);
    // Native form navigations under no-referrer send Origin: null. Preserve
    // the same-origin POST header; login/callback redirects keep no-referrer.
    res.set('Referrer-Policy', 'same-origin').type('html').send(memberPage({
      ...(current ? { member: current.member, csrf: current.csrf, connections: store.connections(current.member.id) } : {}),
      agentRegistrations: current ? store.agents.list(current.member.id) : [], invitationOnly: c.EIGOS_MEMBERSHIP_APPROVAL === 'invite-only',
      permissionsAvailable: !!security, networkAccess: !security && c.EIGOS_NETWORK_ENABLED === 'true' && !!current && c.EIGOS_NETWORK_MEMBER_IDS.includes(current.member.id), loginAvailable: !!provider, manualApproval: c.EIGOS_MEMBERSHIP_APPROVAL !== 'self-service', ...(notice ? { notice } : {}),
    }));
  });
  app.get('/members/permissions',(req,res)=>{
    if(!security){res.status(404).send('Permission management is not enabled');return;}
    const current=session(req);if(!current){res.redirect(303,'/members');return;}
    res.set('Referrer-Policy','same-origin').type('html').send(permissionsPage(security.managementView(current.member.id),current.member,current.csrf,req.query.notice==='applied'?'授权已更新。当前范围已重新读回。':undefined));
  });
  app.get('/members/security/grants', (req, res) => {
    if (!security) { res.status(404).json({ error: 'security_foundation_not_enabled' }); return; }
    const current = session(req);
    if (!current) { res.status(401).json({ error: 'member_login_required' }); return; }
    res.json({ stage: 'S4', grants: security.grants(current.member.id), businessAccess: 'task_grant_required' });
  });
  app.get('/members/security/sources',(req,res)=>{
    if(!security){res.status(404).json({error:'security_foundation_not_enabled'});return;}
    const current=session(req);if(!current){res.status(401).json({error:'member_login_required'});return;}
    res.json(security.sourceProfiles(current.member.id));
  });
  app.get('/members/security/recoveries',(req,res)=>{
    if(!security){res.status(404).json({error:'security_foundation_not_enabled'});return;}
    const current=session(req);if(!current){res.status(401).json({error:'member_login_required'});return;}
    res.json({recoveries:security.recoveries(current.member.id)});
  });
  app.get('/members/security/tasks/:taskId/recovery-preview',(req,res)=>{
    if(!security){res.status(404).json({error:'security_foundation_not_enabled'});return;}
    const current=session(req);if(!current){res.status(401).json({error:'member_login_required'});return;}
    if(!z.uuid().safeParse(req.params.taskId).success){res.status(400).json({error:'invalid_task'});return;}
    res.json({operations:security.recoveryPreview(current.member.id,String(req.params.taskId))});
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
  app.post(['/members/apply', '/members/profile', '/members/logout', '/members/invitation', '/members/agents/:id/revoke', '/members/connections/:id/:action', '/members/security/grants', '/members/security/grants/:id/revoke','/members/security/sources','/members/security/sources/revoke','/members/security/task-grants','/members/security/recoveries','/members/permissions/review','/members/permissions/approve'], (req, res, next) => {
    const current = session(req);
    if (!current) { res.status(401).json({ error: 'member_login_required' }); return; }
    const supplied = Buffer.from(typeof req.body?._csrf === 'string' ? req.body._csrf : '');
    const expected = Buffer.from(current.csrf);
    if (!sameOrigin(req) || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.status(403).json({ error: 'invalid_csrf' }); return;
    }
    try {
      const { _csrf, ...body } = req.body;
      if(req.path.startsWith('/members/permissions/')) {
        if(!security){res.status(404).json({error:'security_foundation_not_enabled'});return;}
        for(const [id,review] of reviews)if(review.expiresAt<=Date.now())reviews.delete(id);
        if(req.path==='/members/permissions/review') {
          if(reviews.size>=500){res.status(429).json({error:'review_busy'});return;}
          const view=security.managementView(current.member.id);let review:PermissionReview;
          try{review=preparePermissionReview(view,body);}catch{res.status(400).set('Referrer-Policy','same-origin').type('html').send(permissionsPage(view,current.member,current.csrf,'请选择有效的助手、字段、来源与期限，再查看授权范围。'));return;}
          const id=randomBytes(24).toString('base64url');
          reviews.set(id,{memberId:current.member.id,sessionHash:hash(cookies(req)[sessionCookie]??''),expiresAt:Date.now()+300000,review});
          res.set('Referrer-Policy','same-origin').type('html').send(permissionReviewPage(review,view,current.member,current.csrf,id));return;
        }
        const args=z.strictObject({reviewId:z.string().regex(/^[A-Za-z0-9_-]{32}$/),confirm:z.literal('approve')}).parse(body),draft=reviews.get(args.reviewId);
        if(!draft || draft.memberId!==current.member.id || draft.sessionHash!==hash(cookies(req)[sessionCookie]??''))throw new DomainError('CONFLICT','Review expired or belongs to another session');
        reviews.delete(args.reviewId);
        security.store.atomic(()=>{
          if(draft.review.policyRevision!==security.store.policies.revision())throw new DomainError('CONFLICT','Permissions changed; review the current scope again');
          const review=draft.review;
          if(review.kind==='agent')security.approveAgentGrant(current.member.id,review.input);
          else if(review.kind==='source')security.approveSource(current.member.id,review.input);
          else if(review.kind==='task')security.approveTaskGrant(current.member.id,review.input);
          else if(review.kind==='recovery')security.approveRecovery(current.member.id,review.input);
          else if(review.kind==='revoke_source')security.revokeSource(current.member.id,review.input);
          else security.revokeGrant(current.member.id,String(review.input.grantId),Number(review.input.expectedRevision));
        });
        res.redirect(303,'/members/permissions?notice=applied');return;
      }
      if (req.path.startsWith('/members/security/')) {
        if (!security) { res.status(404).json({ error: 'security_foundation_not_enabled' }); return; }
        if(req.path==='/members/security/sources') security.approveSource(current.member.id,body);
        else if(req.path==='/members/security/sources/revoke') security.revokeSource(current.member.id,body);
        else if(req.path==='/members/security/task-grants') security.approveTaskGrant(current.member.id,body);
        else if(req.path==='/members/security/recoveries') {res.json({recovery:security.approveRecovery(current.member.id,body)});return;}
        else if (req.params.id) {
          const input = z.strictObject({ expectedRevision: z.number().int().positive() }).parse(body);
          security.revokeGrant(current.member.id, z.uuid().parse(req.params.id), input.expectedRevision);
        } else security.approveAgentGrant(current.member.id, body);
        res.json({ stage: 'S4', grants: security.grants(current.member.id), businessAccess: 'task_grant_required' }); return;
      }
      if (req.path === '/members/logout') {
        store.logout(cookies(req)[sessionCookie]!); res.clearCookie(sessionCookie, cookieOptions); redirect(res); return;
      }
      if (req.path === '/members/apply') {
        store.apply(current.member.id, { ...body, consent: body.consent === true || body.consent === 'true' }, c.EIGOS_MEMBERSHIP_APPROVAL !== 'self-service');
        redirect(res, 'applied'); return;
      }
      if (req.path === '/members/profile') { store.update(current.member.id, body); redirect(res, 'saved'); return; }
      if (req.path === '/members/invitation') { store.agents.redeemForMember(current.member.id, z.string().min(32).max(200).parse(body.invitationToken)); redirect(res, 'applied'); return; }
      if (req.path.startsWith('/members/agents/')) {
        const id = z.uuid().parse(req.params.id);
        if (security) security.revokeInstallation(current.member.id, id); else store.agents.revoke(current.member.id, id);
        redirect(res, 'revoked'); return;
      }
      const action = z.enum(['revoke', 'restore']).parse(req.params.action);
      if (security) security.setConnectionBlocked(current.member.id, z.uuid().parse(req.params.id), action === 'revoke');
      else store.block(current.member.id, z.uuid().parse(req.params.id), action === 'revoke');
      redirect(res, action === 'revoke' ? 'revoked' : 'restored');
    } catch (error) {
      if (error instanceof SecurityError) { res.status(error.reason === 'REVOCATION_PENDING' || error.reason === 'AUTHORITY_UNAVAILABLE' ? 503 : 403).json({ error: error.reason }); return; }
      if (error instanceof z.ZodError) {
        if (req.path.startsWith('/members/security/') || req.path.startsWith('/members/permissions/')) { res.status(400).json({ error: 'invalid_security_input' }); return; }
        const message = '请检查名称、语言和时区；开通会员时需勾选同意。';
        if (req.is('application/json')) res.status(400).json({ error: 'invalid_member_input', message });
        else res.status(400).set('Referrer-Policy', 'same-origin').type('html').send(memberPage({ member: current.member, csrf: current.csrf, connections: store.connections(current.member.id), agentRegistrations: store.agents.list(current.member.id), invitationOnly: c.EIGOS_MEMBERSHIP_APPROVAL === 'invite-only', permissionsAvailable: !!security, networkAccess: !security && c.EIGOS_NETWORK_ENABLED === 'true' && !!current && c.EIGOS_NETWORK_MEMBER_IDS.includes(current.member.id), loginAvailable: !!provider, manualApproval: c.EIGOS_MEMBERSHIP_APPROVAL !== 'self-service', notice: message }));
        return;
      }
      if (error instanceof DomainError) { res.status(error.code === 'NOT_FOUND' ? 404 : error.code === 'CONFLICT' ? 409 : error.code === 'INVALID_INPUT' ? 400 : 403).json({ error: error.code }); return; }
      next(error);
    }
  });
}
