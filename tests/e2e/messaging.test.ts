import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ClientFactory } from '@a2a-js/sdk/client';
import { SendMessageRequest } from '@a2a-js/sdk';
import { z } from 'zod';
import { loopbackFetch } from '../fixtures/loopback-fetch.js';

test('compiled Gateway accepts MCP/A2A PA communication across a process boundary and resumes the encrypted inbox', { timeout: 60000 }, async () => {
  const child = spawn(process.execPath, ['dist/tests/fixtures/messaging-process.js'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  assert(child.stdout && child.stderr);
  let output = ''; child.stdout.on('data', value => { output += String(value); }); child.stderr.on('data', value => { output += String(value); });
  let mcp: Client | undefined; const originalFetch = globalThis.fetch;
  const next = async () => (await once(child, 'message', { signal: AbortSignal.timeout(30000) }))[0];
  try {
    const ready = z.object({ kind: z.literal('ready'), base: z.url(), http: z.url(), a: z.object({ token: z.string(), endpointId: z.uuid() }), b: z.object({ token: z.string(), endpointId: z.uuid() }) }).parse(await next());
    let http = ready.http;
    const fetcher = loopbackFetch(() => new Map([[ready.base, http]])); globalThis.fetch = fetcher;
    mcp = new Client({ name: 'independent PA', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(ready.base + '/mcp'), { fetch: fetcher, requestInit: { headers: { Authorization: `Bearer ${ready.a.token}` } } }));
    const tool = async (name: string, args: Record<string, unknown>) => z.object({ structuredContent: z.object({ result: z.record(z.string(), z.unknown()) }) }).parse(await mcp!.callTool({ name, arguments: args })).structuredContent.result;
    const a2a = await new ClientFactory().createFromUrl(ready.base);
    const request = async (operation: object) => {
      const response = await a2a.sendMessage(SendMessageRequest.fromJSON({ message: { messageId: 'requestId' in operation ? operation.requestId : randomUUID(), role: 'ROLE_USER', parts: [{ data: { schema: 'eigos.agent-communication/1', operation } }] } }), { serviceParameters: { Authorization: `Bearer ${ready.b.token}` } });
      assert('messageId' in response); const part = response.parts[0]; assert(part?.content?.$case === 'data');
      return z.object({ result: z.record(z.string(), z.unknown()) }).parse(part.content.value).result;
    };
    const contact = await tool('request_agent_contact', { endpointId: ready.b.endpointId, requestId: randomUUID() });
    await request({ action: 'contact.respond', contactId: contact.contactId, decision: 'accept', requestId: randomUUID() });
    const sent = await tool('send_agent_message', { endpointId: ready.b.endpointId, text: 'compiled-private-canary', requestId: randomUUID() });
    await mcp.close(); mcp = undefined;
    const restarted = next(); child.send({ command: 'restart' }); http = z.object({ http: z.url() }).parse(await restarted).http;
    await request({ action: 'list', limit: 20 });
    const message = await request({ action: 'read', messageId: sent.messageId }); assert.equal(message.text, 'compiled-private-canary');
    const reply = await request({ action: 'reply', messageId: sent.messageId, text: 'compiled reply', requestId: randomUUID() }); assert.equal(reply.inReplyTo, sent.messageId);
    mcp = new Client({ name: 'resumed independent PA', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(ready.base + '/mcp'), { fetch: fetcher, requestInit: { headers: { Authorization: `Bearer ${ready.a.token}` } } }));
    await tool('list_agent_messages', {});
    assert.equal((await tool('read_agent_message', { messageId: reply.messageId })).text, 'compiled reply');
    const counted = next(); child.send({ command: 'counts' }); assert.deepEqual(await counted, { kind: 'counts', a: 0, b: 0 });
    for (const secret of [ready.a.token, ready.b.token, 'compiled-private-canary', 'compiled reply']) assert(!output.includes(secret));
  } finally {
    await mcp?.close(); globalThis.fetch = originalFetch;
    if (child.connected) {
      const exited = once(child, 'exit'); child.send({ command: 'stop' });
      const timer = setTimeout(() => child.kill('SIGTERM'), 5000); await exited; clearTimeout(timer);
    } else if (child.exitCode === null) child.kill('SIGTERM');
  }
});
