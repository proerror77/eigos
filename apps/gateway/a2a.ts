import { AgentCard, Task, TaskState, Role, type SendMessageRequest, type GetTaskRequest, type CancelTaskRequest, type ListTasksRequest, type ListTasksResponse, type StreamResponse } from '@a2a-js/sdk';
import type { A2ARequestHandler, ServerCallContext, User } from '@a2a-js/sdk/server';
import { ContentTypeNotSupportedError, ExtendedAgentCardNotConfiguredError, PushNotificationNotSupportedError, RequestMalformedError, TaskNotCancelableError, TaskNotFoundError, UnsupportedOperationError } from '@a2a-js/sdk/errors';
import { z } from 'zod';
import type { Config } from '../../packages/core/config.js';
import { DomainError, SERVICES, ownerKey, submitSchema, replySchema, type Job, type JobState, type Principal } from '../../packages/core/domain.js';
import { TaskService } from '../../packages/core/tasks.js';

export class AgentUser implements User {
  readonly isAuthenticated = true;
  constructor(readonly principal: Principal) {}
  get userName(): string { return ownerKey(this.principal); }
}

const states: Record<JobState, TaskState> = {
  submitted: TaskState.TASK_STATE_SUBMITTED,
  'auth-required': TaskState.TASK_STATE_AUTH_REQUIRED,
  rejected: TaskState.TASK_STATE_REJECTED,
  'input-required': TaskState.TASK_STATE_INPUT_REQUIRED,
  completed: TaskState.TASK_STATE_COMPLETED,
  canceled: TaskState.TASK_STATE_CANCELED,
  working: TaskState.TASK_STATE_WORKING,
  failed: TaskState.TASK_STATE_FAILED,
};

function toTask(job: Job, historyLength?: number): Task {
  if (historyLength !== undefined) z.number().int().min(0).max(1000).parse(historyLength);
  const messages = job.messages.map(message => ({
    messageId: message.id, contextId: job.contextId, taskId: job.id,
    role: message.role === 'user' ? 'ROLE_USER' : 'ROLE_AGENT',
    parts: [{ text: message.text }],
  }));
  return Task.fromJSON({
    id: job.id, contextId: job.contextId,
    status: { state: states[job.state], timestamp: job.updatedAt, message: messages.at(-1) },
    history: historyLength === undefined ? messages : historyLength === 0 ? [] : messages.slice(-historyLength),
    artifacts: job.artifact ? [{ artifactId: job.artifact.id, name: job.artifact.name, parts: job.artifact.data.markdown
      ? [{ text: job.artifact.data.markdown, mediaType: 'text/markdown' }]
      : [{ data: job.artifact.data, mediaType: 'application/json' }] }] : [],
    metadata: { service: job.service, ...(job.pilot ? { pilot: job.pilot } : {}), ...(job.delegation ? { delegation: job.delegation } : {}), ...(job.runs ? { runs: job.runs } : {}), ...(job.error ? { error: job.error } : {}) },
  });
}

export function agentCard(c: Config, services = SERVICES): AgentCard {
  return AgentCard.fromJSON({
    name: 'EIGOS', version: '0.1.0',
    description: 'Delegate only tasks matching the enabled skills below. EIGOS preserves task identity, asks for missing inputs and returns service-specific deliverables. Use explicit service IDs in structured submissions. Connecting this agent does not authorize purchases, sending or payments. No general shopping or coffee ordering capability is currently available.',
    supportedInterfaces: [{ url: `${c.PUBLIC_URL}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    documentationUrl: 'https://github.com/proerror77/eigos',
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: ['text/plain', 'application/json'], defaultOutputModes: ['text/plain', 'application/json', 'text/markdown'],
    securitySchemes: {
      eigos: c.EIGOS_AUTH_MODE === 'jwt'
        ? { openIdConnectSecurityScheme: { openIdConnectUrl: `${c.OAUTH_ISSUER!.replace(/\/$/, '')}/.well-known/openid-configuration` } }
        : { httpAuthSecurityScheme: { scheme: 'Bearer', bearerFormat: 'opaque', description: 'Loopback-only development credential' } },
    },
    securityRequirements: [{ schemes: { eigos: { list: c.EIGOS_AUTH_MODE === 'jwt' ? ['tasks:read', 'tasks:write'] : [] } } }],
    skills: services.map(service => ({
      id: service.id, name: service.name, description: service.description,
      tags: service.tags, examples: service.examples,
      inputModes: service.inputModes, outputModes: service.outputModes,
    })),
  });
}

export class A2AGateway implements A2ARequestHandler {
  constructor(private tasks: TaskService, private card: AgentCard) {}
  async getAgentCard(): Promise<AgentCard> { return this.card; }

  private principal(ctx: ServerCallContext, tenant?: string): Principal {
    if (!(ctx.user instanceof AgentUser)) throw new RequestMalformedError('Authenticated principal required');
    if ((tenant && tenant !== ctx.user.principal.tenant) || (ctx.tenant && ctx.tenant !== ctx.user.principal.tenant)) {
      throw new TaskNotFoundError();
    }
    return ctx.user.principal;
  }

  private adapt<T>(action: () => T, cancel = false): T {
    try { return action(); } catch (error) {
      if (error instanceof DomainError) {
        if (error.code === 'NOT_FOUND') throw new TaskNotFoundError();
        if (cancel && error.code === 'CONFLICT') throw new TaskNotCancelableError(error.message);
        throw new RequestMalformedError(error.message);
      }
      if (error instanceof z.ZodError) throw new RequestMalformedError('Invalid task input');
      throw error;
    }
  }

  async sendMessage(params: SendMessageRequest, ctx: ServerCallContext): Promise<Task> {
    const job = this.adapt(() => {
      const p = this.principal(ctx, params.tenant);
      const message = params.message;
      if (!message || message.role !== Role.ROLE_USER || !message.messageId) throw new RequestMalformedError('A user message with messageId is required');
      if (params.configuration?.taskPushNotificationConfig) throw new PushNotificationNotSupportedError();
      const modes = params.configuration?.acceptedOutputModes;
      if (modes?.length && !modes.some(mode => ['text/plain', 'application/json', 'text/markdown'].includes(mode))) throw new ContentTypeNotSupportedError();
      const length = params.configuration?.historyLength;
      // Validate response controls before any mutation.
      if (length !== undefined) z.number().int().min(0).max(1000).parse(length);
      if (message.referenceTaskIds.length || message.extensions.length) throw new RequestMalformedError('Task references and message extensions are not supported');
      const parts = message.parts;
      let input: unknown;
      if (parts.length === 1 && parts[0]?.content?.$case === 'data') {
        input = parts[0].content.value;
      } else if (parts.length && parts.every(part => part.content?.$case === 'text')) {
        const text = parts.map(part => part.content?.value).join('\n');
        input = message.taskId ? { answer: text } : { goal: text, service: this.tasks.services().some(s => s.id === 'eigos.delegate') ? 'eigos.delegate' : this.tasks.services().some(s => s.id === 'agent.execute') ? 'agent.execute' : 'brief.prepare' };
      } else throw new ContentTypeNotSupportedError('Use text parts or a single structured data part');
      let job: Job;
      if (message.taskId) {
        const answer = replySchema.parse({ ...(input as object), taskId: message.taskId, requestId: message.messageId });
        job = this.tasks.reply(p, answer, message.contextId || undefined);
      } else {
        const data = submitSchema.parse({ ...(input as object), requestId: message.messageId });
        job = this.tasks.submit(p, { ...data, requestId: message.messageId }, message.contextId || undefined);
      }
      return job;
    });
    if ((job.state === 'working' || job.state === 'submitted') && !params.configuration?.returnImmediately) {
      return toTask(await this.tasks.wait(this.principal(ctx, params.tenant), job.id), params.configuration?.historyLength);
    }
    return toTask(job, params.configuration?.historyLength);
  }

  async getTask(params: GetTaskRequest, ctx: ServerCallContext): Promise<Task> {
    return this.adapt(() => toTask(this.tasks.get(this.principal(ctx, params.tenant), params.id), params.historyLength));
  }

  async cancelTask(params: CancelTaskRequest, ctx: ServerCallContext): Promise<Task> {
    return this.adapt(() => toTask(this.tasks.cancel(this.principal(ctx, params.tenant), params.id)), true);
  }

  async listTasks(params: ListTasksRequest, ctx: ServerCallContext): Promise<ListTasksResponse> {
    return this.adapt(() => {
      const principal = this.principal(ctx, params.tenant);
      if (params.pageToken && !/^\d{1,7}$/.test(params.pageToken)) throw new RequestMalformedError('Invalid page token');
      const limit = params.pageSize ?? 50;
      const offset = Number(params.pageToken || 0);
      const state = (Object.entries(states) as [JobState, TaskState][]).find(([, value]) => value === params.status)?.[0];
      if (params.status !== TaskState.TASK_STATE_UNSPECIFIED && !state) {
        // This gateway never produces other states. Still validate pagination and identity.
        this.tasks.list(principal, { limit, offset });
        return { tasks: [], nextPageToken: '', pageSize: limit, totalSize: 0 };
      }
      const found = this.tasks.list(principal, { limit, offset, state, contextId: params.contextId, updatedAfter: params.statusTimestampAfter });
      return {
        tasks: found.jobs.map(job => {
          const task = toTask(job, params.historyLength);
          if (!params.includeArtifacts) task.artifacts = [];
          return task;
        }),
        nextPageToken: offset + found.jobs.length < found.total ? String(offset + found.jobs.length) : '',
        pageSize: limit, totalSize: found.total,
      };
    });
  }

  async getAuthenticatedExtendedAgentCard(): Promise<never> { throw new ExtendedAgentCardNotConfiguredError(); }
  async *sendMessageStream(): AsyncGenerator<StreamResponse, void, undefined> { throw new UnsupportedOperationError('Streaming is not advertised; use SendMessage and GetTask'); }
  async *resubscribe(): AsyncGenerator<StreamResponse, void, undefined> { throw new UnsupportedOperationError('Subscriptions are not advertised; use GetTask'); }
  async createTaskPushNotificationConfig(): Promise<never> { throw new PushNotificationNotSupportedError(); }
  async getTaskPushNotificationConfig(): Promise<never> { throw new PushNotificationNotSupportedError(); }
  async listTaskPushNotificationConfigs(): Promise<never> { throw new PushNotificationNotSupportedError(); }
  async deleteTaskPushNotificationConfig(): Promise<never> { throw new PushNotificationNotSupportedError(); }
}
