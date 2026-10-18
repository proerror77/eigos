// Participant data only: no expected answers or navigation scripts are exported.
import { syntheticOntology } from './ontology-objects.js';
import { digest } from '../../packages/core/delegation.js';
import { linkSnapshotDigest } from '../../packages/ontology/object-store.js';
import type { BusinessCondition } from '../../packages/ontology/business-model.js';
import type { ObjectRef } from '../../packages/ontology/model.js';
import type { ServiceRequest } from '../../packages/ontology/execution.js';

export const DRILL_QUESTIONS = [
  ['QD-1', '本人已选 A 到 B，1 公斤文件、普通送，目前能核对的费用是什么？适用于哪些条件，何时需要重查？'],
  ['QD-2', '最新返回按 2 公斤快送计价，它还能回答原来的问题吗？指出有依据的差异及仍未知的内容。'],
  ['QD-3', '原地址选项发生变化后，之前的报价是否仍可用？需要重新确认或读取哪些信息，哪些内容已有充分依据？'],
  ['QG-1', '20 杯指定规格咖啡须在指定期限前送达，总支出上限 500 元。当前查到的候选中，哪些可选，哪些仍不能确定？'],
  ['QG-2', '两个渠道各有报价，它们是否真的来自不同商家？价格和交付条件是否可直接比较？'],
  ['QG-3', '已确认订单共 20 杯，目前收到 18 杯。原任务现在是否完成，还缺什么；哪些批次或记录支持你的判断？'],
  ['QR-1', '餐厅 V、指定日期 19:00、4 人的预订是否已经生效？有哪些确认依据或尚未满足的条件？'],
  ['QR-2', '订金显示已付，但预订仍待确认。这时能向用户说什么，下一步允许做什么？'],
  ['QR-3', '占位已过期，随后收到取消和退款处理中通知。哪些状态已经确定，哪些仍待查证，原任务与售后分别到哪一步？'],
] as const;

export function drillCase(caseId: string, asOf = Date.now()) {
  const question = DRILL_QUESTIONS.find(q => q[0] === caseId); if (!question) throw new Error('Unknown drill question');
  const data = syntheticOntology(asOf), { objects, links } = data.batch;
  const properties = (id: string) => objects.find(o => o.ref.id === id)!.properties;
  const slotTime = new Date(asOf + 86400000); slotTime.setUTCHours(11, 0, 0, 0);
  const startsAt = slotTime.toISOString();
  properties('slot').startsAt = startsAt;
  const reservationConditions = properties('R').conditions as BusinessCondition[];
  (reservationConditions[0]!.expected as { startsAt: string }).startsAt = startsAt;
  properties('quote-D').pricingTerms = { total: { minor: '1940', currency: 'CNY' }, scope: 'all_mandatory_fees', components: [] };
  properties('offer-G').pricingTerms = { total: { minor: '46500', currency: 'CNY' }, scope: 'all_mandatory_fees', components: [] };
  properties('offer-G').deliveryCommitment = startsAt;
  const extraCondition: BusinessCondition = { id: 'delivery-deadline', predicateRef: { id: 'delivery.commitment_covers_deadline', version: '1' }, subject: { type: 'ProductOffer', role: 'delivery_commitment' }, phase: 'precondition', strength: 'hard', operator: 'lte', expected: { at: startsAt, timeZone: 'Asia/Shanghai', originalText: '指定日期19:00前' }, source: { messageId: 'synthetic-user-message', quote: '指定日期19:00前' } };
  (properties('G').conditions as BusinessCondition[]).push(extraCondition);
  properties('G').originalGoal = `20杯350毫升标准奶拿铁，送到合成收件地址B，总费用不超过500元，${startsAt}前送达`;
  properties('R').originalGoal = `餐厅V，${startsAt}（Asia/Shanghai 19:00），4人预订生效`;
  function alternate(id: string, channel: string, changes: Record<string, unknown>) {
    const ref = { type: 'ProductOffer', id }, receipt = { type: 'SourceReceipt', id: `receipt-${id}` };
    if (!objects.some(o => o.ref.id === channel)) objects.push({ ref: { type: 'Channel', id: channel }, properties: { channelId: channel, displayTitle: '另一个合成渠道', name: '另一个合成渠道', accessScope: ['synthetic-only'], supportedOperationRefs: ['synthetic-read'] } });
    objects.push({ ref, properties: { ...structuredClone(properties('offer-G')), offerId: id, displayTitle: `合成报价 ${id}`, ...changes } });
    objects.push({ ref: receipt, properties: { ...structuredClone(properties('receipt-offer-G')), receiptId: receipt.id, displayTitle: `合成来源回执 ${id}`, safeSummary: `合成商品报价 ${id} 的来源回执`, sourceEventId: `synthetic-${id}`, subjects: [{ object: ref, digest: '', linksDigest: '' }] } });
    for (const link of links.filter(l => l.from.id === 'offer-G')) links.push({ ...link, from: ref, to: link.type === 'OfferChannel' ? { type: 'Channel', id: channel } : link.type === 'ProductOfferEvidence' ? receipt : link.to });
  }
  if (caseId === 'QD-2') { properties('quote-D').quotedWeight = { amount: '2', unit: 'kg' }; properties('quote-D').serviceLevel = 'express'; }
  if (caseId === 'QD-3') properties('address-A').address = { text: '合成新寄件地址 A2', city: '北京市', sourceRevision: '2' };
  if (caseId === 'QG-1') {
    alternate('offer-X', 'channel', { capacity: 'unknown', pricingTerms: { total: { minor: '41000', currency: 'CNY' }, scope: 'all_mandatory_fees', components: [] } });
    alternate('offer-Y', 'other-channel', { pricingCompleteness: 'partial', pricingTerms: { total: { minor: '40900', currency: 'CNY' }, scope: 'partial', components: [] } });
  }
  if (caseId === 'QG-2') alternate('offer-Y', 'other-channel', { pricingCompleteness: 'partial', pricingTerms: { total: { minor: '40900', currency: 'CNY' }, scope: 'partial', components: [] } });
  if (caseId === 'QR-2') { properties('reservation').reservationState = 'pending'; delete properties('reservation').confirmedAt; }
  if (caseId === 'QR-3') {
    properties('reservation').reservationState = 'canceled'; properties('reservation').holdExpiresAt = new Date(asOf - 60000).toISOString();
    delete properties('reservation').confirmedAt;
    properties('slot').expiresAt = new Date(asOf - 60000).toISOString(); properties('R').progress = 'unmet';
  }
  for (const receipt of objects.filter(o => o.ref.type === 'SourceReceipt')) {
    const subjects = receipt.properties.subjects as { object: ObjectRef; digest: string; linksDigest: string }[];
    for (const subject of subjects) { subject.digest = digest(properties(subject.object.id)); subject.linksDigest = linkSnapshotDigest(subject.object, links); }
    receipt.properties.contentDigest = digest(subjects);
  }
  const requestId = caseId[1]!, requestProps = properties(requestId);
  const request: ServiceRequest = { id: requestId, revision: 1, originalGoal: String(requestProps.originalGoal), requirements: [], conditions: requestProps.conditions as BusinessCondition[], messages: [{ id: 'synthetic-user-message', text: String(requestProps.originalGoal), receivedAt: new Date(asOf).toISOString() }] };
  return { ...data, request, question: question[1], caseId, datasetVersion: 'n2-drill-v2', asOf: new Date(asOf).toISOString(), datasetDigest: digest(data.batch) };
}
