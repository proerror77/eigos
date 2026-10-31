import { z } from 'zod';
import { submitSchema } from '../core/domain.js';

const object = z.record(z.string(), z.unknown());
const requestSchema = z.object({
  jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number()]),
  method: z.enum(['SendMessage', 'GetTask', 'ListTasks', 'CancelTask']),
  params: object,
}).passthrough();

export class AgentTaskInputError extends Error {
  readonly code = 'invalid_a2a_task_input';
  constructor(readonly fields: string[]) { super('Use the published EIGOS task input contract'); }
}

/** Compatibility for an explicit shared user assertion, never an inferred
 * location or permission. Conflicting/missing provenance still rejects. */
function locationContext(input: unknown): unknown {
  const parsed = object.safeParse(input);
  if (!parsed.success || parsed.data.source !== 'user_provided') return input;
  const { source, ...context } = parsed.data;
  for (const role of ['origin', 'destination']) {
    const endpoint = object.safeParse(context[role]);
    if (!endpoint.success) continue;
    if (endpoint.data.source !== undefined && endpoint.data.source !== source)
      throw new AgentTaskInputError([`locationContext.${role}.source`]);
    context[role] = { ...endpoint.data, source };
  }
  return context;
}

/** Validate before opening credentials or the network. Keep the business goal,
 * message ID and caller facts; no Action plan or authority is manufactured. */
export function prepareA2ATaskRequest(input: unknown) {
  try { return prepareRequest(input); }
  catch (error) {
    if (error instanceof z.ZodError) throw new AgentTaskInputError([...new Set(error.issues.map(issue => issue.path.join('.') || 'request'))]);
    throw error;
  }
}

function prepareRequest(input: unknown) {
  const request = requestSchema.parse(input);
  if (request.method !== 'SendMessage') return request;
  const message = object.parse(request.params.message);
  if (typeof message.messageId !== 'string' || !message.messageId) throw new AgentTaskInputError(['message.messageId']);
  // Continuations retain their existing operation-specific contracts.
  if (message.taskId) return request;
  const parts = z.array(object).parse(message.parts);
  if (parts.length !== 1 || !Object.hasOwn(parts[0]!, 'data')) return request;
  const data = object.parse(parts[0]!.data);
  const normalized: Record<string, unknown> = { ...data, ...(data.locationContext === undefined ? {} : { locationContext: locationContext(data.locationContext) }) };
  const contract = normalized.service === 'eigos.aftersales' ? submitSchema.options[1] : submitSchema.options[0];
  const checked = contract.safeParse({ ...normalized, requestId: message.messageId });
  if (!checked.success) {
    const fields = checked.error.issues.map(issue => issue.path.join('.'));
    throw new AgentTaskInputError([...new Set(fields.filter(Boolean))]);
  }
  return { ...request, params: { ...request.params, message: { ...message, parts: [{ ...parts[0]!, data: normalized }] } } };
}
