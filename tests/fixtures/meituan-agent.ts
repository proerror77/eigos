import { randomUUID } from 'node:crypto';
import { digest } from '../../packages/core/delegation.js';
import { JobStore } from '../../packages/core/store.js';
import { createExecutionCatalog } from '../../packages/capabilities/catalog.js';
import { meituanPrimitiveSchemas, type MeituanPrimitiveReader } from '../../packages/capabilities/meituan-primitives.js';
import type { AgentPlanningContext, PlanningAccess, Reasoner } from '../../packages/coordinator/coordinator.js';
import type { AgentDecision, AgentStep } from '../../packages/ontology/agent-actions.js';
import type { MeituanReadSnapshot } from '../../packages/ontology/meituan-read.js';
import { backend, evidence, interpretation, owner, observeTaskContext, acknowledgeReads } from '../backend-fixture.js';

export const missingMeituan = { sender: null, recipient: null, goodsName: '文件', category: '文件', weightKg: 1, service: 'ordinary' };
export function meituanPrimitiveFixture() {
  let book = [{ addressId: 'private-a', address: '测试住处', cityId: 1, name: '张某', lat: 31.1, lng: 121.1 }, { addressId: 'private-b', address: '测试办公室', cityId: 1, name: '李某', lat: 31.2, lng: 121.2 }, { addressId: 'private-c', address: '外地办公室', cityId: 2, name: '王某', lat: 32.1, lng: 122.1 }];
  const calls: { tool: string; input: Record<string, unknown> }[] = [];
  let accountBinding = digest('synthetic-meituan-account');
  let before: undefined | ((tool: string) => Promise<void>);
  const reader: MeituanPrimitiveReader = { configurationDigest: 'synthetic-atomic-meituan', evidenceKind: 'fixture', invoke: async (tool, input, signal, context = {}) => {
    const account = accountBinding;
    if (context.accountBinding && context.accountBinding !== account) throw new Error('Synthetic account context changed');
    if (!Object.hasOwn(meituanPrimitiveSchemas, tool)) throw new Error('Forbidden synthetic tool');
    const parsed = meituanPrimitiveSchemas[tool as keyof typeof meituanPrimitiveSchemas].parse(input);
    calls.push({ tool, input: parsed }); await before?.(tool); signal.throwIfAborted();
    const value = tool === 'get_address_list' ? { addresses: structuredClone(book) } : tool === 'get_address_info' ? { phone: '13800001111' } : tool === 'search_poi' ? { places: [{ name: '合成公开地点', address: '合成地址', city: String(input.city) }] } : { quote: { _previewTotal: '12.50', _deliveryFee: '12.50' } };
    return { value, accountBinding: account, receipt: { id: randomUUID(), tool: tool as keyof typeof meituanPrimitiveSchemas, server: 'meituan-personal', transport: 'mcp-stdio', evidenceKind: 'fixture', readOnly: true, observedAt: new Date().toISOString(), inputDigest: digest(parsed), resultDigest: digest(value) } };
  } };
  return { reader, calls, setAccount: (value: string) => { accountBinding = digest(value); }, getBook: () => book, setBook: (next: typeof book) => { book = next; }, setBefore: (f: typeof before) => { before = f; } };
}
const step = (id: string, action: string, input: object): AgentStep => ({ id, action, argumentsJson: JSON.stringify(input), dependsOn: [], inputRefs: [] });
export function readMeituan(ctx: AgentPlanningContext, access: PlanningAccess) {
  access.session.call('describe_ontology', { actions: ctx.actionIds });
  access.session.call('query_ontology', { object: { type: 'ServiceRequest', id: ctx.request.id } });
  access.session.call('query_ontology', { object: ctx.state.scope });
  return ctx.state.observations.map(ref => {
    const result = access.session.call('query_ontology', { object: ref }) as { items: { properties: { snapshot: MeituanReadSnapshot } }[] };
    access.session.call('evaluate_ontology', { function: 'meituanReadStatus', object: ref });
    return { ref, snapshot: result.items[0]!.properties.snapshot };
  });
}
export type MeituanChoice = (ctx: AgentPlanningContext, access: PlanningAccess) => AgentDecision;
export const chooseMeituan: MeituanChoice = (ctx, access) => {
  const observations = readMeituan(ctx, access), scope = ctx.state.scope, mode = ctx.state.input.mode;
  const decision = (steps: AgentStep[], observation?: object): AgentDecision => ({ kind: observation ? 'complete' : 'execute', requestRevision: ctx.request.revision, message: 'Synthetic model selects only the required source actions', steps, completionJson: observation ? JSON.stringify({ observation, rationale: 'Actual selected synthetic source evidence' }) : '' });
  const final = observations.find(o => o.snapshot.data.kind === (mode === 'geo' ? 'locations' : mode === 'addresses' ? 'addresses' : 'quote'));
  if (final) return decision([], final.ref);
  if (mode === 'geo') return decision([step('geo', 'SearchMeituanLocations', { scope })]);
  const book = observations.find(o => o.snapshot.data.kind === 'addresses');
  if (!book) return decision([step('book', 'ReadMeituanAddresses', { scope })]);
  if (book.snapshot.data.kind !== 'addresses') throw new Error('Wrong fixture');
  if (!book.snapshot.data.selectionReady) return { kind: 'clarify', requestRevision: ctx.request.revision, message: 'Please supply the private selections and missing goods', steps: [], completionJson: '' };
  const sender = observations.find(o => o.snapshot.data.kind === 'address_detail' && o.snapshot.data.role === 'sender'), recipient = observations.find(o => o.snapshot.data.kind === 'address_detail' && o.snapshot.data.role === 'recipient');
  if (!sender || !recipient) return decision([...(sender ? [] : [step('sender', 'ReadMeituanSenderDetails', { scope, addresses: book.ref })]), ...(recipient ? [] : [step('recipient', 'ReadMeituanRecipientDetails', { scope, addresses: book.ref })])]);
  return decision([step('quote', 'EstimateMeituanDelivery', { scope, addresses: book.ref, sender: sender.ref, recipient: recipient.ref })]);
};
export function meituanReasoner(mode: 'geo' | 'addresses' | 'delivery', choice: MeituanChoice = chooseMeituan, selectors = { sender: '地址1', recipient: '地址2' }): Reasoner {
  return { ground: async (request, _caps, _signal, access) => {
    request = observeTaskContext(access) ?? request;
    const input = mode === 'geo' ? { city: '北京市', keyword: '天安门' } : mode === 'addresses' ? {} : { ...missingMeituan, ...(request.revision > 1 ? selectors : {}) };
    return { decision: { ...interpretation(request, mode === 'geo' ? 'geo.search' : mode === 'addresses' ? 'address.book.read' : 'delivery.quote', input), capabilityRef: { id: mode === 'geo' ? 'geo.search' : mode === 'addresses' ? 'address.book.read' : 'delivery.quote', version: mode === 'delivery' ? '2' : '1' } }, evidence: evidence() };
  }, plan: async () => { throw new Error('Legacy eager planner is forbidden'); }, act: async (ctx, _signal, access) => { observeTaskContext(access); const selected = choice(ctx, access); acknowledgeReads(access); return { decision: selected, evidence: { ...evidence(), decisionDigest: digest(selected) } }; } };
}
export function setupMeituan(mode: 'geo' | 'addresses' | 'delivery' = 'delivery', choice = chooseMeituan, selectors?: { sender: string; recipient: string }) {
  const fixture = meituanPrimitiveFixture(), store = new JobStore(':memory:'), catalog = createExecutionCatalog({ store, meituan: fixture.reader }), b = backend(catalog, meituanReasoner(mode, choice, selectors), store);
  const finish = async (id: string) => { for (let i = 0; i < 16; i++) { const job = store.get(owner, id); if (!['working', 'submitted'].includes(job.state)) return job; await b.run(); } throw new Error('Synthetic Meituan task did not settle'); };
  return { ...fixture, store, catalog, b, finish, close: () => store.close() };
}
