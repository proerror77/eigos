import { NetworkError } from '../../../packages/network/contracts.js';
import type { NetworkService } from '../../../packages/network/service.js';
import { directoryShell, escape } from './html.js';

export function activityPage(service: NetworkService, memberId: string, spaceId: string, cursor?: string) {
  const root = '/members/network/spaces/' + encodeURIComponent(spaceId), url = root + '/updates';
  try {
    const result = service.memberUpdates(memberId, { version: 1, spaceId, ...(cursor ? { cursor } : {}) });
    const cards = result.items.map(item => {
      const v = item.publication, c = v.content!;
      const title = c.kind === 'profile' ? c.body.displayName : c.kind === 'message' ? '协作回应' : c.kind === 'evidence_card' ? '查询与验收摘要' : c.body.title;
      const text = c.kind === 'profile' ? c.body.summary : c.kind === 'listing' ? c.body.description : c.kind === 'need' ? c.body.safeGoal : c.kind === 'evidence_card' ? c.body.safeSummary : c.body.safeText;
      const target = c.kind === 'profile' ? `${root}/profiles/${encodeURIComponent(v.profileId!)}` : c.kind === 'listing' ? `${root}/listings/${encodeURIComponent(c.listingId)}`
        : c.kind === 'evidence_card' ? `${root}/evidence/${encodeURIComponent(c.cardId)}` : `${root}/needs/${encodeURIComponent(c.kind === 'need' ? v.need!.id : c.body.postId)}`;
      return `<article><small>${item.kind === 'need_closed' ? '需求已关闭回应' : '获准发布'} · ${escape(item.committedAt)}</small><h2><a href="${target}">${escape(title)}</a></h2><p>${escape(text)}</p></article>`;
    }).join('');
    const next = result.page.cursor ?? result.page.checkpoint!;
    return directoryShell('圈内动态', `<a href="${root}">返回协作圈</a><p>仅显示当前获准阅读的动态。查看不会启动助手、发送通知或发起交易。</p>${cards || '<p>这一页没有可见动态。</p>'}<a href="${url}?cursor=${encodeURIComponent(next)}">${result.page.hasMore ? '继续读取这一批' : '检查新的动态'}</a> · <a href="${url}">重新加载当前动态</a>`);
  } catch (error) {
    if (error instanceof NetworkError && error.code === 'CURSOR_STALE') return directoryShell('重新同步动态', `<p>访问条件、关注范围或有效期已变化，请重新读取当前允许查看的动态。</p><a href="${url}">重新加载</a>`);
    throw error;
  }
}
