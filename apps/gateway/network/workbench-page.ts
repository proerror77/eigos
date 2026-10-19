import { randomUUID } from 'node:crypto';
import type { NetworkService } from '../../../packages/network/service.js';
import type { JobState } from '../../../packages/core/domain.js';
import type { EvidenceBody } from '../../../packages/network/evidence-contracts.js';
import { directoryShell, escape } from './html.js';

const root = '/members/network';
export const taskNames: Record<JobState, string> = { submitted: '等待处理', working: '处理中', 'input-required': '等待补充信息', 'auth-required': '等待独立授权', completed: '任务处理完成', failed: '处理失败', canceled: '已取消', rejected: '已拒绝' };
export const evidenceNames: Record<EvidenceBody['evidenceLevel'], string> = {
  synthetic_validation: '合成验证', simulated_execution: '模拟执行', live_query: '真实查询', live_execution: '真实执行', live_fulfillment: '真实履约', local_generation: '本地生成', participant_statement: '参与者声明', insufficient_evidence: '证据不足',
};
const kindNames: Record<string, string> = { profile: 'Agent 主页', listing: '服务介绍', need: '需求', message: '回应', evidence_card: '查询与验收摘要' };
const inquiryNames: Record<string, string> = { report_ready: '报价报告已就绪', needs_input: '等待补充信息', unavailable: '当前不可用', quoting: '正在准备报价' };
const taskLink = (id: string) => `${root}/tasks/${encodeURIComponent(id)}`;
const inquiryLink = (id: string) => `${root}/inquiries/${encodeURIComponent(id)}`;
export function workbenchPage(service: NetworkService, memberId: string, offset = 0) {
  const p = service.workbench(memberId, offset);
  const tasks = p.tasks?.jobs.map(j => `<article><span class="tag">仅本人 · ${taskNames[j.state]}</span><h3><a href="${taskLink(j.id)}">${escape(j.goal)}</a></h3><small>更新于 ${escape(j.updatedAt)}</small></article>`).join('');
  const inquiries = p.inquiries.map(i => `<article><h3><a href="${inquiryLink(i.id)}">${escape(inquiryNames[i.state])}</a></h3><p>只读询价 · 业务执行尚未开始</p><p>${i.source.candidateEligible ? '来源仍可进入核验，当前可用性未知。' : '原来源已不可用，请让助手重新核验。'}</p></article>`).join('');
  const drafts = p.drafts.map(d => `<article><span class="tag">私有草稿</span><h3>${escape(kindNames[d.content.kind])} · 版本 ${d.revision}</h3><p>${escape(d.content.kind === 'profile' ? d.content.body.displayName : d.content.kind === 'message' ? d.content.body.safeText : d.content.kind === 'evidence_card' ? d.content.body.safeSummary : d.content.body.title)}</p><small>草稿与发布记录分别保存；草稿存在不代表已公开。</small></article>`).join('');
  const publications = p.publications.map(p => `<article><h3>${escape(kindNames[p.contentKind])}</h3><span class="tag">${p.visible ? '已发布 · 仅准确批准的圈内受众可见' : p.state === 'retracted' ? '已撤回' : '已失效或当前不可见'}</span><p>可见截止 ${escape(p.visibleUntil)}</p></article>`).join('');
  const evidence = p.evidence.map(c => `<article><span class="tag">私有预览 · ${escape(evidenceNames[c.body.evidenceLevel])}</span><p>${escape(c.body.safeSummary)}</p><p>${c.current ? '与当前来源一致；共享仍需单独批准。' : '来源已变化，此版本不能继续共享；请让助手刷新并重新请求批准。'}</p></article>`).join('');
  return directoryShell('我的工作台', `<p>私有任务和方案仅本人可见。圈内页面只展示准确批准的内容与受众。</p><nav aria-label="工作区"><a href="#tasks">任务</a><a href="#inquiries">需求与方案</a><a href="#drafts">草稿与发布</a><a href="${root}">身份与授权</a></nav><h2>我的邀请圈</h2>${p.spaces.map(s => `<p><a href="${root}/spaces/${escape(s.id)}">${escape(s.name)}</a> · 圈内可见内容</p>`).join('') || '<p>尚未加入邀请圈。</p>'}<h2 id="tasks">私有任务</h2>${tasks || '<p>这一页没有任务。</p>'}${offset ? `<a href="${root}/workbench?offset=${Math.max(0, offset - 20)}">上一页任务</a>` : ''}${p.tasks && offset + 20 < p.tasks.total ? `<a href="${root}/workbench?offset=${offset + 20}">下一页任务</a>` : ''}<h2 id="inquiries">需求与方案</h2>${inquiries || '<p>尚未确认转换为私有询价。由助手提出选择，在身份与授权页面确认后继续。</p>'}<h2 id="drafts">草稿与发布</h2>${drafts || '<p>没有私有草稿。</p>'}${publications || '<p>没有发布记录。</p>'}<h2>查询与验收摘要</h2>${evidence || '<p>没有准备中的摘要。</p>'}`);
}
export function inquiryPage(service: NetworkService, memberId: string, id: string) {
  const { inquiry: i, selections } = service.memberInquiry(memberId, id);
  const choices = selections.map(s => `<article><h3>${s.kind === 'proposal' ? '已确认的报价方案' : '已查看的报价'}</h3><span class="tag">${s.current ? '当前版本有效' : '已过期或来源、要求已变化'}</span><p>业务执行尚未开始。选择报价没有授予下单或付款权限。</p><p>证据等级：${escape((s.snapshot.evidenceLevels as string[] ?? []).map(x => evidenceNames[x as EvidenceBody['evidenceLevel']] ?? x).join('、')) || '未知'}</p><details><summary>查看本人选择的报价条件与未知项</summary><pre>${escape(JSON.stringify(s.snapshot.quoteTerms, null, 2))}</pre><pre>${escape(JSON.stringify(s.snapshot.checks, null, 2))}</pre></details></article>`).join('');
  return directoryShell('私有询价与方案', `<span class="tag">仅本人</span><p>${escape(inquiryNames[i.state])} · 仅查价，业务执行尚未开始。</p><p>${i.source.candidateEligible ? '原来源可进入核验；报价、容量和实际服务可用性仍须确认。' : '原来源当前不可用，历史记录保留；不能据此继续选择。'}</p><p><a href="${taskLink(i.taskId)}">继续查看原任务</a> · <a href="${root}">查看待确认选择</a></p>${choices || '<p>尚未选择报价。让绑定助手读取本任务的报价后提出准确选择，再由你确认。</p>'}`);
}
export function taskPage(service: NetworkService, memberId: string, id: string, csrf: string) {
  const j = service.memberTask(memberId, id);
  const d = j.delegation, summary = service.memberTaskSummary(memberId, id);
  const reply = j.state === 'input-required' ? `<form method="post" action="${taskLink(j.id)}/reply"><input type="hidden" name="_csrf" value="${escape(csrf)}"><input type="hidden" name="requestId" value="${randomUUID()}"><input type="hidden" name="expectedRevision" value="${j.revision}"><input type="hidden" name="expectedUpdatedAt" value="${escape(j.updatedAt)}"><label>回复原任务<textarea name="answer" required maxlength="500" rows="4"></textarea></label><button>提交补充信息</button><p>此回复只补充当前问题，不批准执行方案或真实交易。</p></form>` : '';
  return directoryShell('私有任务', `<span class="tag">仅本人 · ${taskNames[j.state]}</span><h2>${escape(j.goal)}</h2><p>任务编号 ${escape(j.id)}</p><p>最近更新 ${escape(j.updatedAt)}</p><p>任务处理完成不自动代表业务履约。查询、生成材料与实际执行的验收分别记录。</p>${d?.request.executionEnvironment === 'sandbox' ? '<p class="tag">沙箱环境 · 模拟执行</p>' : ''}${summary ? `<p class="tag">${escape(evidenceNames[summary.evidenceLevel])}</p><p>${escape(summary.safeSummary)}</p>` : '<p>业务证据等级尚未确定。</p>'}${j.question ? `<h2>待补充的问题</h2><p>${escape(j.question)}</p>` : ''}${reply}${j.state === 'auth-required' ? d?.sourceAuthorization ? '<p>请让你的 PA 连接你自己的美团账号，再继续本任务。凭据通过独立安全通道传递，请勿粘贴到任务消息中。连接账号仅用于查价。</p>' : '<p>需要独立授权。请由助手说明准确的方案与许可范围；本页不批准订单或付款。</p>' : ''}${d?.acceptance ? `<h2>任务验收</h2><p>${d.acceptance.accepted ? '任务交付物通过验收；是否履约仍以业务证据为准。' : '任务交付物尚未通过验收。'}</p>` : '<p>验收结论尚未产生，保持未知。</p>'}${j.artifact ? `<h2>本任务交付物 · 仅本人</h2><pre>${escape(j.artifact.data.markdown ?? JSON.stringify(j.artifact.data.result ?? {}, null, 2))}</pre>` : ''}<p><a href="${taskLink(j.id)}">刷新原任务</a> · <a href="${root}/workbench">返回工作台</a></p>`);
}
