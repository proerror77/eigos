import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import type { FunctionDefinition, LinkDefinition, ObjectRef, ObjectTypeDefinition, PropertyDefinition } from './model.js';
import type { OntologyObjectStore, ReadBudget } from './object-store.js';

const id = z.string().min(1).max(200), text = z.string().min(1).max(2000), sha = z.string().regex(/^[a-f0-9]{64}$/);
function freeze<T>(value: T): T { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
export const regulatoryReferenceSchema = z.strictObject({
  id, title: text, issuer: text, publisher: text, url: z.url(), jurisdiction: z.literal('CN'),
  documentVersion: text, effectiveFrom: z.iso.date().optional(), capturedAt: z.iso.datetime({ offset: true }),
  contentSha256: sha, capture: z.literal('official_document_body'),
  use: z.literal('reference_only'), topics: z.array(text).min(1).max(12), summary: text,
});

// Reviewed public document snapshots. Their dates describe the captured source,
// not a legal eligibility determination or a promise of future currency.
export const CUSTOMS_REFERENCES = freeze([
  {
    id: 'cn-customs-law-2021', title: '中华人民共和国海关法', issuer: '全国人民代表大会常务委员会',
    publisher: '国家原子能机构政府转载', url: 'https://www.caea.gov.cn/n6760401/n6760402/c6827751/content.html',
    jurisdiction: 'CN', documentVersion: '2021-04-29 第六次修正', effectiveFrom: '2021-04-29',
    capturedAt: '2026-10-20T00:53:20.336Z', contentSha256: 'cc79773f274045a9d7066e08874b8f13cc5d8a84754ad55861f3f49ad52d8b2d',
    capture: 'official_document_body', use: 'reference_only', topics: ['海关监管', '如实申报', '个人物品与货物的适用范围'],
    summary: '海关对进出境货物和物品实施监管；个人物品与货物的适用范围需要区分。申报资料、物品性质和实际用途需要有据可查，承运承诺不等于海关放行。',
  },
  {
    id: 'cn-customs-notice-2024-176', title: '海关总署公告2024年第176号', issuer: '海关总署',
    publisher: '商务部政府转载', url: 'https://www.mofcom.gov.cn/zcfb/zgdwjjmywg/art/2025/art_4adf716bf28542fdbffe5510b30d8ed9.html',
    jurisdiction: 'CN', documentVersion: '2024-11-29 公布文本', effectiveFrom: '2024-12-01',
    capturedAt: '2026-10-20T00:54:23.388Z', contentSha256: '2749c0d76494721da58c17f35057662c41fe289a4fe6f592a76ce11b13fc90d3',
    capture: 'official_document_body', use: 'reference_only', topics: ['进境物品管理文件的修改与废止', '旧版依据不能直接沿用'],
    summary: '该公告修改或废止部分进境物品管理文件。引用旧文件时须核对后续修订及生效范围；此文献本身不构成某一商品或交易的准入结论。',
  },
  {
    id: 'cn-tobacco-law-2015', title: '中华人民共和国烟草专卖法', issuer: '全国人民代表大会常务委员会',
    publisher: '国家市场监督管理总局', url: 'https://www.samr.gov.cn/zw/zfxxgk/fdzdgknr/bgt/art/2023/art_5e70a89ddb7d4c20a8315e0124f468a5.html',
    jurisdiction: 'CN', documentVersion: '2015-04-24 修正文本',
    capturedAt: '2026-10-20T00:53:09.699Z', contentSha256: 'e75edf66f6474c4b1b92a3b26b279b72e558ec36d2ee5402279fd4f864bd8271',
    capture: 'official_document_body', use: 'reference_only', topics: ['受管制商品识别', '专卖品监管范围'],
    summary: '雪茄等被纳入烟草专卖品监管范围，相关经营和运输受专门管理。资料用于识别监管属性，不证明某一主体或交易已经获准。',
  },
  {
    id: 'cn-tobacco-regulation-2023', title: '中华人民共和国烟草专卖法实施条例', issuer: '国务院',
    publisher: '国家市场监督管理总局', url: 'https://www.samr.gov.cn/zw/zfxxgk/fdzdgknr/bgt/art/2023/art_4882f33442244df5bd570219964612b7.html',
    jurisdiction: 'CN', documentVersion: '2023-07-20 第四次修订',
    capturedAt: '2026-10-20T00:53:09.697Z', contentSha256: 'f9779f18f383598550312837c99a637841abc595490629d9e2ac65239cbf7d92',
    capture: 'official_document_body', use: 'reference_only', topics: ['经营主体资格', '进出口及运输的专门监管'],
    summary: '烟草专卖品的经营、进出口及运输存在专门管理与资格要求。商品识别、主体资格和具体许可不能由普通物流报价或用户确认替代。',
  },
].map(value => regulatoryReferenceSchema.parse(value)));

const ruleSchema = z.strictObject({ id, description: text, source: z.enum(['platform_policy', 'evidence_integrity', 'synthetic_fixture']), effect: z.enum(['block', 'require_evidence']) });
const ruleSetSchema = z.strictObject({
  id, version: id, coverage: z.literal('synthetic_commerce_only'), legalApproval: z.literal(false),
  referenceIds: z.array(id).min(1).max(20), rules: z.array(ruleSchema).min(1).max(20),
  supportedProduct: z.strictObject({ category: z.literal('roasted_coffee'), hsCodes: z.array(id).min(1).max(10) }),
  requiredAssessmentCodes: z.array(id).min(1).max(20), assessmentMaxAgeMs: z.number().int().positive(),
});
export const CUSTOMS_RULE_SET = freeze(ruleSetSchema.parse({
  id: 'eigos.customs.sandbox-rules@1', version: '1', coverage: 'synthetic_commerce_only', legalApproval: false,
  referenceIds: CUSTOMS_REFERENCES.map(r => r.id), supportedProduct: { category: 'roasted_coffee', hsCodes: ['090121'] },
  requiredAssessmentCodes: ['commodity_import_check'], assessmentMaxAgeMs: 30 * 60 * 1000,
  rules: [
    { id: 'sandbox_only', source: 'platform_policy', effect: 'block', description: 'No executable real customs approval is registered. Sandbox success is not legal permission.' },
    { id: 'regulated_goods_out_of_scope', source: 'platform_policy', effect: 'block', description: 'Tobacco and unsupported regulated categories cannot enter a purchasing flow. This platform boundary is not a blanket legal ruling.' },
    { id: 'exact_commodity_and_route', source: 'evidence_integrity', effect: 'require_evidence', description: 'Bind product classification, origin, quantity, destination, dispatch countries and selected route to verified source evidence.' },
    { id: 'fresh_registered_assessment', source: 'evidence_integrity', effect: 'require_evidence', description: 'Missing, stale, future-dated, conflicting or unregistered assessment versions cannot authorize a purchase.' },
    { id: 'resolved_obligations', source: 'synthetic_fixture', effect: 'require_evidence', description: 'Every required synthetic assessment clause must be present and met; unknown importer, duties or restrictions do not pass.' },
    { id: 'read_before_execution', source: 'platform_policy', effect: 'require_evidence', description: 'The Agent must actually read this exact rule set and evaluate customsGateStatus before firm quotation, checkout and order dispatch. A PA permit cannot override a failed gate.' },
  ],
}));
export const CUSTOMS_POLICY_DIGEST = digest({ rules: CUSTOMS_RULE_SET, references: CUSTOMS_REFERENCES });
export const CUSTOMS_RULE_REF: ObjectRef = freeze({ type: 'CustomsRuleSet', id: `${CUSTOMS_RULE_SET.id}:${CUSTOMS_POLICY_DIGEST}` });
const referenceRef = (reference: typeof CUSTOMS_REFERENCES[number]): ObjectRef => ({ type: 'RegulatoryReference', id: `${reference.id}:${digest(reference)}` });
export const CUSTOMS_REFERENCE_REFS = freeze(CUSTOMS_REFERENCES.map(referenceRef));
const ruleProperties = () => ({ id: CUSTOMS_RULE_REF.id, displayTitle: '海关参考资料与沙箱执行关卡', policyDigest: CUSTOMS_POLICY_DIGEST, snapshot: CUSTOMS_RULE_SET });
const referenceProperties = (reference: typeof CUSTOMS_REFERENCES[number]) => ({ id: referenceRef(reference).id, displayTitle: reference.title, snapshot: reference });

export function seedCustomsPolicy(graph: OntologyObjectStore, owner: string, scope: ObjectRef, request: ObjectRef) {
  graph.ingest(owner, {
    objects: [{ ref: CUSTOMS_RULE_REF, properties: ruleProperties() }, ...CUSTOMS_REFERENCES.map(r => ({ ref: referenceRef(r), properties: referenceProperties(r) }))],
    links: [{ type: 'CommerceTaskCustomsRuleSet', from: scope, to: CUSTOMS_RULE_REF }, { type: 'RequestCustomsRuleSet', from: request, to: CUSTOMS_RULE_REF }, ...CUSTOMS_REFERENCES.flatMap(r => [{ type: 'CustomsRuleReference', from: CUSTOMS_RULE_REF, to: referenceRef(r) }, { type: 'RequestRegulatoryReference', from: request, to: referenceRef(r) }])],
  }, { kind: 'provider', id: 'eigos-reviewed-policy-registry', observedAt: CUSTOMS_REFERENCES.map(r => r.capturedAt).sort().at(-1)! });
}

export function checkedCustomsPolicy(graph: OntologyObjectStore, owner: string, scope: ObjectRef, budget: ReadBudget = { remaining: 1000 }) {
  const books = graph.related(owner, scope, 'customsRuleSet', budget);
  if (books?.length !== 1 || digest(books[0]!.ref) !== digest(CUSTOMS_RULE_REF) || digest(books[0]!.properties) !== digest(ruleProperties())) throw new DomainError('CONFLICT', 'The current trusted customs rule set is missing or changed');
  const references = graph.related(owner, CUSTOMS_RULE_REF, 'references', budget) ?? [];
  if (references.length !== CUSTOMS_REFERENCES.length || CUSTOMS_REFERENCES.some(expected => !references.some(r => r.ref.id === referenceRef(expected).id && digest(r.properties) === digest(referenceProperties(expected))))) throw new DomainError('CONFLICT', 'A customs reference version or source identity changed');
  return { ruleSet: CUSTOMS_RULE_REF, policyDigest: CUSTOMS_POLICY_DIGEST, references: references.map(r => r.ref), coverage: CUSTOMS_RULE_SET.coverage, legalApproval: false as const };
}

const p = (kind: PropertyDefinition['kind'], schema: z.ZodType, description: string): PropertyDefinition => ({ kind, schema, description, required: true, source: 'Reviewed EIGOS configuration; references are not transaction eligibility or execution authority' });
export const customsPolicyObjects: ObjectTypeDefinition[] = [
  { id: 'RegulatoryReference', version: '1', name: '监管参考依据', aliases: ['RegulatoryReference', '海关条例', '法规来源'], description: 'Official source snapshot identity and version, retained as reference material only; jurisdiction coverage must not be inferred', primaryKey: 'id', titleKey: 'displayTitle', properties: { id: p('string', id, 'Reviewed document identity'), displayTitle: p('string', text, 'Document title'), snapshot: p('struct', regulatoryReferenceSchema, 'Issuer, official URL, version, capture time and content digest; no implicit legal approval') } },
  { id: 'CustomsRuleSet', version: '1', name: '海关执行关卡', aliases: ['CustomsRuleSet', '海关硬关卡'], description: 'Trusted, versioned platform and source-evidence gates, separate from the official reference documents; current executable coverage is synthetic only', primaryKey: 'id', titleKey: 'displayTitle', properties: { id: p('string', id, 'Exact rule-set identity'), displayTitle: p('string', text, 'Human-readable policy label'), policyDigest: p('string', sha, 'Digest of the reviewed rules and source references'), snapshot: p('struct', ruleSetSchema, 'Known hard checks; PA approval and model text cannot modify these checks') } },
];
export const customsPolicyLinks: LinkDefinition[] = [
  { id: 'CommerceTaskCustomsRuleSet', description: 'Task scope is bound to one reviewed customs policy version', from: { type: 'CommerceTask', name: 'customsRuleSet', many: false }, to: { type: 'CustomsRuleSet', name: 'commerceTasks', many: true } },
  { id: 'CustomsRuleReference', description: 'Reference citations inform the Agent but do not establish transaction eligibility', from: { type: 'CustomsRuleSet', name: 'references', many: true }, to: { type: 'RegulatoryReference', name: 'ruleSets', many: true } },
  { id: 'RequestCustomsRuleSet', description: 'Allow a request-scoped Agent to read its policy without owner-wide access', from: { type: 'ServiceRequest', name: 'customsRuleSets', many: true }, to: { type: 'CustomsRuleSet', name: 'requests', many: true } },
  { id: 'RequestRegulatoryReference', description: 'Allow a request-scoped Agent to read its reference material without traversing another task', from: { type: 'ServiceRequest', name: 'regulatoryReferences', many: true }, to: { type: 'RegulatoryReference', name: 'requests', many: true } },
];
export const customsPolicyFunctions: FunctionDefinition[] = [
  { id: 'customsGateStatus', version: '1', inputTypes: ['CustomsAssessment', 'LandedCostQuote', 'CommerceCheckout'], description: 'Evaluate current trusted policy and exact source-bound commodity, route, mandatory clauses, version and freshness. Only pass_sandbox may continue a simulated purchase; blocked or unknown stops execution. Never grants real import permission.' },
];
