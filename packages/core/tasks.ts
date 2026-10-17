import { DELEGATE } from './delegation.js';
import type { ExecutionCatalog } from './catalog.js';
import { BACKEND_VERSION } from '../ontology/execution.js';
import { validatePlan } from '../coordinator/plan.js';
import { prepareBrief } from '../capabilities/brief.js';
import { SERVICE_CATALOG } from './services.js';
import { loadCsvFile } from '../capabilities/pilot/csv-file.js';
import { PILOT } from '../capabilities/pilot/contracts.js';
import type { PilotCommands } from '../capabilities/pilot/commands.js';
import { orderQuerySchema, paotuiQuerySchema } from '../capabilities/paotui-contracts.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError, ownerKey, replySchema, requireScope, submitSchema, taskIdSchema, type Job, type Principal } from './domain.js';
import { JobStore, type ListFilter } from './store.js';
import { setTimeout as delay } from 'node:timers/promises';
import { LIFE_INTAKE, receiveLifeRequest, refreshLifeReceipt } from '../capabilities/life-intake.js';

export interface TaskOptions { catalog?: ExecutionCatalog; coordinator?: boolean; lifeIntake?: boolean; waitTimeoutMs?: number; csvInputDirectory?: string; agent?: boolean; paotui?: boolean; paotuiOrders?: boolean; pilot?: PilotCommands }

export class TaskService {
  private stopping = false;
  constructor(private store: JobStore, private options: TaskOptions = {}) {
    if (options.coordinator && !options.catalog) throw new Error('Ontology backend requires an execution catalogue');
  }

  services() {
    if (this.options.coordinator && this.options.catalog) return [this.options.catalog.delegationService(), ...(this.options.lifeIntake ? [structuredClone(SERVICE_CATALOG[LIFE_INTAKE]!)] : [])];
    const ids = ['brief.prepare'];
    if (this.options.lifeIntake) ids.push(LIFE_INTAKE);

    if (this.options.agent) ids.push('agent.execute');
    if (this.options.paotui) ids.push('meituan.paotui.read');
    if (this.options.paotuiOrders) ids.push('meituan.paotui.order');
    if (this.options.pilot) ids.push(PILOT);
    return ids.map(id => structuredClone(SERVICE_CATALOG[id]!));
  }

  private ensureAgentConfigured(): void {
    if (this.stopping) throw new DomainError('CONFLICT', 'Gateway is shutting down');
    if (!this.options.agent) throw new DomainError('INVALID_INPUT', 'agent.execute is not configured');
  }

  submit(p: Principal, input: unknown, contextId?: string): Job {
    requireScope(p, 'tasks:write');
    const args = submitSchema.parse(input);
    if (contextId) taskIdSchema.parse(contextId);
    const owner = ownerKey(p);
    if (this.options.coordinator && args.service !== DELEGATE && args.service !== LIFE_INTAKE) throw new DomainError('INVALID_INPUT', 'Use eigos.delegate in the ontology backend; dedicated prototype services are not execution fallbacks');
    if ('requirements' in args && args.requirements && args.service !== DELEGATE) throw new DomainError('INVALID_INPUT', 'Structured requirements belong to the ontology execution service');
    if (args.service === LIFE_INTAKE && !this.options.lifeIntake) throw new DomainError('INVALID_INPUT', 'Life request intake is not configured');
    if (this.stopping) throw new DomainError('CONFLICT', 'Gateway is shutting down');
    if (args.service === 'meituan.paotui.read' || args.service === 'meituan.paotui.order') {
      if (args.service === 'meituan.paotui.order' ? !this.options.paotuiOrders : !this.options.paotui) throw new DomainError('INVALID_INPUT', 'Paotui is not configured');
      if (p.issuer !== 'local-development' || p.tenant !== 'local' || p.subject !== 'developer') throw new DomainError('FORBIDDEN', 'Personal Paotui queries require the local development identity');
      try { (args.service === 'meituan.paotui.order' ? orderQuerySchema : paotuiQuerySchema).parse(JSON.parse(args.goal)); } catch { throw new DomainError('INVALID_INPUT', 'goal must be a supported read-only Paotui JSON query'); }
      if (this.stopping) throw new DomainError('CONFLICT', 'Gateway is shutting down');
    }
    if (args.service === PILOT && 'fileName' in args && (p.issuer !== 'local-development' || p.tenant !== 'local' || p.subject !== 'developer')) throw new DomainError('FORBIDDEN', 'Local CSV files require the local development identity');
    if (args.service === PILOT && !this.options.pilot) throw new DomainError('INVALID_INPUT', 'Simulation pilot is not configured');
    if (args.service === DELEGATE) {
      if (!this.options.coordinator || !this.options.catalog) throw new DomainError('INVALID_INPUT', 'Coordinator is not configured');

    }
    if (args.service === 'agent.execute') this.ensureAgentConfigured();
    const submitted = this.store.once(owner, 'submit', args.requestId, JSON.stringify([args, contextId]), () => {
      if (contextId && !this.store.hasContext(owner, contextId)) throw new DomainError('NOT_FOUND', 'Context not found');
      const now = new Date().toISOString();
      const job: Job = {
        id: randomUUID(), contextId: contextId || randomUUID(), service: args.service,
        goal: args.goal, deliverable: 'deliverable' in args ? args.deliverable : undefined, state: 'input-required',
        messages: [{ id: args.requestId, role: 'user', text: args.goal, at: now }],
        createdAt: now, updatedAt: now,
      };
      if (args.service === LIFE_INTAKE) {
        receiveLifeRequest(job, args.domain);
      } else if (args.service === DELEGATE) {
        job.state = 'submitted'; job.revision = 1; job.runs = [];
        job.executionMode = 'worker';
        job.delegation = { backendVersion: BACKEND_VERSION, request: { id: job.id, revision: 1, originalGoal: args.goal,
          requestedDeliverable: job.deliverable, messages: [{ id: args.requestId, text: args.goal, receivedAt: now }],
          requirements: (args.requirements ?? []).map(r => ({ ...r, provenance: { source: 'pa' as const, interpretation: 'structured' as const, messageId: args.requestId, receivedAt: now } })) },
          phase: 'grounding', events: [{ at: now, event: 'delegation_received' }] };
      } else if (args.service === PILOT) {
        const snapshot = 'fileName' in args ? loadCsvFile(this.options.csvInputDirectory, args.fileName) : undefined;
        job.executionMode = 'capability';
        this.options.pilot!.create(job, 'datasetId' in args ? args.datasetId : undefined, snapshot);
        if (snapshot) this.store.pilotWrite(`input:${job.pilot!.orderId}`, snapshot);
      }
      else if (job.service === 'agent.execute' || job.service === 'meituan.paotui.read' || job.service === 'meituan.paotui.order') { job.state = 'working'; job.revision = 1; job.runs = []; }
      else prepareBrief(job);
      this.store.save(owner, job);
      return job;
    });
    return submitted;
  }

  reply(p: Principal, input: unknown, contextId?: string): Job {
    requireScope(p, 'tasks:write');
    const args = replySchema.parse(input);
    const owner = ownerKey(p);
    const current = this.store.get(owner, args.taskId);
    if (this.options.coordinator && current.service !== DELEGATE && current.service !== LIFE_INTAKE) throw new DomainError('CONFLICT', 'Historical prototype tasks are read-only in the ontology backend');
    if (current.service === DELEGATE && current.delegation?.backendVersion !== BACKEND_VERSION) throw new DomainError('CONFLICT', 'Historical backend tasks are read-only; submit a new request');
    if ('requirements' in args && args.requirements && current.service !== DELEGATE) throw new DomainError('INVALID_INPUT', 'Structured requirements belong to the ontology execution service');
    if (contextId && current.contextId !== contextId) throw new DomainError('INVALID_INPUT', 'Context does not match task');
    if (current.service === PILOT) {
      if (!this.options.pilot) throw new DomainError('INVALID_INPUT', 'Simulation pilot is not configured');
      return this.store.once(owner, `reply:${args.taskId}`, args.requestId, JSON.stringify(args), () => {
        const job = this.store.get(owner, args.taskId); this.options.pilot!.confirm(job, args); this.store.save(owner, job); return job;
      });
    }
    if (!('answer' in args)) throw new DomainError('INVALID_INPUT', 'Simulation confirmation requires a simulation task');
    if (current.service === 'agent.execute') this.ensureAgentConfigured();
    const replied = this.store.once(owner, `reply:${args.taskId}`, args.requestId, JSON.stringify(args), () => {
      const job = this.store.get(owner, args.taskId);
      if (job.service === LIFE_INTAKE) {
        if (job.state !== 'submitted' || job.intake?.status !== 'waiting_provider') throw new DomainError('CONFLICT', 'Life request is not open for updates');
        job.updatedAt = new Date().toISOString();
        job.messages.push({ id: args.requestId, role: 'user', text: args.answer, at: job.updatedAt });
        refreshLifeReceipt(job);
        this.store.save(owner, job);
        return job;
      }
      if (job.service === DELEGATE && job.state === 'auth-required') throw new DomainError('CONFLICT', 'Use the task authorization endpoint to approve the plan; cancel the task to decline');
      if (job.state !== 'input-required') throw new DomainError('CONFLICT', 'Task is not waiting for input');
      job.updatedAt = new Date().toISOString();
      job.messages.push({ id: args.requestId, role: 'user', text: args.answer, at: job.updatedAt });
      if (job.service === DELEGATE) {
        const request = job.delegation!.request;
        request.revision++; request.messages.push({ id: args.requestId, text: args.answer, receivedAt: job.updatedAt });
        for (const r of args.requirements ?? []) {
          const previous = request.requirements.findIndex(x => x.id === r.id);
          const next = { ...r, provenance: { source: 'pa' as const, interpretation: 'structured' as const, messageId: args.requestId, receivedAt: job.updatedAt } };
          if (previous < 0) request.requirements.push(next); else request.requirements[previous] = next;
        }
        if (request.requirements.length > 40) throw new DomainError('INVALID_INPUT', 'Too many task requirements');
        job.state = 'submitted'; job.executionMode = 'worker'; job.revision = (job.revision ?? 0) + 1; delete job.question; job.delegation!.phase = 'grounding';
      } else if (job.service === 'agent.execute') {
        job.state = 'working'; job.revision = (job.revision ?? 0) + 1; delete job.question;
      } else { job.deliverable = args.answer; prepareBrief(job); }
      this.store.save(owner, job);
      return job;
    });
    return replied;
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
      if (this.options.coordinator && job.service !== DELEGATE && job.service !== LIFE_INTAKE) throw new DomainError('CONFLICT', 'Historical prototype tasks are read-only in the ontology backend');
      if (job.service === DELEGATE && job.delegation?.backendVersion !== BACKEND_VERSION) throw new DomainError('CONFLICT', 'Historical backend tasks are read-only; submit a new request');
      if (job.service !== DELEGATE && job.pilot) {
        if (!this.options.pilot) throw new DomainError('INVALID_INPUT', 'Simulation pilot is not configured');
        this.options.pilot.cancel(job); if (job.delegation) job.delegation.phase = 'canceled'; this.store.save(owner, job); return job;
      }
      if (job.service === 'meituan.paotui.order') throw new DomainError('CONFLICT', 'Order workflow tasks cannot cancel provider orders; use order_state to inspect the outcome');
      if (job.state === 'completed' || job.state === 'failed' || job.state === 'rejected') throw new DomainError('CONFLICT', 'Terminal tasks cannot be canceled');
      job.state = 'canceled';
      if (job.intake) { job.intake.status = 'canceled'; job.intake.nextAction = 'none'; }
      if (job.delegation) job.delegation.phase = 'canceled';
      delete job.question;
      job.updatedAt = new Date().toISOString();
      if (job.intake) refreshLifeReceipt(job);
      job.messages.push({ id: randomUUID(), role: 'agent', text: 'Task canceled.', at: job.updatedAt });
      this.store.save(owner, job);
      return job;
    });
    return canceled;
  }

  authorize(p: Principal, id: string, input: unknown): Job {
    requireScope(p, 'tasks:write'); taskIdSchema.parse(id);
    const args = z.object({ requestId: z.string().trim().min(1).max(128) }).passthrough().parse(input);
    const owner = ownerKey(p);
    return this.store.once(owner, `authorize:${id}`, args.requestId, JSON.stringify(args), () => {
      const job = this.store.get(owner, id);
      if (job.service !== DELEGATE || job.state !== 'auth-required') throw new DomainError('CONFLICT', 'No pending delegation authorization');
      if (job.delegation?.backendVersion !== BACKEND_VERSION) throw new DomainError('CONFLICT', 'Historical backend tasks are read-only');
      const approval = z.object({ requestId: z.string().min(1).max(128), action: z.literal('confirm_simulated_payment'), quoteId: z.uuid(), quoteDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(input);
      const d = job.delegation; const plan = d.plan;
      if (!plan?.quote || !this.options.catalog || plan.quote.id !== approval.quoteId || plan.quote.digest !== approval.quoteDigest) throw new DomainError('CONFLICT', 'Exact plan quote approval required');
      validatePlan(this.options.catalog, owner, d.request, plan);
      job.updatedAt = new Date().toISOString();
      d.approval = { planDigest: plan.digest, quoteDigest: plan.quote.digest, at: job.updatedAt, simulationOnly: true };
      d.phase = 'executing'; d.events.push({ at: job.updatedAt, event: 'plan_authorized', evidence: plan.digest });
      job.state = 'submitted'; job.revision = (job.revision ?? 0) + 1; delete job.question;
      this.store.save(owner, job); return job;
    });
  }

  async wait(p: Principal, id: string): Promise<Job> {
    // The response to an authorized write may be read by a write-only client.
    // Durable execution is independent of this HTTP process and connection.
    const owner = ownerKey(p);
    const deadline = Date.now() + (this.options.waitTimeoutMs ?? 300000);
    let job = this.store.get(owner, id);
    while ((job.state === 'working' || job.state === 'submitted') && job.executionMode !== 'intake') {
      if (this.stopping || Date.now() >= deadline) throw new Error('Blocking task wait interrupted; query the existing task or retry the same message with returnImmediately=true');
      await delay(50);
      job = this.store.get(owner, id);
    }
    return job;
  }

  async close(): Promise<void> { this.stopping = true; }

}
