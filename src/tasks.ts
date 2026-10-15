import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError, SERVICES, ownerKey, replySchema, requireScope, submitSchema, taskIdSchema, type Job, type Principal } from './domain.js';
import { JobStore, type ListFilter } from './store.js';
import { decisionSchema, type Executor } from './executor.js';

export class TaskService {
  private running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private stopping = false;
  constructor(private store: JobStore, private executor?: Executor) {}

  services() {
    return this.executor ? [...SERVICES, {
      id: 'agent.execute', name: 'EIGOS document execution agent',
      description: 'A real model reasons over the goal and task history, asks for missing requirements, and produces a complete Markdown document or plan. No external research, sending, bookings or payments.',
      requiredInputs: ['goal'],
    }] : SERVICES;
  }

  private capacity(p: Principal, operation: string, requestId: string): void {
    if (this.stopping) throw new DomainError('CONFLICT', 'Executor is shutting down');
    if (!this.executor) throw new DomainError('INVALID_INPUT', 'agent.execute is not configured');
    if (this.running.size >= 2 && !this.store.hasRequest(ownerKey(p), operation, requestId)) throw new DomainError('CONFLICT', 'Executor is busy; retry this request later');
  }

  submit(p: Principal, input: unknown, contextId?: string): Job {
    requireScope(p, 'tasks:write');
    const args = submitSchema.parse(input);
    if (contextId) taskIdSchema.parse(contextId);
    const owner = ownerKey(p);
    if (args.service === 'agent.execute') this.capacity(p, 'submit', args.requestId);
    const submitted = this.store.once(owner, 'submit', args.requestId, JSON.stringify([args, contextId]), () => {
      if (contextId && !this.store.hasContext(owner, contextId)) throw new DomainError('NOT_FOUND', 'Context not found');
      const now = new Date().toISOString();
      const job: Job = {
        id: randomUUID(), contextId: contextId || randomUUID(), service: args.service,
        goal: args.goal, deliverable: args.deliverable, state: 'input-required',
        messages: [{ id: args.requestId, role: 'user', text: args.goal, at: now }],
        createdAt: now, updatedAt: now,
      };
      if (job.service === 'agent.execute') { job.state = 'working'; job.revision = 1; job.runs = []; }
      else this.prepareBrief(job);
      this.store.save(owner, job);
      return job;
    });
    this.start(p, submitted.id);
    return submitted.service === 'agent.execute' ? this.store.get(owner, submitted.id) : submitted;
  }

  reply(p: Principal, input: unknown, contextId?: string): Job {
    requireScope(p, 'tasks:write');
    const args = replySchema.parse(input);
    const owner = ownerKey(p);
    const current = this.store.get(owner, args.taskId);
    if (contextId && current.contextId !== contextId) throw new DomainError('INVALID_INPUT', 'Context does not match task');
    if (current.service === 'agent.execute') this.capacity(p, `reply:${args.taskId}`, args.requestId);
    const replied = this.store.once(owner, `reply:${args.taskId}`, args.requestId, JSON.stringify(args), () => {
      const job = this.store.get(owner, args.taskId);
      if (job.state !== 'input-required') throw new DomainError('CONFLICT', 'Task is not waiting for input');
      job.updatedAt = new Date().toISOString();
      job.messages.push({ id: args.requestId, role: 'user', text: args.answer, at: job.updatedAt });
      if (job.service === 'agent.execute') {
        job.state = 'working'; job.revision = (job.revision ?? 0) + 1; delete job.question;
      } else { job.deliverable = args.answer; this.prepareBrief(job); }
      this.store.save(owner, job);
      return job;
    });
    this.start(p, replied.id);
    return replied.service === 'agent.execute' ? this.store.get(owner, replied.id) : replied;
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
    const canceled = this.store.once(owner, `cancel:${id}`, id, id, () => {
      const job = this.store.get(owner, id);
      if (job.state === 'completed' || job.state === 'failed') throw new DomainError('CONFLICT', 'Terminal tasks cannot be canceled');
      job.state = 'canceled';
      delete job.question;
      job.updatedAt = new Date().toISOString();
      job.messages.push({ id: randomUUID(), role: 'agent', text: 'Task canceled.', at: job.updatedAt });
      this.store.save(owner, job);
      return job;
    });
    this.running.get(id)?.controller.abort();
    return canceled;
  }

  async wait(p: Principal, id: string): Promise<Job> {
    // Write-only clients may receive the result of their own write operation.
    const owner = ownerKey(p);
    let job = this.store.get(owner, id);
    while (job.state === 'working') {
      const run = this.running.get(id);
      if (!run) throw new DomainError('CONFLICT', 'No active executor for task');
      await run.done;
      job = this.store.get(owner, id);
    }
    return job;
  }

  async close(): Promise<void> {
    this.stopping = true;
    for (const run of this.running.values()) run.controller.abort();
    await Promise.all([...this.running.values()].map(run => run.done));
  }

  private start(p: Principal, id: string): void {
    const owner = ownerKey(p);
    const job = this.store.get(owner, id);
    if (job.service !== 'agent.execute' || job.state !== 'working' || this.running.has(id) || !this.executor) return;
    const controller = new AbortController();
    const run = { controller, done: Promise.resolve() };
    this.running.set(id, run);
    run.done = Promise.resolve().then(async () => {
      if ((job.runs?.length ?? 0) >= 6) throw new Error('Maximum model turns reached');
      const response = await this.executor!.run(structuredClone(job), controller.signal);
      const output = decisionSchema.parse(response.output);
      const current = this.store.get(owner, id);
      if (current.state !== 'working' || current.revision !== job.revision || controller.signal.aborted) return;
      current.updatedAt = new Date().toISOString();
      current.runs = [...(current.runs ?? []), response.evidence];
      current.messages.push({ id: randomUUID(), role: 'agent', text: output.message, at: current.updatedAt });
      if (output.decision === 'ask_user') {
        current.state = 'input-required'; current.question = output.message;
      } else {
        current.state = 'completed'; delete current.question;
        current.artifact = { id: randomUUID(), name: 'deliverable.md', data: {
          goal: current.goal, deliverable: output.message, execution: 'completed', markdown: output.artifact,
        } };
      }
      this.store.save(owner, current);
    }).catch(error => {
      const current = this.store.get(owner, id);
      if (current.state !== 'working' || current.revision !== job.revision) return;
      current.state = 'failed'; current.updatedAt = new Date().toISOString();
      current.error = error instanceof z.ZodError ? 'Executor output did not match the required schema' : error instanceof Error ? error.message : 'Executor failed';
      current.messages.push({ id: randomUUID(), role: 'agent', text: current.error, at: current.updatedAt });
      this.store.save(owner, current);
    }).finally(() => { this.running.delete(id); });
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
