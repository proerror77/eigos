import { AgentCard, Task as A2ATask, type SendMessageRequest, type GetTaskRequest, type CancelTaskRequest, type ListTasksRequest, type StreamResponse } from '@a2a-js/sdk';
import type { A2ARequestHandler, ServerCallContext, User } from '@a2a-js/sdk/server';
import { UnsupportedOperationError, PushNotificationNotSupportedError, ExtendedAgentCardNotConfiguredError, RequestMalformedError, TaskNotFoundError, TaskNotCancelableError, A2AError } from '@a2a-js/sdk/errors';
import type { Principal } from '../../packages/core/identity.js';
import type { Sql } from '../../packages/runtime/database.js';
import { PARequests } from '../../packages/runtime/pa.js';
import { Tasks, type Task, type TaskResultProjection } from '../../packages/runtime/tasks.js';
import { publicError } from './public-error.js';

export class AgentUser implements User {
  readonly isAuthenticated = true;
  constructor(readonly principal: Principal, readonly authorizeSubmission?: (client: Sql) => Promise<void>) {}
  get userName() { return this.principal.owner; }
}
const states: Record<string, string> = { submitted: 'TASK_STATE_SUBMITTED', working: 'TASK_STATE_WORKING', completed: 'TASK_STATE_COMPLETED', failed: 'TASK_STATE_FAILED', canceled: 'TASK_STATE_CANCELED', 'input-required': 'TASK_STATE_INPUT_REQUIRED' };
const taskView = (task: Task, projectResult: TaskResultProjection) => {
  const result = projectResult(task.result);
  return A2ATask.fromJSON({ id: task.id, contextId: task.conversation_id ?? task.id, status: { state: states[task.state], timestamp: task.updated_at.toISOString() },
    artifacts: result ? [{ artifactId: task.id, name: 'Task result', parts: [{ data: result, mediaType: 'application/json' }] }] : [], metadata: { error: task.error } });
};
export function agentCard(url: string) {
  return AgentCard.fromJSON({ name: 'EIGOS', description: 'Source-backed inquiries and calendar-backed scenario scheduling through Ontology queries, functions and actions.', version: '0.2.0',
    supportedInterfaces: [{ url: url + '/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }], capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['text/plain', 'application/json'], defaultOutputModes: ['application/json'],
    skills: [{ id: 'rideEstimate', name: 'Ride estimate', description: 'Find route endpoints and return provider price estimates.', tags: ['ride', 'estimate'] },{id:'calendarPlanning',name:'Calendar planning',description:'Request calendar availability from the original PA and compare scheduling scenarios without external calendar writes.',tags:['calendar','scheduling','scenario']}],
    securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } }, securityRequirements: [{ schemes: { bearer: { list: [] } } }] });
}
export class A2A implements A2ARequestHandler {
  constructor(private readonly tasks: Tasks, private readonly card: AgentCard, private readonly projectResult: TaskResultProjection) {}
  private user(context: ServerCallContext) {
    if (!(context.user instanceof AgentUser)) throw new RequestMalformedError('Authenticated user required');
    return context.user;
  }
  async getAgentCard() { return this.card; }
  private async task(operation: () => Promise<Task>, cancel = false) {
    try {
      return taskView(await operation(), this.projectResult);
    } catch (error) {
      if (error instanceof A2AError) throw error;
      const { status, message, requestId } = publicError(error);
      if (status === 404) throw new TaskNotFoundError(message);
      if (status === 409 && cancel) throw new TaskNotCancelableError(message);
      if (status < 500) throw new RequestMalformedError(message);
      throw new Error(requestId ? `${message} (request ID: ${requestId})` : message);
    }
  }
  async sendMessage(params: SendMessageRequest, context: ServerCallContext) {
    return this.task(async () => {
      const message = params.message;
      if (!message?.messageId) throw new RequestMalformedError('Message ID is required');
      const text = message.parts.flatMap(part => part.content?.$case === 'text' ? [part.content.value] : []).join('\n');
      const { principal, authorizeSubmission } = this.user(context);
      if (principal.memberAccess) {
        if (message.taskId || !text.trim() || message.parts.some(part => part.content?.$case !== 'text'))
          throw new RequestMalformedError('Send a new text request or use GetTask for an existing task');
        return this.tasks.submit(principal, { requestId: message.messageId, message: text,
          conversationId: message.contextId || undefined }, { assignConversation: true, authorize: authorizeSubmission });
      }
      const dataPart = message.parts.find(part => part.content?.$case === 'data')?.content;
      const data = dataPart?.$case === 'data' ? dataPart.value as Record<string, unknown> : undefined;
      if (message.taskId) {
        if (!data?.paResponse) throw new RequestMalformedError('Continuation requires the PA response for the original task');
        return new PARequests(this.tasks).respond(principal, message.taskId, data.paResponse, message.contextId || undefined);
      }
      if (data?.paResponse) throw new RequestMalformedError('PA response requires the original taskId');
      return this.tasks.submit(principal, { requestId: message.messageId, message: text || data?.message,
        route: data?.route, classification: data?.classification, conversationId: message.contextId || undefined },
        { assignConversation: true });
    });
  }
  async getTask(params: GetTaskRequest, context: ServerCallContext) {
    return this.task(() => this.tasks.get(this.user(context).principal, params.id));
  }
  async cancelTask(params: CancelTaskRequest, context: ServerCallContext) {
    return this.task(() => this.tasks.cancel(this.user(context).principal, params.id), true);
  }
  async listTasks(_params: ListTasksRequest): Promise<never> { throw new UnsupportedOperationError('Use GetTask with the submitted task ID'); }
  async getAuthenticatedExtendedAgentCard(): Promise<never> { throw new ExtendedAgentCardNotConfiguredError(); }
  async *sendMessageStream(): AsyncGenerator<StreamResponse, void, undefined> { throw new UnsupportedOperationError('Streaming is unavailable'); }
  async *resubscribe(): AsyncGenerator<StreamResponse, void, undefined> { throw new UnsupportedOperationError('Subscriptions are unavailable'); }
  async createTaskPushNotificationConfig(): Promise<never> { throw new PushNotificationNotSupportedError(); }
  async getTaskPushNotificationConfig(): Promise<never> { throw new PushNotificationNotSupportedError(); }
  async listTaskPushNotificationConfigs(): Promise<never> { throw new PushNotificationNotSupportedError(); }
  async deleteTaskPushNotificationConfig(): Promise<never> { throw new PushNotificationNotSupportedError(); }
}
