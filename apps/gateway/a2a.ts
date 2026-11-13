import { AgentCard, Task as A2ATask, type SendMessageRequest, type GetTaskRequest, type CancelTaskRequest, type ListTasksRequest, type StreamResponse } from '@a2a-js/sdk';
import type { A2ARequestHandler, ServerCallContext, User } from '@a2a-js/sdk/server';
import { UnsupportedOperationError, PushNotificationNotSupportedError, ExtendedAgentCardNotConfiguredError, RequestMalformedError } from '@a2a-js/sdk/errors';
import type { Principal } from '../../packages/core/identity.js';
import { PARequests } from '../../packages/runtime/pa.js';
import { Tasks, type Task } from '../../packages/runtime/tasks.js';

export class AgentUser implements User {
  readonly isAuthenticated = true;
  constructor(readonly principal: Principal) {}
  get userName() { return this.principal.owner; }
}
const states: Record<string, string> = { submitted: 'TASK_STATE_SUBMITTED', working: 'TASK_STATE_WORKING', completed: 'TASK_STATE_COMPLETED', failed: 'TASK_STATE_FAILED', canceled: 'TASK_STATE_CANCELED', 'input-required': 'TASK_STATE_INPUT_REQUIRED' };
const taskView = (task: Task) => A2ATask.fromJSON({ id: task.id, contextId: task.id, status: { state: states[task.state], timestamp: task.updated_at.toISOString() },
  artifacts: task.result ? [{ artifactId: task.id, name: 'Task result', parts: [{ data: task.result, mediaType: 'application/json' }] }] : [], metadata: { error: task.error } });
export function agentCard(url: string) {
  return AgentCard.fromJSON({ name: 'EIGOS', description: 'Source-backed inquiries and calendar-backed scenario scheduling through Ontology queries, functions and actions.', version: '0.2.0',
    supportedInterfaces: [{ url: url + '/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }], capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['text/plain', 'application/json'], defaultOutputModes: ['application/json'],
    skills: [{ id: 'rideEstimate', name: 'Ride estimate', description: 'Find route endpoints and return provider price estimates.', tags: ['ride', 'estimate'] },{id:'calendarPlanning',name:'Calendar planning',description:'Request calendar availability from the original PA and compare scheduling scenarios without external calendar writes.',tags:['calendar','scheduling','scenario']}],
    securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } }, securityRequirements: [{ schemes: { bearer: { list: [] } } }] });
}
export class A2A implements A2ARequestHandler {
  constructor(private readonly tasks: Tasks, private readonly card: AgentCard) {}
  private principal(context: ServerCallContext) {
    if (!(context.user instanceof AgentUser)) throw new RequestMalformedError('Authenticated user required');
    return context.user.principal;
  }
  async getAgentCard() { return this.card; }
  async sendMessage(params: SendMessageRequest, context: ServerCallContext) {
    const message = params.message;
    if (!message?.messageId) throw new RequestMalformedError('Message ID is required');
    const text = message.parts.flatMap(part => part.content?.$case === 'text' ? [part.content.value] : []).join('\n');
    const dataPart = message.parts.find(part => part.content?.$case === 'data')?.content;
    const data = dataPart?.$case === 'data' ? dataPart.value as Record<string, unknown> : undefined;
    if (message.taskId) {
      if (!data?.paResponse) throw new RequestMalformedError('Continuation requires the PA response for the original task');
      return taskView(await new PARequests(this.tasks).respond(this.principal(context),message.taskId,data.paResponse));
    }
    if (data?.paResponse) throw new RequestMalformedError('PA response requires the original taskId');
    const task = await this.tasks.submit(this.principal(context), { requestId: message.messageId, message: text || data?.message, route: data?.route });
    return taskView(task);
  }
  async getTask(params: GetTaskRequest, context: ServerCallContext) { return taskView(await this.tasks.get(this.principal(context), params.id)); }
  async cancelTask(params: CancelTaskRequest, context: ServerCallContext) { return taskView(await this.tasks.cancel(this.principal(context), params.id)); }
  async listTasks(_params: ListTasksRequest): Promise<never> { throw new UnsupportedOperationError('Use GetTask with the submitted task ID'); }
  async getAuthenticatedExtendedAgentCard(): Promise<never> { throw new ExtendedAgentCardNotConfiguredError(); }
  async *sendMessageStream(): AsyncGenerator<StreamResponse, void, undefined> { throw new UnsupportedOperationError('Streaming is unavailable'); }
  async *resubscribe(): AsyncGenerator<StreamResponse, void, undefined> { throw new UnsupportedOperationError('Subscriptions are unavailable'); }
  async createTaskPushNotificationConfig(): Promise<never> { throw new PushNotificationNotSupportedError(); }
  async getTaskPushNotificationConfig(): Promise<never> { throw new PushNotificationNotSupportedError(); }
  async listTaskPushNotificationConfigs(): Promise<never> { throw new PushNotificationNotSupportedError(); }
  async deleteTaskPushNotificationConfig(): Promise<never> { throw new PushNotificationNotSupportedError(); }
}
