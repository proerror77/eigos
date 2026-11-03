import { digest } from '../core/delegation.js';
import { DomainError, ownerKey } from '../core/domain.js';
import type { JobStore } from '../core/store.js';
import type { TaskServicePort } from '../core/task-service-port.js';
import type { Principal } from '../core/domain.js';
import { SecurityError } from '../security/store.js';
import { TaskSecurity, type TaskView } from '../security/task-service.js';
import { RelayError } from '../relay/contracts.js';
import type { ReceivedMessage, RelayClient } from './client.js';
import { TASK_RELAY_PROTOCOL, taskRelayRequestSchema, type TaskRelayResponse } from './task-contracts.js';

type Awaitable<T>=T|Promise<T>;
export type TaskRelayTransport=Pick<RelayClient,'agentId'|'peer'|'ensureContact'|'respondContact'|'contacts'|'queue'|'deliver'|'listen'|'register'|'renew'>&{close():Awaitable<void>};
export interface TaskRelayHostPort {
  readonly authorityId:string;
  authorityCurrent():Awaitable<boolean>;
  principal(agentId:string):Awaitable<Principal>;
  command(agentId:string,requestId:string,inputDigest:string):Awaitable<string>;
  project(principal:Principal,taskId:string):Awaitable<TaskView>;
}
export type TaskRelayTasks=Pick<TaskServicePort,'submit'|'reply'|'cancel'|'get'>;

/** Transport adapter only: all tasks, grants and projections remain in the primary authority. */
export class TaskRelayHost {
  private readonly port:TaskRelayHostPort;
  constructor(store:JobStore|TaskRelayHostPort,private tasks:TaskRelayTasks,readonly client:TaskRelayTransport,readonly authorityId:string){
    if('security'in store){
      if(!store.security.enabled||store.authority?.id!==authorityId)throw new Error('Task Relay requires the primary Foundation authority');
      const projection=new TaskSecurity(store);
      this.port={authorityId,authorityCurrent:()=>store.authorityCurrent(),principal:id=>store.security.relay.principal(id),command:(id,request,hash)=>store.security.relay.command(id,request,hash),project:(p,id)=>projection.project(p,store.get(ownerKey(p),id))};
    }else{
      if(store.authorityId!==authorityId)throw new Error('Task Relay requires the same primary authority');this.port=store;
    }
  }

  async handle(message: ReceivedMessage, signal: AbortSignal): Promise<void> {
    const parsed = taskRelayRequestSchema.safeParse(message.content);
    // Ignore other protocols and malformed traffic without echoing private input.
    if (!parsed.success) return;
    const request = parsed.data;
    let task: TaskView | undefined, error: TaskRelayResponse['error'];
    const current = async () => {
      signal.throwIfAborted();
      if (Date.now() >= message.expiresAt) throw new SecurityError('AUTHORIZATION_REQUIRED');
      if (!await this.port.authorityCurrent() || this.port.authorityId !== request.authorityId || request.authorityId !== this.authorityId) throw new SecurityError('AUTHORITY_UNAVAILABLE');
      const principal=await this.port.principal(message.senderId);signal.throwIfAborted();if(Date.now()>=message.expiresAt)throw new SecurityError('AUTHORIZATION_REQUIRED');return principal;
    };
    try {
      const p = await current(), requestId = await this.port.command(message.senderId, request.requestId, digest(request));
      signal.throwIfAborted();if(message.expiresAt<=Date.now())throw new SecurityError('AUTHORIZATION_REQUIRED');
      // Core idempotency survives a crash after task commit but before response/ACK.
      const value = await (request.kind === 'task.submit' ? this.tasks.submit(p, { ...request.input, requestId })
        : request.kind === 'task.reply' ? this.tasks.reply(p, { ...request.input, requestId })
        : request.kind === 'task.cancel' ? this.tasks.cancel(p, request.taskId)
        : this.tasks.get(p, request.taskId));
      task = await this.port.project(p,value.id);
    } catch (cause) {
      if (signal.aborted) throw cause;
      if (cause instanceof SecurityError) error = cause.reason;
      else if (cause instanceof DomainError) error = cause.code === 'CONFLICT' ? 'TASK_CONFLICT' : cause.code === 'INVALID_INPUT' ? 'INVALID_REQUEST' : 'AUTHORIZATION_REQUIRED';
      else throw cause;
    }
    const response: TaskRelayResponse = { protocol: TASK_RELAY_PROTOCOL, kind: 'task.response', authorityId: this.authorityId, requestId: request.requestId,
      ...(task ? { task: { ...task, authorityId: this.authorityId } } : { error: error ?? 'INVALID_REQUEST' }) };
    const check = async () => {
      signal.throwIfAborted();
      if (message.expiresAt <= Date.now()) throw new SecurityError('AUTHORIZATION_REQUIRED');
      if (task) {
        const p = await current(), projected = await this.port.project(p,task.id);
        if (digest(projected) !== digest(task)) throw new SecurityError('POLICY_CHANGED');
        signal.throwIfAborted();if(message.expiresAt<=Date.now())throw new SecurityError('AUTHORIZATION_REQUIRED');
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
