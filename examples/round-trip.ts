import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ClientFactory } from '@a2a-js/sdk/client';
import { SendMessageRequest, TaskState } from '@a2a-js/sdk';
import type { Job } from '../packages/core/domain.js';

const base = process.env.PUBLIC_URL ?? 'http://127.0.0.1:3000';
const token = process.env.EIGOS_ACCESS_TOKEN ?? process.env.EIGOS_DEV_TOKEN;
if (!token) throw new Error('Set EIGOS_ACCESS_TOKEN or use npm run setup:dev');
const mcp = new Client({ name: 'eigos-example', version: '0.1.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
try {
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  const submitted = await mcp.callTool({ name: 'submit_task', arguments: { service: 'eigos.delegate', goal: 'Prepare only a task brief for comparing workshop venues; ask me for the required deliverable. Do not perform venue research or booking.', requestId: randomUUID() } });
  if (submitted.isError) throw new Error(JSON.stringify(submitted.content));
  let job = (submitted.structuredContent as { result: Job }).result;
  const deadline = Date.now() + 180000;
  while (['submitted','working'].includes(job.state) && Date.now() < deadline) {
    await new Promise(r=>setTimeout(r,1000));
    const read = await mcp.callTool({name:'get_task', arguments:{taskId:job.id}});
    if (read.isError) throw new Error('Task read failed'); job=(read.structuredContent as {result:Job}).result;
  }
  if (job.state !== 'input-required') throw new Error('Inspect the original task; expected a clarification before replying');
  console.log('MCP submitted:', job.id, job.state, job.question);

  const a2a = await new ClientFactory().createFromUrl(base);
  const completed = await a2a.sendMessage(SendMessageRequest.fromJSON({ message: {
    messageId: randomUUID(), taskId: job.id, role: 'ROLE_USER',
    parts: [{ text: 'Record a comparison table with capacity, price and sources as the required deliverable.' }],
  } }), { serviceParameters: { Authorization: `Bearer ${token}` } });
  if (!('id' in completed) || completed.status?.state !== TaskState.TASK_STATE_COMPLETED) throw new Error('Expected a completed task brief');
  console.log('A2A answered and completed the brief:', completed.id);

  const read = await mcp.callTool({ name: 'get_task', arguments: { taskId: job.id } });
  if (read.isError) throw new Error(JSON.stringify(read.content));
  console.log('MCP readback:', JSON.stringify(read.structuredContent, null, 2));
  console.log('This prepared a task brief only. No venue research, booking or payment occurred.');
} finally { await mcp.close(); }
