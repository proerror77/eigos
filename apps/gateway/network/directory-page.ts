import { needCard } from './collaboration-page.js';
import { NetworkService, type NetworkQueryResult } from '../../../packages/network/service.js';
import type { Content } from '../../../packages/network/contracts.js';
import { escape, form, directoryShell } from './html.js';

const spaceUrl = (id: string) => '/members/network/spaces/' + encodeURIComponent(id);
const roleNames: Record<string, string> = { seller: '销售方', fulfiller: '履约方', aggregator: '聚合渠道', booking_agent: '预订代理' };
const modeNames: Record<string, string> = { introduction_only: '仅介绍 · 尚未接入', read_candidate: '可进入只读询价核验', sandbox_only: '仅沙箱', unavailable: '当前账号暂不可调用' };
function card(input: unknown, spaceId: string): string {
  const v = input as { profileId: string; content: Content; capabilityState?: { mode: string; representation: string; availableNow: string; candidateEligible: boolean } };
  const c = v.content;
  if (c.kind === 'need') return needCard(input as NetworkQueryResult, spaceId);
  if (c.kind === 'profile') return `<article><h2><a href="${spaceUrl(spaceId)}/profiles/${escape(v.profileId)}">${escape(c.body.displayName)}</a></h2><p>${escape(c.body.summary)}</p><small>自述角色：${escape(c.body.roleTags.join('、')) || '未填写'}。角色标签不代表已核实能力。</small></article>`;
  if (c.kind === 'listing') return `<article><h2><a href="${spaceUrl(spaceId)}/listings/${escape(c.listingId)}">${escape(c.body.title)}</a></h2><p>${escape(c.body.description)}</p><p><span class="tag">代表关系已核实</span><span class="tag">${escape(modeNames[v.capabilityState?.mode ?? 'unavailable'])}</span></p><p>提供主体：${escape(c.body.providerId)} · 角色：${escape(roleNames[c.body.role])}</p><details><summary>查看登记范围</summary><p>服务区域编码：${escape(c.body.coarseAreas.join('、'))}；服务标识：${escape(c.body.capabilityRef.id)}</p></details><small>本次报价、容量与履约可用性仍需核验。此页面不会下单或付款。</small></article>`;
  return '';
}
export function directoryBrowserPage(service: NetworkService, memberId: string, spaceId: string, kind: 'profile' | 'listing' | 'need', query: { search?: string; cursor?: string } = {}) {
  const result = service.directoryQuery(memberId, { version: 1, kind: 'search', objectKind: kind, spaceId, ...query });
  const spaces = service.directory.spaces(memberId), title = spaces.find(s => s.id === spaceId)?.name ?? '协作圈';
  const params = new URLSearchParams({ kind, ...(query.search !== undefined ? { q: query.search } : {}) });
  const next = result.page?.cursor ? `<a href="${spaceUrl(spaceId)}?${escape(params.toString())}&cursor=${encodeURIComponent(result.page.cursor)}">继续查看</a>` : '';
  return directoryShell(title, `<nav><a href="${spaceUrl(spaceId)}?kind=profile">Agent 主页</a><a href="${spaceUrl(spaceId)}?kind=listing">服务目录</a><a href="${spaceUrl(spaceId)}?kind=need">需求协作</a></nav><form method="get"><input type="hidden" name="kind" value="${kind}"><label>搜索可见内容 <input name="q" maxlength="100" value="${escape(query.search ?? '')}"></label><button>搜索</button></form>${result.items?.map(v => card(v, spaceId)).join('') || '<p>这一页没有可见结果。</p>'}${next}`);
}
export function directoryDetailPage(service: NetworkService, memberId: string, spaceId: string, kind: 'profile' | 'listing', id: string) {
  const result: NetworkQueryResult = service.directoryQuery(memberId, { version: 1, kind, spaceId, ...(kind === 'profile' ? { profileId: id } : { listingId: id }) });
  return directoryShell(kind === 'profile' ? 'Agent 主页' : '服务详情', `<a href="${spaceUrl(spaceId)}?kind=${kind}">返回目录</a>${card(result, spaceId)}${kind === 'profile' ? '<h2>对你可见的服务</h2>' + (result.services?.map(v => card(v, spaceId)).join('') || '<p>暂无已发布且对你可见的服务。</p>') : ''}${result.hasMoreServices ? `<a href="${spaceUrl(spaceId)}?kind=listing">查看更多服务</a>` : ''}`);
}
export function directoryControls(service: NetworkService, memberId: string, csrf: string): string {
  const p = service.panel(memberId), now = service.store.now();
  const expires = new Date(now + 86400000).toISOString(), verifyUntil = new Date(now + 604800000).toISOString();
  const spaces = p.spaces.map(s => `<section><h3><a href="${spaceUrl(s.id)}?kind=profile">${escape(s.name)}</a></h3><p>角色：${escape(s.role)}</p>` +
    (s.role === 'moderator' || p.operator ? form(csrf, { action: 'space.invite', spaceId: s.id, memberId: '', expiresAt: expires }, '邀请成员', '<label>已准入会员的 ID <input name="memberId" required></label>') : '') + '</section>').join('');
  const memberships = p.spaceMembers.map(({ space, memberships }) => `<section><h3>${escape(space.name)} · ${space.state === 'archived' ? '已归档' : '成员'}</h3>` + form(csrf, { action: 'space.set_state', spaceId: space.id, expectedRevision: space.revision, state: space.state === 'active' ? 'archived' : 'active' }, space.state === 'active' ? '归档此圈并停止共享' : '重新开放（不恢复旧发布许可）') + memberships.map(m => `<p>${escape(p.recipients.find(r => r.id === m.memberId)?.displayName ?? m.memberId)} · ${escape(m.role)} · ${escape(m.state)}</p>` + (m.state === 'active' ? form(csrf, { action: 'space.set_member', spaceId: space.id, memberId: m.memberId, expectedRevision: m.revision, state: 'removed', role: m.role }, '移出此圈') : '') + (p.operator && m.state === 'active' ? form(csrf, { action: 'space.set_member', spaceId: space.id, memberId: m.memberId, expectedRevision: m.revision, state: 'active', role: m.role === 'member' ? 'moderator' : 'member' }, m.role === 'member' ? '指定为圈管理员' : '改为普通成员') : '')).join('') + '</section>').join('');
  const invites = p.invitations.map(i => `<section><p>邀请加入 ${escape(service.store.get('space', i.spaceId).name)}，截止 ${escape(i.expiresAt)}</p>` + form(csrf, { action: 'space.accept_invitation', invitationId: i.id, expectedRevision: i.revision }, '接受邀请') + '</section>').join('');
  const reps = p.representations.map(r => `<section><h3>代表关系 · ${escape(r.providerId)}</h3><p>声明角色：${escape(r.role)}；状态：${escape(r.state)}</p><p>${escape(r.note)}</p>` + (p.operator && r.memberId !== memberId ? form(csrf, { action: 'representation.review', representationId: r.id, expectedRevision: r.revision, decision: 'verified', proofRef: '', validUntil: verifyUntil }, '核实此范围的代表关系', '<label>核验记录引用（不公开）<input name="proofRef" required maxlength="200"></label><label>有效至（含时区）<input name="validUntil" value="' + verifyUntil + '" required></label>') + form(csrf, { action: 'representation.review', representationId: r.id, expectedRevision: r.revision, decision: r.state === 'verified' ? 'revoked' : 'rejected', proofRef: 'operator-rejection', validUntil: verifyUntil }, r.state === 'verified' ? '撤销核实状态' : '拒绝申请') : '') + '</section>').join('');
  const listings = p.listings.map(l => `<section><h3>${escape(l.details.title)}</h3><p>${escape(l.details.description)}</p><p>主体 ${escape(l.providerId)} · 能力 ${escape(l.capabilityRef.id)}@${escape(l.capabilityRef.version)} · ${escape(l.state)}</p>` + (p.operator && l.state === 'review' && l.memberId !== memberId ? form(csrf, { action: 'listing.review', listingId: l.id, expectedRevision: l.revision, decision: 'approved' }, '审核通过（留空则仅介绍）', '<label>受控绑定 ID（可选）<input name="bindingId"></label><label>绑定版本（可选）<input name="bindingVersion"></label>') + form(csrf, { action: 'listing.review', listingId: l.id, expectedRevision: l.revision, decision: 'rejected' }, '退回修改') : '') + '</section>').join('');
  return `<h2>邀请圈</h2>${p.operator ? form(csrf, { action: 'space.create', name: '' }, '创建邀请圈', '<label>圈名称 <input name="name" maxlength="100" required></label>') : ''}${spaces || '<p>暂无已加入的圈。</p>'}${invites}${memberships}<h2>代表关系与服务审核</h2><p>助手可提交本人代表关系申请和服务资料。审核通过后，仍需控制者批准准确的发布内容与受众。未提供可用绑定的服务只作介绍。</p>${reps}${listings}`;
}
