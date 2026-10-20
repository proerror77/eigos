// Deterministic model/source fixtures; these are not live provider verification.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { digest } from '../../packages/core/delegation.js';
import { ExecutionCatalog } from '../../packages/core/catalog.js';
import { JobStore } from '../../packages/core/store.js';
import type { AgentProgram, AgentProgramContext, AgentActionContext } from '../../packages/core/agent-program.js';
import type { ServiceRequest } from '../../packages/ontology/execution.js';
import { PAOTUI_AGENT_REFS, PaotuiAgentProgram } from '../../packages/capabilities/paotui-agent.js';
import { atomicReceiptSchema, atomicTool, type PaotuiAtomicReader, type PaotuiOperation } from '../../packages/capabilities/paotui-atomic.js';
import type { AgentDecision, AgentStep } from '../../packages/ontology/agent-actions.js';
import type { Reasoner, AgentPlanningContext, PlanningAccess } from '../../packages/coordinator/coordinator.js';
import type { PaotuiObservation } from '../../packages/ontology/paotui-agent.js';
import { paotuiInputs } from '../../packages/capabilities/paotui-current-inputs.js';
import type { ObjectRef } from '../../packages/ontology/model.js';
import { backend, evidence, interpretation, owner } from '../backend-fixture.js';

export const step = (id: string, action: string, args: object, dependsOn: string[] = [], inputRefs: AgentStep['inputRefs'] = []): AgentStep => ({ id, action, argumentsJson: JSON.stringify(args), dependsOn, inputRefs });
export const decide = (ctx: AgentPlanningContext, steps: AgentStep[] = [], completion?: unknown): AgentDecision => ({ kind: completion ? 'complete' : 'execute', requestRevision: ctx.request.revision, message: 'Synthetic action choice', steps, completionJson: completion ? JSON.stringify(completion) : '' });
export function currentBusiness(ctx: AgentPlanningContext, access: PlanningAccess) {
  const refs: Record<string, ObjectRef> = {};
  for (const link of ['parcel', 'route', 'provider', 'channel']) {
    const result = access.session.call('query_ontology', { from: ctx.state.scope, link }) as { items: { ref: ObjectRef }[] };
    assert.equal(result.items.length, 1); refs[link] = result.items[0]!.ref;
  }
  for (const link of ['originAddress', 'destinationAddress']) {
    const result = access.session.call('query_ontology', { from: refs.route, link });
    assert(!JSON.stringify(result).includes('PRIVATE_')); assert(!JSON.stringify(result).includes('13800000000'));
  }
  return refs as Record<'parcel' | 'route' | 'provider' | 'channel', ObjectRef>;
}
export function observe(ctx: AgentPlanningContext, access: PlanningAccess, evaluate = true) {
  access.session.call('read_task_context', {});
  access.session.call('describe_ontology', { search: 'Paotui', limit: 5 });
  access.session.call('query_ontology', { object: { type: 'ServiceRequest', id: ctx.request.id } });
  access.session.call('query_ontology', { object: ctx.state.scope });
  return ctx.state.observations.map(ref => {
    const result = access.session.call('query_ontology', { object: ref }) as { items: { properties: { summary: PaotuiObservation['summary'] } }[] };
    if (evaluate) access.session.call('evaluate_ontology', { function: 'paotuiObservationStatus', object: ref });
    assert(!JSON.stringify(result).includes('PRIVATE_')); assert(!JSON.stringify(result).includes('13800000000'));
    return { ref, summary: result.items[0]!.properties.summary };
  });
}
export type Choice = (ctx: AgentPlanningContext, access: PlanningAccess) => AgentDecision;
export const quoteChoice: Choice = (ctx, access) => {
  const observations = observe(ctx, access), book = observations.find(o => o.summary.action === 'ReadSavedAddresses'), quote = observations.find(o => o.summary.action === 'PreviewDeliveryQuote');
  if (quote) return decide(ctx, [], { observation: quote.ref, rationale: 'The owner selected this current quote' });
  if (!book) return decide(ctx, [step('book', 'ReadSavedAddresses', { scope: ctx.state.scope })]);
  if (ctx.state.feedback.some(f => f.kind !== 'runtime') || !ctx.request.messages.some(m => m.text.includes('1寄到2'))) return { ...decide(ctx), kind: 'clarify', message: '请选择寄件和收件地址。[[saved_addresses]]' };
  const current = currentBusiness(ctx, access);
  return decide(ctx, [
    step('sender', 'ReadSavedAddressDetail', { scope: ctx.state.scope, book: book.ref, selector: '1', role: 'sender' }),
    step('recipient', 'ReadSavedAddressDetail', { scope: ctx.state.scope, book: book.ref, selector: '2', role: 'recipient' }),
    step('quote', 'PreviewDeliveryQuote', { scope: ctx.state.scope, parcel: current.parcel, route: current.route }, ['sender', 'recipient'], [{ stepId: 'sender', targetKey: 'sender' }, { stepId: 'recipient', targetKey: 'recipient' }]),
  ]);
};
export const bookChoice: Choice = (ctx, access) => { const items = observe(ctx, access); return items.length ? decide(ctx, [], { observation: items.at(-1)!.ref, rationale: 'Address book only' }) : decide(ctx, [step('book', 'ReadSavedAddresses', { scope: ctx.state.scope })]); };
export function groundedPaotuiInput(request: ServiceRequest) {
  const fact = paotuiInputs(request).fields.goodsText;
  if (fact?.status !== 'confirmed' || typeof fact.value !== 'string') return {};
  // Synthetic model fixture: choose a literal current owner phrase, including
  // a stated item count. Production grounding makes this decision itself.
  const goodsName = fact.value.match(/(?:[一二两三四五六七八九十\d]+(?:份|个))?(?:合同|文件|餐饮|快递)/u)?.[0];
  return goodsName ? { goodsName } : {};
}
export function paotuiModel(choice: Choice = quoteChoice, kind: 'quote' | 'addresses' = 'quote'): Reasoner {
  return { ground: async (r, _caps, _signal, access) => {
    access.session.call('read_task_context', {});
    access.session.acceptReceipts(access.session.receipts().filter(r => r.status === 'ok').map(r => r.id));
    return { decision: { ...interpretation(r, PAOTUI_AGENT_REFS[kind].id, kind === 'quote' ? groundedPaotuiInput(r) : {}), capabilityRef: PAOTUI_AGENT_REFS[kind] }, evidence: evidence() };
  }, plan: async () => { throw new Error('No legacy prepared workflow permitted'); }, act: async (ctx, _signal, access) => {
    const decision = choice(ctx, access);
    access.session.acceptReceipts(access.session.receipts().filter(r => r.status === 'ok').map(r => r.id));
    return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
  } };
}
export function programContext(store: JobStore, owner: string, request: ServiceRequest, program: AgentProgram): AgentProgramContext {
  const initialized = store.transaction(() => program.initialize(store.ontology, owner, request, program.ref.id === 'delivery.quote' ? groundedPaotuiInput(request) : {}));
  return { graph: store.ontology, owner, request, state: { version: '1', programRef: program.ref, programDigest: program.configurationDigest, ...initialized, requestRevision: request.revision, plans: [], observations: [], feedback: [] } };
}
export async function programRead(program: AgentProgram, ctx: AgentProgramContext, action = 'ReadSavedAddresses', input: Record<string, unknown> = { scope: ctx.state.scope }) {
  const actionCtx: AgentActionContext = { ...ctx, planId: randomUUID(), intentId: randomUUID(), attemptId: randomUUID(), modelRunId: randomUUID() };
  const result = await program.invoke(actionCtx, action, input, new AbortController().signal), ref = program.project(actionCtx, action, input, result); ctx.state.observations.push(ref); return ref;
}
export function setup(choice: Choice = quoteChoice, kind: 'quote' | 'addresses' = 'quote') {
  const store = new JobStore(':memory:'), calls: { operation: PaotuiOperation; input: Record<string, unknown> }[] = [];
  const flags = { changedBook: false, before: undefined as undefined | ((operation: PaotuiOperation) => Promise<void>), price: '12.50', accountIdentity: undefined as string | undefined };
  const connector: PaotuiAtomicReader = { async invoke(operation, input, signal) {
    signal.throwIfAborted(); calls.push({ operation, input: structuredClone(input) }); await flags.before?.(operation); signal.throwIfAborted();
    const result: Record<string, unknown> = operation === 'get_address_list' ? { addresses: [ { addressId: 'a', address: flags.changedBook ? 'PRIVATE_CHANGED_ORIGIN' : 'PRIVATE_ORIGIN', tag: '家里', cityId: '110100', lat: 40019368, lng: 116469191 }, { addressId: 'b', address: 'PRIVATE_DESTINATION', tag: '公司', cityId: '110100', lat: 40029368, lng: 116479191 } ], ...(flags.accountIdentity ? { accountIdentity: flags.accountIdentity } : {}) } : operation === 'get_address_info' ? { phone: '13800000000' } : { _previewTotal: flags.price, _deliveryFee: flags.price };
    return { result, receipt: atomicReceiptSchema.parse({ id: randomUUID(), version: '1', server: 'eigos-ontology', transport: 'mcp-stdio', operation, tool: atomicTool(operation), evidenceKind: 'fixture', inputDigest: digest(input), resultDigest: digest(result), observedAt: new Date().toISOString(), sourceCalls: [operation], readOnly: true }) };
  } };
  const program = new PaotuiAgentProgram(kind, { store, directory: '/private/synthetic-not-opened', connector }), catalog = new ExecutionCatalog([program.capability()], [], [], [], [program]), b = backend(catalog, paotuiModel(choice, kind), store);
  const finish = async (id: string) => { for (let i = 0; i < 15; i++) { const j = store.get(owner, id); if (!['working', 'submitted'].includes(j.state)) return j; await b.run(); } throw new Error('Task did not settle'); };
  return { store, calls, flags, program, catalog, b, finish };
}
