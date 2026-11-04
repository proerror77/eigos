// Every supplier, model decision, order and payment in this file is synthetic.
// The actual EIGOS task/Worker/ontology/acceptance code is reused for catalog reads.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { JobStore } from '../../packages/core/store.js';
import { createExecutionCatalog } from '../../packages/capabilities/catalog.js';
import { digest } from '../../packages/core/delegation.js';
import type { Reasoner } from '../../packages/coordinator/coordinator.js';
import { taobaoCatalogReadSchema, type NoSpendAuthority, type RehearsalOrder, type SyntheticAlipayTransport,
  type SyntheticPaymentRead, type SyntheticOrderRead, type AlipayPaymentCommand, type PreparedAlipayPayment } from '../../packages/pa/alipay-agent-pay.js';
import { backend, interpretation, evidence, observeTaskContext, acknowledgeReads, owner } from '../backend-fixture.js';

export const fixtureItem = { itemId: 'sim-item-1001', title: '模拟淘宝雨伞', referenceAmount: '29.90', currency: 'CNY' as const, amountUnit: 'major' as const };
export const fixtureCatalogResult = { items: [fixtureItem], priceKind: 'reference', stockGuarantee: false, checkoutTotal: 'unknown' };
export function fixtureRead(now = Date.now()) {
  return taobaoCatalogReadSchema.parse({ provider: 'taobao', query: { action: 'GetTaobaoProducts', parameters: { itemIds: [fixtureItem.itemId] } },
    result: fixtureCatalogResult, observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 300_000).toISOString(),
    evidenceKind: 'fixture', noBusinessWrites: true, paymentPerformedByEigos: false });
}
export function fixtureAuthority(taskId: string = randomUUID(), now = Date.now()): NoSpendAuthority {
  return { taskId, itemId: fixtureItem.itemId, quantity: 1, maximumMinor: '4000', currency: 'CNY', payeeId: 'sim-merchant',
    expiresAt: new Date(now + 300_000).toISOString(), mode: 'rehearsal_only', allowRealOrders: false, allowRealPayments: false };
}
export function fixtureOrder(authority = fixtureAuthority(), now = Date.now()): RehearsalOrder {
  return { environment: 'synthetic', orderId: 'sim-order-1001', taskId: authority.taskId, itemId: authority.itemId, skuId: 'sim-sku-blue',
    quantity: authority.quantity, payeeId: 'sim-merchant', payeeName: '模拟淘宝商户', amount: { minor: '3490', currency: 'CNY' },
    stockConfirmed: true, shippingIncluded: true, paymentLink: 'https://cashier.alipay.invalid/sim-order-1001?token=synthetic-secret',
    observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 300_000).toISOString() };
}
export class SyntheticAlipay implements SyntheticAlipayTransport {
  readonly environment = 'synthetic' as const;
  submitCount = 0; paymentReads = 0; orderReads = 0;
  lastCommand?: AlipayPaymentCommand;
  paymentState: SyntheticPaymentRead['state'] = 'paid'; orderState: SyntheticOrderRead['state'] = 'confirmed';
  paymentOverride: Partial<SyntheticPaymentRead> = {}; orderOverride: Partial<SyntheticOrderRead> = {};
  loseSubmitResponse = false; failReads = false;
  async submit(command: AlipayPaymentCommand) {
    this.submitCount++; this.lastCommand = command;
    assert.equal(command.command, 'submit-payment');
    assert.deepEqual(command.args.filter(v => v.startsWith('--')), ['--session-id', '--payment-link', '--intent-summary']);
    assert(command.args.includes('服务内容：模拟淘宝雨伞 × 1，支付金额：¥34.90，支付对象：模拟淘宝商户'));
    if (this.loseSubmitResponse) throw new Error('Synthetic response loss after dispatch');
  }
  private read(p: PreparedAlipayPayment) {
    if (this.failReads) throw new Error('Synthetic readback unavailable');
    return { environment: this.environment, operationId: p.operationId, orderId: p.orderId, payeeId: p.payeeId, minor: p.amount.minor, currency: p.amount.currency };
  }
  async readPayment(p: PreparedAlipayPayment): Promise<SyntheticPaymentRead> {
    this.paymentReads++; return { ...this.read(p), state: this.paymentState, ...this.paymentOverride };
  }
  async readOrder(p: PreparedAlipayPayment): Promise<SyntheticOrderRead> {
    this.orderReads++; return { ...this.read(p), state: this.orderState, ...this.orderOverride };
  }
}

export async function readTaobaoCatalogThroughEigos() {
  const store = new JobStore(':memory:'), query = { action: 'GetTaobaoProducts' as const, parameters: { itemIds: [fixtureItem.itemId] } };
  let sourceCalls = 0;
  const catalog = createExecutionCatalog({ store, paymentCommerce: { taobao: { connectionFile: '/synthetic/taobao', evidenceKind: 'fixture',
    connector: { invoke: async (input, signal) => { signal.throwIfAborted(); assert.deepEqual(input, query); sourceCalls++;
      return { result: fixtureCatalogResult, observedAt: new Date().toISOString() }; } } } } });
  const model: Reasoner = {
    ground: async (request, _caps, _signal, access) => ({ decision: {
      ...interpretation(observeTaskContext(access) ?? request, 'taobao.catalog.query', query), capabilityRef: { id: 'taobao.catalog.query', version: '1' } }, evidence: evidence() }),
    plan: async () => { throw new Error('Do not introduce a fixed shopping recipe'); },
    act: async (ctx, _signal, access) => {
      observeTaskContext(access); access.session.call('describe_ontology', { actions: [query.action] });
      access.session.call('query_ontology', { object: ctx.state.scope });
      const observation = ctx.state.observations[0];
      if (observation) {
        access.session.call('query_ontology', { object: observation });
        access.session.call('evaluate_ontology', { function: 'paymentCommerceReadStatus', object: observation });
      }
      const decision = { kind: observation ? 'complete' as const : 'execute' as const, requestRevision: ctx.request.revision, message: 'Read the synthetic Taobao catalog only',
        steps: observation ? [] : [{ id: 'catalog', action: query.action, argumentsJson: JSON.stringify({ scope: ctx.state.scope }), dependsOn: [], inputRefs: [] }],
        completionJson: observation ? JSON.stringify({ observation, rationale: 'Return only the catalog observation' }) : '' };
      acknowledgeReads(access); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } };
    },
  };
  try {
    const b = backend(catalog, model, store), task = b.submit({ goal: '读取模拟淘宝雨伞商品，供 PA 演练购物；不要下单或付款。', executionEnvironment: 'sandbox' });
    for (let i = 0; i < 10 && ['submitted', 'working'].includes(store.get(owner, task.id).state); i++) await b.run();
    const done = store.get(owner, task.id);
    assert.equal(done.state, 'completed', JSON.stringify(done.delegation?.agent?.feedback));
    assert(done.delegation!.agent!.plans.every(plan => plan.steps.every(step => step.effect === 'read')));
    assert.equal(sourceCalls, 1);
    const result = done.artifact!.data.result as { providerRead: unknown };
    return { taskId: task.id, catalogRead: taobaoCatalogReadSchema.parse(result.providerRead), sourceCalls, eigosPaymentActions: 0 };
  } finally { store.close(); }
}
