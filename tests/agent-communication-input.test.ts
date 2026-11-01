import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prepareA2ACommunicationRequest, AgentCommunicationInputError } from '../packages/agent-client/communication-input.js';
import { COMMUNICATION_SCHEMA } from '../packages/agent-messaging/contracts.js';

test('the existing PA communication client preserves a write identity and never adds a business task', () => {
  const operation = { action: 'send', endpointId: randomUUID(), text: '  exact PA message\n', requestId: randomUUID() }, original = structuredClone(operation);
  const request = prepareA2ACommunicationRequest(operation);
  assert.deepEqual(operation, original);
  assert.equal(request.message?.messageId, operation.requestId); assert.equal(request.message?.taskId, '');
  const part = request.message?.parts[0]; assert(part?.content?.$case === 'data');
  assert.deepEqual(part.content.value, { schema: COMMUNICATION_SCHEMA, operation });
});

test('communication rejects business requests and malformed input without echoing private content', () => {
  for (const input of [{ service: 'eigos.delegate', goal: 'PRIVATE_GOAL' }, { action: 'send', text: 'PRIVATE_MESSAGE', owner: 'PRIVATE_OWNER' }, { action: 'unknown' }]) {
    assert.throws(() => prepareA2ACommunicationRequest(input), (error: unknown) => error instanceof AgentCommunicationInputError
      && error.code === 'invalid_communication_input' && !error.message.includes('PRIVATE_'));
  }
});
