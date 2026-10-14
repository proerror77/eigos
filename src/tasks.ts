import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError, ownerKey, replySchema, requireScope, submitSchema, taskIdSchema, type Job, type Principal } from './domain.js';
import { JobStore, type ListFilter } from './store.js';

export class TaskService {
  constructor(private store: JobStore) {}

  submit(p: Principal, input: unknown, contextId?: string): Job {
    requireScope(p, 'tasks:write');
    const args = submitSchema.parse(input);
    if (contextId) taskIdSchema.parse(contextId);
    const owner = ownerKey(p);
    return this.store.once(owner, 'submit', args.requestId, JSON.stringify([args, contextId]), () => {
      if (contextId && !this.store.hasContext(owner, contextId)) throw new DomainError('NOT_FOUND', 'Context not found');
      const now = new Date().toISOString();
      const job: Job = {
        id: randomUUID(), contextId: contextId || randomUUID(), service: args.service,
        goal: args.goal, deliverable: args.deliverable, state: 'input-required',
        messages: [{ id: args.requestId, role: 'user', text: args.goal, at: now }],
        createdAt: now, updatedAt: now,
      };
      this.prepareBrief(job);
      this.store.save(owner, job);
      return job;
    });
  }

  reply(p: Principal, input: unknown, contextId?: string): Job {
    requireScope(p, 'tasks:write');
    const args = replySchema.parse(input);
    const owner = ownerKey(p);
    const current = this.store.get(owner, args.taskId);
    if (contextId && current.contextId !== contextId) throw new DomainError('INVALID_INPUT', 'Context does not match task');
    return this.store.once(owner, `reply:${args.taskId}`, args.requestId, JSON.stringify(args), () => {
      const job = this.store.get(owner, args.taskId);
      if (job.state !== 'input-required') throw new DomainError('CONFLICT', 'Task is not waiting for input');
      job.deliverable = args.answer;
      job.updatedAt = new Date().toISOString();
      job.messages.push({ id: args.requestId, role: 'user', text: args.answer, at: job.updatedAt });
      this.prepareBrief(job);
      this.store.save(owner, job);
      return job;
    });
  }

  get(p: Principal, id: string): Job {
    requireScope(p, 'tasks:read');
    return this.store.get(ownerKey(p), taskIdSchema.parse(id));
  }

  list(p: Principal, filter: ListFilter): { jobs: Job[]; total: number } {
    requireScope(p, 'tasks:read');
    z.number().int().min(1).max(100).parse(filter.limit);
    z.number().int().min(0).max(1_000_000).parse(filter.offset);
    const updatedAfter = filter.updatedAfter
      ? new Date(z.iso.datetime({ offset: true }).parse(filter.updatedAfter)).toISOString()
      : undefined;
    return this.store.list(ownerKey(p), { ...filter, updatedAfter });
  }

  cancel(p: Principal, id: string): Job {
    requireScope(p, 'tasks:write');
    const owner = ownerKey(p);
    taskIdSchema.parse(id);
    return this.store.once(owner, `cancel:${id}`, id, id, () => {
      const job = this.store.get(owner, id);
      if (job.state === 'completed') throw new DomainError('CONFLICT', 'Completed tasks cannot be canceled');
      job.state = 'canceled';
      delete job.question;
      job.updatedAt = new Date().toISOString();
      job.messages.push({ id: randomUUID(), role: 'agent', text: 'Task canceled.', at: job.updatedAt });
      this.store.save(owner, job);
      return job;
    });
  }

  // A deliberately bounded reference capability, not a simulated business executor.
  private prepareBrief(job: Job): void {
    if (!job.deliverable) {
      job.question = 'What deliverable and acceptance criteria should this task brief record?';
      job.messages.push({ id: randomUUID(), role: 'agent', text: job.question, at: job.updatedAt });
      return;
    }
    delete job.question;
    job.state = 'completed';
    job.artifact = {
      id: randomUUID(), name: 'task-brief.json',
      data: { goal: job.goal, deliverable: job.deliverable, execution: 'not_started' },
    };
    job.messages.push({ id: randomUUID(), role: 'agent', text: 'Task brief prepared. The underlying business goal has not been executed.', at: job.updatedAt });
  }
}
