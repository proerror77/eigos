import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { digest } from '../../packages/core/delegation.js';
import { componentContext } from '../../packages/core/composed-actions.js';
import { paCheckoutPaymentRequestSchema } from '../../packages/core/pa-payment.js';
import type { Job } from '../../packages/core/domain.js';
import type { createApp } from '../../apps/gateway/app.js';
import type { createShopifyPASandbox } from '../../packages/capabilities/shopify/pa-checkout-sandbox.js';
import { SHOPIFY_PA_REF } from '../../packages/capabilities/shopify/pa-checkout-contracts.js';

export async function verifyShopifyPAResult(options: {
  directory: string; base: string; token: string; secrets: string[];
  gateway: ReturnType<typeof createApp>; provider: Awaited<ReturnType<typeof createShopifyPASandbox>>;
  events: any[]; toolCalls: { tool: string; taskId: string }[]; readA2A(taskId: string): Promise<any>;
}) {
  const { directory, base, token, secrets, gateway, provider, events, toolCalls } = options;
  const save = (name: string, value: unknown) => writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  const final = JSON.parse(readFileSync(join(directory, 'pa-result.json'), 'utf8'));
  const owner = JSON.stringify(['local-development', 'local', 'developer']), original = gateway.store.get(owner, final.taskId);
  if (existsSync(join(directory, 'original-task.json'))) assert.equal(digest(JSON.parse(readFileSync(join(directory, 'original-task.json'), 'utf8')).artifact), digest(original.artifact));
  else save('original-task.json', original);
  assert.equal(original.state, 'completed', JSON.stringify({ state: original.state, feedback: original.delegation?.agent?.feedback })); assert(original.delegation?.acceptance?.accepted);
  const observer = new Client({ name: 'shopify-pa-independent-observer', version: '1' });
  try {
    await observer.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const observed = await observer.callTool({ name: 'get_task', arguments: { taskId: original.id } }); assert(!observed.isError);
    const publicJob = (observed.structuredContent as { result: Job }).result, job = original, a2a = await options.readA2A(original.id);
    assert.equal(digest(publicJob.artifact), digest(job.artifact));
    assert.equal(digest(publicJob.delegation?.agent?.paPayment?.request), digest(job.delegation?.agent?.paPayment?.request));
    assert.equal(digest(a2a.artifacts[0].parts[0].data), digest(job.artifact!.data)); assert.equal(digest(job.artifact), digest(original.artifact));
    const state = job.delegation!.agent!, handoff = paCheckoutPaymentRequestSchema.parse(state.paPayment!.request);
    const rootResult = job.artifact!.data.result as any;
    // Real planning uses composition. Synthetic unit fixtures can use a single
    // domain directly; neither changes what constitutes merchant payment proof.
    const matching = rootResult.components?.filter((value: any) => value.contextId === state.composition?.paymentContextId && value.status === 'verified');
    if (matching) assert.equal(matching.length, 1, 'Expected one verified original payment component');
    const result = matching ? matching[0].artifact.data.result : rootResult;
    const sourceState = provider.inspect(handoff.terms.resource.id);
    assert.equal(result.realPayment, false); assert.equal(result.evidenceLevel, 'synthetic'); assert.equal(result.paymentAuthority, 'pa_owned'); assert.equal(result.paymentRoute, 'pa_vault');
    assert.deepEqual(result.checkout, { ...sourceState.checkout, independentRead: true }); assert.deepEqual(result.payment, sourceState.payment);
    assert.equal(final.checkoutId, result.payment.checkoutId); assert.equal(final.paymentId, result.payment.paymentId); assert.equal(final.orderId, result.payment.orderId); assert.equal(final.paymentRoute, result.paymentRoute);
    assert.equal(provider.countCheckouts(), 1); assert.equal(provider.countPayments(), 1);
    const audit = provider.audit(), calls = events.filter(event => event.item?.type === 'mcp_tool_call');
    assert.equal(calls.filter(event => event.item.tool === 'submit_task').length, 1);
    const finalRead = calls.filter(event => event.item.tool === 'get_task').at(-1)?.item.result?.structured_content?.result;
    assert.equal(finalRead?.state, 'completed', 'The actual PA must read the final completed EIGOS task');
    assert.equal(digest(finalRead.artifact), digest(job.artifact));
    assert.equal(toolCalls.filter(call => call.tool === 'pay_test_checkout').length, 1); assert(toolCalls.some(call => call.tool === 'payment_capabilities'));
    assert(job.runs?.length && job.runs.every(run => run.runtime === 'codex-exec' && run.threadId && /^[a-f0-9]{64}$/.test(run.outputSha256)));
    for (const row of audit.filter(row => row.caller === 'eigos_source')) {
      const plan = state.plans.find(plan => plan.id === row.context.planId), step = plan?.steps.find(step => step.intentId === row.context.intentId);
      assert(plan?.modelRunId && step); assert(job.runs!.some(run => run.id === row.context.modelRunId)); assert.equal(step.action, row.action); assert.equal(step.operationKey, row.context.operationKey);
      assert(plan.ontologyPlanning.reads.some(read => read.tool === 'query_ontology' || read.tool === 'read_task_context'));
    }
    const payIndex = audit.findIndex(row => row.action === 'pay'); assert(payIndex >= 0);
    for (const action of ['ReadShopifyPaymentCheckout', 'ReadShopifyCheckoutPayment']) assert(audit.slice(payIndex + 1).some(row => row.action === action));
    const component = state.composition?.contexts.find(context => context.id === state.composition?.paymentContextId), program = gateway.catalog.agentProgram(SHOPIFY_PA_REF, owner);
    assert(program?.assertContext);
    const context = { graph: gateway.store.ontologyForJob(owner, job), owner, request: job.delegation!.request, state, intents: gateway.store.intents(owner, job.id), modelRuns: job.runs };
    program.assertContext(component ? componentContext(context, component, program) : context);
    const artifact = JSON.stringify(job.artifact); for (const secret of [...secrets, '4242424242424242']) assert(!artifact.includes(secret));
    save('source-audit.json', audit); save('mcp-readback.json', job); save('a2a-readback.json', a2a);
    const verification = { checkedAt: new Date().toISOString(), status: 'passed', taskId: job.id, checkoutId: handoff.terms.resource.id, paymentId: result.payment.paymentId, orderId: result.payment.orderId,
      paymentRoute: result.paymentRoute, operationId: result.payment.operationId, checkouts: provider.countCheckouts(), payments: provider.countPayments(), actualPAModel: 'codex-exec', actualWorkerModelRuns: job.runs.length,
      actualPAThreadId: events.find(event => event.type === 'thread.started')?.thread_id, ontologyRelease: job.delegation!.ontologyRelease, artifactDigest: digest(job.artifact), currentVerifierConfirmedHandoff: true,
      actualPAReadFinalArtifact: true, independentMcpA2AAndProviderReadback: true, environment: 'sandbox', evidenceLevel: 'synthetic', realPayment: false };
    save('verification.json', verification);
    return verification;
  } finally { await observer.close(); }
}
