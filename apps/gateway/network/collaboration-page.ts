import type { NetworkService, NetworkQueryResult } from '../../../packages/network/service.js';
import { fail } from '../../../packages/network/contracts.js';
import { directoryShell, escape } from './html.js';

const states: Record<string, string> = { open: '接受回应', closed: '已关闭回应', expired: '已到期', withdrawn: '已撤回' };
const kinds: Record<string, string> = { response: '结构化回应', question: '澄清问题', answer: '需求方回答', discussion: '讨论', referral: '一跳推荐', offer_reference: '服务引用' };
const root = (spaceId: string) => '/members/network/spaces/' + encodeURIComponent(spaceId);
export function needCard(v: NetworkQueryResult, spaceId: string) {
  if (v.content?.kind !== 'need' || !v.need) return '';
  const b = v.content.body;
  return `<article><h2><a href="${root(spaceId)}/needs/${escape(v.need.id)}">${escape(b.title)}</a></h2><span class="tag">${escape(states[v.need.state])}</span><p>${escape(b.safeGoal)}</p><p>区域：${escape(b.coarseArea)} · 类型：${escape(b.category)}</p><p>回应截止：${escape(b.replyDeadline)}</p>${b.timeWindow ? `<p>时间范围：${escape(b.timeWindow.start)} — ${escape(b.timeWindow.end)}</p>` : ''}${b.quantity ? `<p>数量：${escape(b.quantity)}</p>` : ''}<small>这里只显示已批准的协作摘要。回应和推荐不构成购买授权或履约承诺。</small></article>`;
}
export function collaborationPage(service: NetworkService, memberId: string, spaceId: string, postId: string, cursor?: string) {
  const need = service.directoryQuery(memberId, { version: 1, kind: 'need', postId });
  if (need.spaceId !== spaceId) return fail('NOT_FOUND', 404);
  const messages = service.directoryQuery(memberId, { version: 1, kind: 'messages', postId, ...(cursor ? { cursor } : {}) });
  const cards = (messages.items as NetworkQueryResult[]).map(v => {
    if (v.content?.kind !== 'message') return '';
    const b = v.content.body;
    let listing = '';
    if (b.listingRef) {
      const target = service.directoryQuery(memberId, { version: 1, kind: 'get', publicationId: b.listingRef.publicationId });
      if (target.content?.kind === 'listing') listing = `<p><a href="${root(spaceId)}/listings/${escape(target.content.listingId)}">查看获准的服务介绍</a></p>`;
    }
    return `<article><span class="tag">${escape(kinds[b.kind])}</span><p>${escape(b.safeText)}</p>${listing}<small>回应需求版本 ${escape(b.responseToPostRevision)}。${b.kind === 'referral' ? '仅提供一跳线索，不邀请新成员，也不调用服务。' : '正文属于参与者陈述，不改变你的私有要求或执行权限。'}</small></article>`;
  }).join('');
  const next = messages.page?.cursor ? `<a href="${root(spaceId)}/needs/${encodeURIComponent(postId)}?cursor=${encodeURIComponent(messages.page.cursor)}">继续查看回应</a>` : '';
  return directoryShell('需求与回应', `<a href="${root(spaceId)}?kind=need">返回需求列表</a>${needCard(need, spaceId)}<h2>对你可见的回应</h2>${cards || '<p>这一页没有可见回应。</p>'}${next}<p>新回应由已绑定助手准备草稿，经本人批准后发布。达到协作限额时需要人工接手。</p>`);
}
