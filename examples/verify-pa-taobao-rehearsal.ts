// Repeatable, credential-free integration exercise. Model and suppliers are
// synthetic; actual EIGOS execution and PA MCP transports run locally.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { createPAPaymentsApp } from '../apps/pa-payments/app.js';
import { AlipayRehearsalLedger } from '../packages/pa/alipay-agent-pay.js';
import { fixtureAuthority, fixtureOrder, SyntheticAlipay, readTaobaoCatalogThroughEigos } from '../tests/fixtures/taobao-pa-rehearsal.js';

const eigos = await readTaobaoCatalogThroughEigos(), authority = fixtureAuthority(eigos.taskId), order = fixtureOrder(authority), sessionId = randomUUID();
const token = randomBytes(32).toString('hex'), server = createServer(createPAPaymentsApp(token));
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
const client = new Client({ name: 'synthetic-taobao-pa', version: '1' });
const ledger = new AlipayRehearsalLedger(), synthetic = new SyntheticAlipay();
try {
  assert.equal((await fetch(endpoint, { method: 'POST' })).status, 401);
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ['get_payment_policy', 'prepare_alipay_rehearsal', 'prepare_taobao_shopping']);
  const draft = await client.callTool({ name: 'prepare_taobao_shopping', arguments: { catalogRead: eigos.catalogRead, authority } });
  assert(!draft.isError); assert.equal(z.object({ status: z.string() }).parse(draft.structuredContent).status, 'awaiting_order_material');
  const prepared = await client.callTool({ name: 'prepare_alipay_rehearsal', arguments: { catalogRead: eigos.catalogRead, authority, order, sessionId } });
  assert(!prepared.isError); assert.equal(z.object({ dispatchAllowed: z.boolean() }).parse(prepared.structuredContent).dispatchAllowed, false);
  assert(!JSON.stringify(prepared).includes('synthetic-secret'));
  await assert.rejects(client.callTool({ name: 'submit-payment', arguments: {} }), /not found/);
  const first = await ledger.rehearse(eigos.catalogRead, authority, order, sessionId, synthetic);
  assert.equal(first.simulationState, 'confirmed'); assert.equal(first.officialPaymentVerified, false);
  const repeat = await ledger.rehearse(eigos.catalogRead, authority, order, sessionId, synthetic);
  assert.equal(repeat.recoveredByReadback, true); assert.equal(synthetic.submitCount, 1);
  console.log(JSON.stringify({ mode: 'rehearsal_only', evidenceLevel: 'synthetic', taskId: eigos.taskId,
    catalogReadThroughEigos: true, paMcpVerified: true, simulationState: first.simulationState,
    simulatedSubmissions: synthetic.submitCount, paymentReadbacks: synthetic.paymentReads, orderReadbacks: synthetic.orderReads,
    noDuplicateDispatch: true, realOrdersCreated: 0, realPaymentsSubmitted: 0, officialPaymentVerified: false,
    liveTaobaoCheckoutVerified: false, paymentAuthority: 'pa_owned' }));
} finally {
  ledger.close(); await client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
}
