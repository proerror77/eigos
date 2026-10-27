import { digest } from '../core/delegation.js';
import { DomainError, ownerKey } from '../core/domain.js';
import type { JobStore } from '../core/store.js';
import type { TaskService } from '../core/tasks.js';
import { SecurityError } from '../security/store.js';
import { TaskSecurity, type TaskView } from '../security/task-service.js';
import { RelayError } from '../relay/contracts.js';
import { type ReceivedMessage, RelayClient } from './client.js';
import { TASK_RELAY_PROTOCOL, taskRelayRequestSchema, type TaskRelayResponse } from './task-contracts.js';

/** Transport adapter only: all tasks, grants and projections remain in the primary authority. */
export class TaskRelayHost {
  private projection: TaskSecurity;
  constructor(private store: JobStore, private tasks: TaskService, readonly client: RelayClient, readonly authorityId: string) {
    if (!store.security.enabled || store.authority?.id !== authorityId) throw new Error('Task Relay requires the primary Foundation authority');
    this.projection = new TaskSecurity(store);
  }

  async handle(message: ReceivedMessage, signal: AbortSignal): Promise<void> {
    const parsed = taskRelayRequestSchema.safeParse(message.content);
    // Ignore other protocols and malformed traffic without echoing private input.
    if (!parsed.success) return;
    const request = parsed.data;
    let task: TaskView | undefined, error: TaskRelayResponse['error'];
    const current = () => {
      signal.throwIfAborted();
      if (Date.now() >= message.expiresAt) throw new SecurityError('AUTHORIZATION_REQUIRED');
      if (!this.store.authorityCurrent() || this.store.authority?.id !== request.authorityId || request.authorityId !== this.authorityId) throw new SecurityError('AUTHORITY_UNAVAILABLE');
      return this.store.security.relay.principal(message.senderId);
    };
    try {
      const p = current(), requestId = this.store.security.relay.command(message.senderId, request.requestId, digest(request));
      // Core idempotency survives a crash after task commit but before response/ACK.
      const value = request.kind === 'task.submit' ? this.tasks.submit(p, { ...request.input, requestId })
        : request.kind === 'task.reply' ? this.tasks.reply(p, { ...request.input, requestId })
        : request.kind === 'task.cancel' ? this.tasks.cancel(p, request.taskId)
        : this.tasks.get(p, request.taskId);
      task = this.projection.project(p, this.store.get(ownerKey(p), value.id));
    } catch (cause) {
      if (signal.aborted) throw cause;
      if (cause instanceof SecurityError) error = cause.reason;
      else if (cause instanceof DomainError) error = cause.code === 'CONFLICT' ? 'TASK_CONFLICT' : cause.code === 'INVALID_INPUT' ? 'INVALID_REQUEST' : 'AUTHORIZATION_REQUIRED';
      else throw cause;
    }
    const response: TaskRelayResponse = { protocol: TASK_RELAY_PROTOCOL, kind: 'task.response', authorityId: this.authorityId, requestId: request.requestId,
      ...(task ? { task: { ...task, authorityId: this.authorityId } } : { error: error ?? 'INVALID_REQUEST' }) };
    const check = () => {
      signal.throwIfAborted();
      if (message.expiresAt <= Date.now()) throw new SecurityError('AUTHORIZATION_REQUIRED');
      if (task) {
        const p = current(), projected = this.projection.project(p, this.store.get(ownerKey(p), task.id));
        if (digest(projected) !== digest(task)) throw new SecurityError('POLICY_CHANGED');
      }
    };
    let id: string;
    try { id = await this.client.queue(message.senderId, message.connectionId, response, { expiresAt: message.expiresAt }); }
    catch (cause) {
      if (!(cause instanceof RelayError) || cause.code !== 'CONTENT_TOO_LARGE') throw cause;
      id = await this.client.queue(message.senderId, message.connectionId, { ...response, task: undefined, error: 'RESULT_TOO_LARGE' }, { expiresAt: message.expiresAt });
    }
    // Never flush an old cached business result after rebind, revocation or task change.
    await this.client.deliver(id, { signal, beforeSend: check });
  }
}
