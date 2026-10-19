import { DELEGATE } from './delegation.js';
import { isActionAdapter, type ExecutionCatalog } from './catalog.js';
import { BACKEND_VERSION, moneySchema } from '../ontology/execution.js';
import { proposePlan, validatePlan } from '../coordinator/plan.js';
import { checkRequirements } from '../coordinator/resolver.js';
import { authorizationRequest, createSandboxGrant, requiredEffects } from './policy.js';
import { createActionIntents } from '../coordinator/runtime.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError, ownerKey, replySchema, requireScope, submitSchema, taskIdSchema, remediationSchema, type Job, type Principal } from './domain.js';
import { JobStore, type ListFilter } from './store.js';
import { setTimeout as delay } from 'node:timers/promises';
import { templatePlanning } from '../ontology/planning-contract.js';
import { validatePlanningSnapshot } from '../coordinator/planning-session.js';

export interface TaskOptions { catalog: ExecutionCatalog; allowSandboxActions?: boolean; waitTimeoutMs?: number }

export class TaskService {
  private stopping = false;
  constructor(private store: JobStore, private options: TaskOptions) {}

  services() {
    return [this.options.catalog.delegationService(), ...(this.options.catalog.hasRemediation() ? [{ id: 'eigos.aftersales', name: 'Owned service after-sales', description: 'Separate linked after-sales task for owned sandbox operations only. No real order, payment, cancellation or refund.', requiredInputs: ['originalTaskId', 'action', 'reason'], tags: ['aftersales'], examples: [], inputModes: ['application/json'], outputModes: ['application/json'] }] : [])];
  }

  resumeSource(p: Principal, input: unknown, assertConnected: (owner: string) => void): Job {
    requireScope(p, 'tasks:write');
    const args = z.object({ taskId: taskIdSchema, requestId: z.uuid(), expectedRevision: z.number().int().positive() }).strict().parse(input), owner = ownerKey(p);
    return this.store.once(owner, `source_resume:${args.taskId}`, args.requestId, JSON.stringify(args), () => {
      const job = this.store.get(owner, args.taskId), d = job.delegation;
      if (job.service !== DELEGATE || d?.backendVersion !== BACKEND_VERSION || job.state !== 'auth-required' || !d.sourceAuthorization || job.revision !== args.expectedRevision) throw new DomainError('CONFLICT', 'Task is not waiting for this source authorization');
      assertConnected(owner);
      const intents = this.store.intents(owner, job.id);
      if (intents.some(i => !['read', 'local'].includes(i.effect))) throw new DomainError('FORBIDDEN', 'Source connection cannot resume a business effect');
      for (const i of intents) { i.state = 'rejected'; this.store.saveIntent(owner, i); }
      if (d.plan) d.planHistory = [...(d.planHistory ?? []), d.plan];
      delete d.plan; delete d.intentId; delete d.intentIds; delete d.actions; delete d.resolution; delete d.sourceAuthorization; delete d.reasoning; delete d.ontologyReads; delete d.conditionChecks; delete d.authorizationRequest;
      job.revision = (job.revision ?? 0) + 1; d.request.revision = job.revision; d.phase = 'grounding'; d.nextAt = 0;
      job.state = 'submitted'; job.updatedAt = new Date().toISOString(); delete job.question; delete job.error;
      d.events.push({ at: job.updatedAt, event: 'owned_source_connected' });
      this.store.save(owner, job); return job;
    });
  }

  describeOntology(p: Principal, input: unknown) {
    requireScope(p, 'services:read');
    const query = z.object({ search: z.string().max(100).optional(), limit: z.number().int().min(1).max(5).optional(), after: z.string().optional() }).strict().parse(input);
    return this.store.ontology.model.describe(query);
  }
  queryOntology(p: Principal, input: unknown) {
    requireScope(p, 'tasks:read');
    return this.store.ontology.query(ownerKey(p), input as import('../ontology/object-store.js').ObjectQuery);
  }
  evaluateOntology(p: Principal, input: unknown) {
    requireScope(p, 'tasks:read');
    return this.store.ontology.evaluate(ownerKey(p), input);
  }

  submit(p: Principal, input: unknown, contextId?: string): Job { return this.submitInternal(p, input, contextId, false); }
  submitInTransaction(p: Principal, input: unknown): Job {
    this.store.assertTransaction(); return this.submitInternal(p, input, undefined, true);
  }
  private submitInternal(p: Principal, input: unknown, contextId: string | undefined, inTransaction: boolean): Job {
    requireScope(p, 'tasks:write');
    const args = submitSchema.parse(input);
    if (contextId) taskIdSchema.parse(contextId);
    const owner = ownerKey(p);
    if (args.service === 'eigos.aftersales') { if (inTransaction) throw new DomainError('FORBIDDEN', 'Inquiry cannot submit after-sales'); if (contextId && this.store.get(owner, args.originalTaskId).contextId !== contextId) throw new DomainError('INVALID_INPUT', 'Context does not match original task'); const { service, ...remedy } = args; return this.requestRemediation(p, remedy); }
    if (this.stopping) throw new DomainError('CONFLICT', 'Gateway is shutting down');
    const once = inTransaction ? this.store.onceInTransaction.bind(this.store) : this.store.once.bind(this.store);
    const submitted = once(owner, 'submit', args.requestId, JSON.stringify([args, contextId]), () => {
      if (contextId && !this.store.hasContext(owner, contextId)) throw new DomainError('NOT_FOUND', 'Context not found');
      const now = new Date().toISOString();
      const job: Job = {
        id: randomUUID(), contextId: contextId || randomUUID(), service: args.service,
        goal: args.goal, deliverable: 'deliverable' in args ? args.deliverable : undefined, state: 'input-required',
        messages: [{ id: args.requestId, role: 'user', text: args.goal, at: now }],
        createdAt: now, updatedAt: now,
      };
        job.state = 'submitted'; job.revision = 1; job.runs = [];
        job.executionMode = 'worker';
        job.delegation = { backendVersion: BACKEND_VERSION, ontologyReadScope: p.scopes.includes('tasks:read') ? 'owner' : 'request', request: { id: job.id, revision: 1, originalGoal: args.goal,
          executionEnvironment: args.executionEnvironment ?? 'live',
          requestedDeliverable: job.deliverable, messages: [{ id: args.requestId, text: args.goal, receivedAt: now }],
          requirements: (args.requirements ?? []).map(r => ({ ...r, provenance: { source: 'pa' as const, interpretation: 'structured' as const, messageId: args.requestId, receivedAt: now } })) },
          phase: 'grounding', events: [{ at: now, event: 'delegation_received' }] };
      this.store.save(owner, job);
      return job;
    });
    return submitted;
  }

  reply(p: Principal, input: unknown, contextId?: string, expected?: { revision: number; updatedAt: string }): Job {
    requireScope(p, 'tasks:write');
    const args = replySchema.parse(input);
    const owner = ownerKey(p);
    const current = this.store.get(owner, args.taskId);
    if (current.service !== DELEGATE) throw new DomainError('CONFLICT', 'Historical prototype tasks are read-only in the ontology backend');
    if (current.service === DELEGATE && current.delegation?.backendVersion !== BACKEND_VERSION) throw new DomainError('CONFLICT', 'Historical backend tasks are read-only; submit a new request');
    if ('requirements' in args && args.requirements && current.service !== DELEGATE) throw new DomainError('INVALID_INPUT', 'Structured requirements belong to the ontology execution service');
    if (contextId && current.contextId !== contextId) throw new DomainError('INVALID_INPUT', 'Context does not match task');
    const replied = this.store.once(owner, `reply:${args.taskId}`, args.requestId, JSON.stringify(args), () => {
      const job = this.store.get(owner, args.taskId);
      // The browser's displayed question must still be current under the write lock.
      if (expected && (job.revision !== expected.revision || job.updatedAt !== expected.updatedAt)) throw new DomainError('CONFLICT', 'Task changed; refresh before replying');
      if (job.delegation) job.delegation.ontologyReadScope = p.scopes.includes('tasks:read') ? 'owner' : 'request';
      if (job.service === DELEGATE && job.state === 'auth-required') throw new DomainError('CONFLICT', 'Use the task authorization endpoint to approve the plan; cancel the task to decline');
      if (job.state !== 'input-required') throw new DomainError('CONFLICT', 'Task is not waiting for input');
      job.updatedAt = new Date().toISOString();
      job.messages.push({ id: args.requestId, role: 'user', text: args.answer, at: job.updatedAt });
      if (job.service === DELEGATE) {
        if (job.delegation!.plan) {
          if (args.requirements?.length) throw new DomainError('CONFLICT', 'Fixed business requirements cannot be changed while an original action requires reconciliation');
          const d = job.delegation!;
          if (d.pendingActionInput) {
            d.actionReply = { intentId: d.pendingActionInput.intentId, messageId: args.requestId, answer: args.answer };
            const waiting = this.store.intent(owner, d.pendingActionInput.intentId); waiting.nextAt = Date.now(); this.store.saveIntent(owner, waiting);
          }
          else for (const intent of this.store.intents(owner, job.id)) if (intent.state === 'needs_review' || intent.state === 'effect_unknown') { intent.state = 'effect_unknown'; intent.failedQueries = 0; intent.nextAt = Date.now(); this.store.saveIntent(owner, intent); }
          d.nextAt = 0; d.phase = 'executing'; job.state = 'working'; job.revision = (job.revision ?? 0) + 1; delete job.question;
          this.store.save(owner, job); return job;
        }
        const request = job.delegation!.request;
        if (job.delegation!.agent) {
          this.store.cancelActions(owner, job.id);
          job.delegation!.agentHistory = [...(job.delegation!.agentHistory ?? []), job.delegation!.agent!];
          delete job.delegation!.agent;
        }
        request.revision++; request.messages.push({ id: args.requestId, text: args.answer, receivedAt: job.updatedAt });
        for (const r of args.requirements ?? []) {
          const previous = request.requirements.findIndex(x => x.id === r.id);
          const next = { ...r, provenance: { source: 'pa' as const, interpretation: 'structured' as const, messageId: args.requestId, receivedAt: job.updatedAt } };
          if (previous < 0) request.requirements.push(next); else request.requirements[previous] = next;
        }
        if (request.requirements.length > 40) throw new DomainError('INVALID_INPUT', 'Too many task requirements');
        job.state = 'submitted'; job.executionMode = 'worker'; job.revision = (job.revision ?? 0) + 1; delete job.question; job.delegation!.phase = 'grounding';
      }
      this.store.save(owner, job);
      return job;
    });
    return replied;
  }

  get(p: Principal, id: string): Job {
    requireScope(p, 'tasks:read');
    return this.view(ownerKey(p), this.store.get(ownerKey(p), taskIdSchema.parse(id)));
  }

  list(p: Principal, filter: ListFilter): { jobs: Job[]; total: number } {
    requireScope(p, 'tasks:read');
    z.number().int().min(1).max(100).parse(filter.limit);
    z.number().int().min(0).max(1_000_000).parse(filter.offset);
    const updatedAfter = filter.updatedAfter
      ? new Date(z.iso.datetime({ offset: true }).parse(filter.updatedAfter)).toISOString()
      : undefined;
    const owner = ownerKey(p); const found = this.store.list(owner, { ...filter, updatedAfter });
    return { ...found, jobs: found.jobs.map(job => this.view(owner, job)) };
  }

  cancel(p: Principal, id: string): Job {
    requireScope(p, 'tasks:write');
    const owner = ownerKey(p);
    taskIdSchema.parse(id);
    const canceled = this.store.once(owner, `cancel:${id}`, id, id, () => {
      const job = this.store.get(owner, id);
      if (job.service !== DELEGATE) throw new DomainError('CONFLICT', 'Historical prototype tasks are read-only in the ontology backend');
      if (job.service === DELEGATE && job.delegation?.backendVersion !== BACKEND_VERSION) throw new DomainError('CONFLICT', 'Historical backend tasks are read-only; submit a new request');
      if (job.state === 'completed' || job.state === 'failed' || job.state === 'rejected') throw new DomainError('CONFLICT', 'Terminal tasks cannot be canceled');
      job.state = 'canceled';
      if (job.delegation?.plan || job.delegation?.agent) { job.delegation.recoveryPending = this.store.cancelActions(owner, job.id); job.delegation.nextAt = 0; }
      if (job.delegation) job.delegation.phase = 'canceled';
      if (job.delegation?.plan) this.store.recordFeedback(owner, job, 'unverified', false);
      delete job.question;
      job.updatedAt = new Date().toISOString();
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
      const d = job.delegation; const plan = d.plan;
      if (!plan || !this.options.catalog) throw new DomainError('CONFLICT', 'No fixed plan to authorize');
      if (args.action === 'approve_plan') {
        const permit = z.object({ action: z.literal('approve_plan'), requestId: z.string().min(1).max(128), planDigest: z.string().regex(/^[a-f0-9]{64}$/), allowedEffects: z.array(z.enum(['local', 'read', 'reserve', 'order', 'payment', 'change', 'cancel', 'refund'])).min(1).max(8), maxAmount: moneySchema, payeeIds: z.array(z.string().min(1).max(200)).max(8), expiresAt: z.iso.datetime({ offset: true }), environment: z.literal('sandbox') }).strict().parse(input);
        if (!this.options.allowSandboxActions || d.request.executionEnvironment !== 'sandbox' || plan.quote || permit.planDigest !== plan.digest || permit.allowedEffects.some(e => !plan.steps.some(s => requiredEffects(s).includes(e))) || permit.payeeIds.some(payee => !plan.steps.some(s => s.cost?.payeeId === payee))) throw new DomainError('FORBIDDEN', 'Permit is outside this exact sandbox plan');
        validatePlan(this.options.catalog, owner, d.request, plan);
        validatePlanningSnapshot(this.store.ontology, owner, d.request, plan.ontologyPlanning, true);
        this.store.grant(owner, createSandboxGrant(owner, id, plan, permit)); d.phase = 'executing'; d.nextAt = 0;
        job.updatedAt = new Date().toISOString(); job.state = 'submitted'; job.revision = (job.revision ?? 0) + 1; delete job.question;
        if (d.afterSalesCaseId) this.store.updateAfterSales(owner, d.afterSalesCaseId, 'processing');
        this.store.save(owner, job); return job;
      }
      const approval = z.object({ requestId: z.string().min(1).max(128), action: z.literal('confirm_simulated_payment'), quoteId: z.uuid(), quoteDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(input);
      if (!plan?.quote || !this.options.catalog || plan.quote.id !== approval.quoteId || plan.quote.digest !== approval.quoteDigest) throw new DomainError('CONFLICT', 'Exact plan quote approval required');
      validatePlan(this.options.catalog, owner, d.request, plan);
      validatePlanningSnapshot(this.store.ontology, owner, d.request, plan.ontologyPlanning, true);
      job.updatedAt = new Date().toISOString();
      d.approval = { planDigest: plan.digest, quoteDigest: plan.quote.digest, at: job.updatedAt, simulationOnly: true };
      d.phase = 'executing'; d.events.push({ at: job.updatedAt, event: 'plan_authorized', evidence: plan.digest });
      job.state = 'submitted'; job.revision = (job.revision ?? 0) + 1; delete job.question;
      this.store.save(owner, job); return job;
    });
  }

  reconcile(p: Principal, id: string, requestId: string): Job {
    requireScope(p, 'tasks:write'); taskIdSchema.parse(id); const owner = ownerKey(p);
    return this.store.once(owner, `reconcile:${id}`, requestId, id, () => {
      const job = this.store.get(owner, id);
      if (job.delegation?.backendVersion !== BACKEND_VERSION || !job.delegation.plan) throw new DomainError('CONFLICT', 'No current business operation to reconcile');
      let pending = false;
      for (const intent of this.store.intents(owner, id)) if (['needs_review', 'effect_unknown', 'awaiting_remote', 'dispatching'].includes(intent.state)) { pending = true; intent.state = 'effect_unknown'; intent.failedQueries = 0; intent.nextAt = Date.now(); this.store.saveIntent(owner, intent); }
      else if (intent.state === 'effect_confirmed' && intent.remoteRef && !['read', 'local'].includes(intent.effect)) { pending = true; intent.needsObservation = true; intent.nextAt = Date.now(); this.store.saveIntent(owner, intent); }
      if (!pending) return job;
      job.delegation.manualReconciliation = requestId;
      const terminal = ['canceled', 'failed', 'completed', 'auth-required'].includes(job.state);
      job.delegation.recoveryPending = terminal; job.delegation.nextAt = 0; job.revision = (job.revision ?? 0) + 1;
      if (!terminal) { job.state = 'working'; delete job.question; } job.updatedAt = new Date().toISOString(); this.store.save(owner, job); return job;
    });
  }
  revokeAuthorization(p: Principal, id: string, requestId: string): Job {
    requireScope(p, 'tasks:write'); taskIdSchema.parse(id); const owner = ownerKey(p);
    return this.store.once(owner, `revoke:${id}`, requestId, id, () => {
      const job = this.store.get(owner, id); const d = job.delegation;
      if (d?.backendVersion !== BACKEND_VERSION || !d.plan || (!d.authorizationRequest && !d.plan.quote) || ['completed', 'failed', 'canceled'].includes(job.state)) throw new DomainError('CONFLICT', 'No open plan authorization to revoke');
      this.store.revokeGrants(owner, id); delete d.approval; job.revision = (job.revision ?? 0) + 1;
      d.recoveryPending = this.store.intents(owner, id).some(i => ['dispatching', 'awaiting_remote', 'effect_unknown'].includes(i.state)); d.nextAt = 0;
      job.state = 'auth-required'; d.phase = 'awaiting_authorization'; job.updatedAt = new Date().toISOString(); this.store.save(owner, job); return job;
    });
  }
  requestRemediation(p: Principal, input: unknown): Job {
    requireScope(p, 'tasks:write'); const args = remediationSchema.parse(input); const owner = ownerKey(p); const catalog = this.options.catalog;
    if (this.stopping) throw new DomainError('CONFLICT', 'Gateway is shutting down');
    if (!catalog) throw new DomainError('CONFLICT', 'Ontology backend is required for after-sales');
    return this.store.once(owner, `aftersales:${args.originalTaskId}`, args.requestId, JSON.stringify(args), () => {
      const original = this.store.get(owner, args.originalTaskId); const d = original.delegation;
      if (d?.backendVersion !== BACKEND_VERSION || !d.plan) throw new DomainError('CONFLICT', 'Original task has no current owned business plan');
      const existing = this.store.afterSales(owner, original.id).find(c => c.action === args.action); if (existing) return this.store.get(owner, existing.remedyJobId);
      validatePlan(catalog, owner, d.request, d.plan, Date.now(), 'observe');
      const intents = this.store.intents(owner, original.id); const operation = intents.find(i => i.effect === 'order' && i.remoteRef) ?? intents.find(i => i.remoteRef);
      if (!operation?.remoteRef) throw new DomainError('CONFLICT', 'Reconcile the original operation before requesting after-sales');
      if (args.action === 'refund' && !intents.some(i => i.remoteRef === operation.remoteRef && i.businessSnapshot?.value.payment === 'paid')) throw new DomainError('CONFLICT', 'No verified original paid amount; reconcile payment first');
      const selected = catalog.binding(operation.bindingRef, owner, d.request.id); const adapter = selected.adapter;
      if (!isActionAdapter(adapter) || !adapter.prepareRemediation || !this.options.allowSandboxActions || adapter.environment !== 'sandbox') throw new DomainError('FORBIDDEN', 'Only configured sandbox business remediation is enabled');
      const now = new Date().toISOString(); const caseId = randomUUID(); const job: Job = { id: randomUUID(), contextId: original.contextId, service: DELEGATE,
        goal: `${args.action === 'refund' ? '退款' : '取消业务'}：原任务 ${original.id}；${args.reason}`, state: 'auth-required', revision: 1, executionMode: 'worker', runs: [], messages: [], createdAt: now, updatedAt: now };
      job.messages = [{ id: args.requestId, role: 'user', text: job.goal, at: now }];
      job.delegation = { backendVersion: BACKEND_VERSION, request: { id: job.id, revision: 1, originalGoal: job.goal, executionEnvironment: d.request.executionEnvironment, requirements: [], messages: [{ id: args.requestId, text: job.goal, receivedAt: now }], outcome: args.action, businessScopeId: `aftersales:${operation.businessOperationKey}:${args.action}` }, phase: 'awaiting_authorization', afterSalesCaseId: caseId, events: [{ at: now, event: 'aftersales_requested', evidence: original.id }] };
      const ctx = { owner, request: job.delegation.request }; const prepared = adapter.prepareRemediation(ctx, d.plan, operation.remoteRef, args.action, args.reason, intents);
      if (prepared.kind !== 'ready' || !prepared.recipe?.length) throw new DomainError('CONFLICT', 'Provider cannot prepare a bounded remediation operation');
      const binding = selected.binding.discovery ? { ...selected.binding, discovery: { ...selected.binding.discovery, requestId: job.id, requestRevision: 1, observedAt: now, evidenceRefs: [...selected.binding.discovery.evidenceRefs, operation.latestObservationId!] } } : selected.binding;
      if (binding.discovery) catalog.registerDiscovered(ctx, { ...binding, discovery: binding.discovery });
      const capability = catalog.capability(binding.capabilityRef);
      if (prepared.recipe.some(s => !capability.actions.some(a => a.ref.id === s.actionTypeRef.id && a.ref.version === s.actionTypeRef.version && [args.action, 'read'].includes(a.effect)))) throw new DomainError('FORBIDDEN', 'Remediation cannot introduce other business effects');
      const candidate = { id: randomUUID(), binding, status: 'ready' as const, input: prepared.input, details: { ...prepared.details, originalPlanDigest: d.plan.digest, originalIntentId: operation.id }, facts: prepared.facts, evidenceRefs: prepared.evidenceRefs, requirementChecks: checkRequirements(ctx.request, prepared.facts, prepared.evidenceRefs), observedAt: prepared.observedAt, expiresAt: prepared.expiresAt, recipe: prepared.recipe };
      const plan = proposePlan(catalog, owner, ctx.request, capability, candidate, { kind: 'propose_plan', requestRevision: 1, candidateId: candidate.id, message: 'Bound to the owned original operation', steps: prepared.recipe.map(s => ({ id: s.id, actionTypeRef: s.actionTypeRef, bindingRef: s.bindingRef ?? binding.ref, inputJson: JSON.stringify(s.input), dependsOn: s.dependsOn })) }, templatePlanning(ctx.request));
      validatePlan(catalog, owner, ctx.request, plan); job.delegation.plan = plan; job.delegation.authorizationRequest = authorizationRequest(plan, plan.steps.flatMap(requiredEffects));
      job.question = '售后任务已建立；须批准准确的沙箱动作和金额。受理不等于退款或取消完成。';
      this.store.save(owner, job); createActionIntents(this.store, owner, job, prepared.privateData);
      this.store.createAfterSales(owner, { id: caseId, owner, originalJobId: original.id, remedyJobId: job.id, action: args.action, state: 'requested', remoteRef: operation.remoteRef, createdAt: now, updatedAt: now });
      this.store.save(owner, job);
      if (['working', 'submitted', 'input-required', 'auth-required'].includes(original.state)) { original.state = 'canceled'; d.phase = 'canceled'; d.recoveryPending = this.store.cancelActions(owner, original.id); d.nextAt = 0; original.updatedAt = now; this.store.save(owner, original); }
      return job;
    });
  }
  private view(owner: string, job: Job): Job {
    if (job.delegation?.backendVersion === BACKEND_VERSION && (job.delegation.plan || job.delegation.agent || job.delegation.agentHistory?.length)) {
      const intents = this.store.intents(owner, job.id).filter(i => !job.delegation!.plan || i.planDigest === job.delegation!.plan.digest);
      job.delegation.actions = intents.map(i => ({ id: i.id, stepId: i.stepId, state: i.state, remoteRef: i.remoteRef, latestObservationId: i.latestObservationId }));
      job.delegation.businessFacts = intents.flatMap(i => i.businessSnapshot ? [{ intentId: i.id, snapshot: i.businessSnapshot.value, sourceVersion: i.businessSnapshot.sourceVersion, evidenceRefs: i.businessSnapshot.evidenceRefs }] : []);
      job.delegation.authorizationBudget = this.store.budget(owner, job.id).map(b => ({ minor: String(b.minor), currency: String(b.currency), state: String(b.state), intentId: String(b.intent_id) }));
    }
    const cases = this.store.afterSales(owner, job.id); if (cases.length) job.afterSales = cases.map(({ owner: _owner, ...c }) => c);
    return job;
  }

  async wait(p: Principal, id: string): Promise<Job> {
    // The response to an authorized write may be read by a write-only client.
    // Durable execution is independent of this HTTP process and connection.
    const owner = ownerKey(p);
    const deadline = Date.now() + (this.options.waitTimeoutMs ?? 300000);
    let job = this.store.get(owner, id);
    while ((job.state === 'working' || job.state === 'submitted') && job.delegation?.backendVersion === BACKEND_VERSION) {
      if (this.stopping || Date.now() >= deadline) throw new Error('Blocking task wait interrupted; query the existing task or retry the same message with returnImmediately=true');
      await delay(50);
      job = this.store.get(owner, id);
    }
    return job;
  }

  async close(): Promise<void> { this.stopping = true; }

}
