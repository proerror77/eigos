import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { RelayClient } from '../agent-transport/client.js';
import { TASK_RELAY_PROTOCOL, taskRelayRequestSchema, taskRelayResponseSchema, type TaskRelayRequest } from '../agent-transport/task-contracts.js';
import type { AgentConnector } from './client.js';

type WithoutDestination<T> = T extends TaskRelayRequest ? Omit<T, 'protocol' | 'authorityId'> : never;
export type TaskRelayCommand = WithoutDestination<TaskRelayRequest>;

export class TaskRelayError extends Error { constructor(readonly code: string) { super(code); } }

/** Host-side PA adapter. Model arguments never contain OAuth or node credentials. */
export class TaskRelayClient {
  private binding?: Awaited<ReturnType<AgentConnector['bindTaskRelay']>>;
  #agent: AgentConnector;
  constructor(readonly node: RelayClient, agent: AgentConnector) { this.#agent = agent; }
  async bind() { return this.binding = await this.#agent.bindTaskRelay(this.node); }

  /** Keep requestId for business retries; a fresh messageId permits retry after transport expiry. */
  async send(request: TaskRelayCommand, options: { messageId?: string; signal?: AbortSignal } = {}) {
    if (!this.binding || this.binding.expiresAt <= Date.now() + 10000) await this.bind();
    const binding = this.binding!;
    const content = taskRelayRequestSchema.parse({ ...request, protocol: TASK_RELAY_PROTOCOL, authorityId: binding.authorityId });
    const id = await this.node.queue(binding.gatewayAgentId, binding.connectionId, content,
      { id: options.messageId ?? randomUUID(), expiresAt: Math.min(binding.expiresAt, Date.now() + 600000) });
    const receipt = await this.node.deliver(id, { signal: options.signal, beforeSend: () => {
      if (binding.expiresAt <= Date.now()) throw new TaskRelayError('binding_expired');
    } });
    return { requestId: content.requestId, messageId: id, receipt };
  }

  async receive(requestId: string, signal: AbortSignal) {
    z.uuid().parse(requestId);
    if (!this.binding) await this.bind();
    const binding = this.binding!;
    while (!signal.aborted) {
      const messages = await this.node.poll({ waitSeconds: 1, signal });
      for (const message of messages) {
        if (message.senderId !== binding.gatewayAgentId || message.connectionId !== binding.connectionId) continue;
        const parsed = taskRelayResponseSchema.safeParse(message.content);
        if (!parsed.success || parsed.data.requestId !== requestId) continue;
        const contact = (await this.node.contacts()).find(c => c.id === binding.connectionId && c.state === 'accepted');
        await this.node.peer(binding.gatewayAgentId);
        signal.throwIfAborted();
        if (!contact || message.expiresAt <= Date.now() || parsed.data.authorityId !== binding.authorityId
          || parsed.data.task && parsed.data.task.authorityId !== binding.authorityId) throw new TaskRelayError('response_authority_mismatch');
        this.node.markHandled(message.senderId, message.id);
        if (parsed.data.error) throw new TaskRelayError(parsed.data.error);
        return parsed.data.task!;
      }
      await delay(50, undefined, { signal });
    }
    signal.throwIfAborted();
    throw new TaskRelayError('receive_stopped');
  }
}
