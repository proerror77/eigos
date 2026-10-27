import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AgentConnector } from '../packages/agent-client/client.js';
import { TaskRelayClient } from '../packages/agent-client/relay.js';
import { RelayClient } from '../packages/agent-transport/client.js';
import { readPrivateJson } from '../packages/relay/files.js';

// Host configuration and OAuth credentials are private files, never model arguments.
const inputPath = process.argv[2];
if (!inputPath) throw new Error('Pass the absolute path of a private Relay task request file');
const input = z.strictObject({
  gatewayOrigin: z.url(), relayUrl: z.url(), paCredentialPath: z.string(), nodeCredentialPath: z.string(),
  operation: z.enum(['enroll', 'renew', 'bind', 'submit', 'get']), requestId: z.uuid().optional(),
  goal: z.string().min(1).max(10000).optional(), taskId: z.uuid().optional(),
}).parse(readPrivateJson(inputPath));
const agent = await AgentConnector.open({ baseUrl: input.gatewayOrigin, credentialPath: input.paCredentialPath, displayName: 'Relay PA' });
const node = await RelayClient.open({ baseUrl: input.relayUrl, credentialPath: input.nodeCredentialPath, displayName: 'Relay PA' });
try {
  if (input.operation === 'enroll' || input.operation === 'renew') console.log(JSON.stringify(await agent.enrollTaskRelay(node, { renew: input.operation === 'renew', requestId: input.requestId })));
  else {
    const pa = new TaskRelayClient(node, agent), binding = await pa.bind();
    if (input.operation === 'bind') console.log(JSON.stringify(binding));
    else {
      const requestId = input.requestId ?? randomUUID(), signal = AbortSignal.timeout(30000);
      const request = input.operation === 'get' ? { kind: 'task.get' as const, requestId, taskId: z.uuid().parse(input.taskId) }
        : { kind: 'task.submit' as const, requestId, input: { service: 'eigos.delegate' as const, requestId, goal: z.string().min(1).parse(input.goal) } };
      const sent = await pa.send(request, { signal });
      // Keep these IDs if the following response is interrupted. A transport receipt is not task completion.
      console.log(JSON.stringify({ requestId, messageId: sent.messageId, transportStatus: sent.receipt.status }));
      console.log(JSON.stringify({ requestId, task: await pa.receive(requestId, signal) }));
    }
  }
} finally { node.close(); }
