import { z } from 'zod';
import { Conflict, ProviderAuthorizationRequired, ProviderReadAuthorizationRequired, digest } from '../core/identity.js';
import { json } from '../ontology/service-contracts.js';
import { ActionPARequestRequired, PARequestRequired } from './clarification.js';
import { PARequests } from './pa.js';
import type { Task, Tasks } from './tasks.js';

const connectionStatus = z.strictObject({ status: z.enum(['connected', 'declined', 'unavailable']) });

/** A PA response is a signal to recheck the owner connection. It grants no provider authority. */
export async function requestProviderAuthorization(
  error: ProviderAuthorizationRequired | ProviderReadAuthorizationRequired, operation: string, { task, tasks }: { task: Task; tasks: Tasks },
): Promise<Error> {
  if (task.cognitive_context || task.input.scheduledAction) return error;
  let response: z.infer<typeof connectionStatus>;
  try {
    response = connectionStatus.parse(await new PARequests(tasks).request(task,
      digest([operation, error.provider, task.execution_step ?? 0]), 'provider.authorize', {
        provider: error.provider, operation,
        instruction: 'Check the requesting user’s authorized connection for this provider. Help the user connect it privately and leave this request pending until the connection is ready. Send only the connection status through this task. Do not send API keys, logins, or credentials to EIGOS or ask for them in chat. This request does not approve a purchase or provider write.',
      }, json(connectionStatus)));
  } catch (cause) {
    if (cause instanceof PARequestRequired) return new ActionPARequestRequired(cause.message, cause.choices, cause.permissions);
    throw cause;
  }
  // The action was run again before reaching here. A PA claim cannot replace a failed connection check.
  if (response.status === 'connected') return new Conflict(error.message);
  return new Conflict(`${error.provider} connection authorization was ${response.status}`);
}
