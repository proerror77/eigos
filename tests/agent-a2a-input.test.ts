import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareA2ATaskRequest, AgentTaskInputError } from '../packages/agent-client/task-input.js';

const wire = (locationContext: unknown) => ({ jsonrpc: '2.0', id: 'transport', method: 'SendMessage', params: {
  configuration: { returnImmediately: true }, message: { messageId: 'original-business-id', role: 'ROLE_USER',
    parts: [{ data: { service: 'eigos.delegate', goal: 'Exact original user goal', locationContext } }] },
} });

test('PA shared user-provided provenance is normalized before dispatch without changing goal or identity', () => {
  const input = wire({ city: '上海市', origin: { name: '上海虹桥站' }, destination: { name: '浦东机场 T2' }, source: 'user_provided' });
  const original = structuredClone(input), result = prepareA2ATaskRequest(input);
  assert.deepEqual(input, original, 'Preparing a request never mutates its saved original');
  const message = result.params.message as typeof input.params.message;
  assert.equal(message.messageId, original.params.message.messageId);
  assert.equal(message.parts[0]!.data.goal, original.params.message.parts[0]!.data.goal);
  assert.deepEqual(message.parts[0]!.data.locationContext, { city: '上海市', origin: { name: '上海虹桥站', source: 'user_provided' }, destination: { name: '浦东机场 T2', source: 'user_provided' } });
  assert.deepEqual(result.params.configuration, input.params.configuration);
});

test('correct provenance, cleared endpoints and continuation payloads retain their meaning', () => {
  const valid = wire({ city: '上海市', origin: null, destination: { name: '浦东机场 T2', source: 'user_provided' } });
  assert.deepEqual(prepareA2ATaskRequest(valid), valid);
  const continuation = { ...valid, params: { ...valid.params, message: { ...valid.params.message, taskId: 'existing-task', metadata: { taskOperation: 'resume' }, parts: [{ data: { expectedRevision: 4 } }] } } };
  assert.deepEqual(prepareA2ATaskRequest(continuation), continuation);
});

for (const location of [
  { city: '上海市', origin: { name: 'A', source: 'saved_address' }, source: 'user_provided' },
  { city: '上海市', origin: { name: 'A' }, source: 'current_location' },
  { city: '上海市', origin: { name: 'A' } },
]) test('conflicting or unobserved location provenance rejects before transport', () => {
  assert.throws(() => prepareA2ATaskRequest(wire(location)), AgentTaskInputError);
});

test('invalid local input exposes field paths without echoing caller data', () => {
  const input = wire({ city: 'PRIVATE_INVALID_CITY', origin: { name: 'PRIVATE_LOCATION', source: 'saved_address' } });
  input.params.message.parts[0]!.data.goal = '';
  assert.throws(() => prepareA2ATaskRequest(input), (error: unknown) => error instanceof AgentTaskInputError
    && error.fields.includes('goal') && !error.message.includes('PRIVATE_') && !error.fields.some(field => field.includes('PRIVATE_')));
  assert.throws(() => prepareA2ATaskRequest({ jsonrpc: 'broken', method: 'SendMessage' }), AgentTaskInputError);
});
