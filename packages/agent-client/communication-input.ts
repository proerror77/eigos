import { randomUUID } from 'node:crypto';
import { SendMessageRequest } from '@a2a-js/sdk';
import { COMMUNICATION_SCHEMA, messagingOperationSchema } from '../agent-messaging/contracts.js';

export class AgentCommunicationInputError extends Error {
  readonly code = 'invalid_communication_input';
  constructor() { super('Invalid communication operation'); }
}

/** Communication never goes through the business-task input adapter. */
export function prepareA2ACommunicationRequest(input: unknown) {
  try {
    const operation = messagingOperationSchema.parse(input);
    return SendMessageRequest.fromJSON({ message: { messageId: 'requestId' in operation ? operation.requestId : randomUUID(),
      role: 'ROLE_USER', parts: [{ data: { schema: COMMUNICATION_SCHEMA, operation } }] } });
  } catch { throw new AgentCommunicationInputError(); }
}
