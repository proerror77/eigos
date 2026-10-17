import { DELEGATE } from './delegation.js';
import { isActionAdapter, type ExecutionCatalog } from './catalog.js';
import { BACKEND_VERSION, moneySchema } from '../ontology/execution.js';
import { proposePlan, validatePlan } from '../coordinator/plan.js';
import { checkRequirements } from '../coordinator/resolver.js';
import { authorizationRequest, createSandboxGrant } from './policy.js';
import { createActionIntents } from '../coordinator/runtime.js';
import { prepareBrief } from '../capabilities/brief.js';
import { SERVICE_CATALOG } from './services.js';
import { loadCsvFile } from '../capabilities/pilot/csv-file.js';
import { PILOT } from '../capabilities/pilot/contracts.js';
import type { PilotCommands } from '../capabilities/pilot/commands.js';
import { orderQuerySchema, paotuiQuerySchema } from '../capabilities/paotui-contracts.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError, ownerKey, replySchema, requireScope, submitSchema, taskIdSchema, remediationSchema, type Job, type Principal } from './domain.js';
import { JobStore, type ListFilter } from './store.js';
import { setTimeout as delay } from 'node:timers/promises';
import { LIFE_INTAKE, receiveLifeRequest, refreshLifeReceipt } from '../capabilities/life-intake.js';

export interface TaskOptions { catalog?: ExecutionCatalog; coordinator?: boolean; allowSandboxActions?: boolean; lifeIntake?: boolean; waitTimeoutMs?: number; csvInputDirectory?: string; agent?: boolean; paotui?: boolean; paotuiOrders?: boolean; pilot?: PilotCommands }

export class TaskService {
  private stopping = false;
  constructor(private store: JobStore, private options: TaskOptions = {}) {
    if (options.coordinator && !options.catalog) throw new Error('Ontology backend requires an execution catalogue');
  }

  services() {
    if (this.options.coordinator && this.options.catalog) return [this.options.catalog.delegationService(), ...(this.options.catalog.hasRemediation() ? [{ id: 'eigos.aftersales', name: 'Owned service after-sales', description: 'Request a separate, linked refund/cancellation task for an owned verified operation. Actual results require provider readback; no real business side effects are enabled.', requiredInputs: ['originalTaskId', 'action', 'reason'], tags: ['aftersales'], examples: [], inputModes: ['application/json'], outputModes: ['application/json'] }] : []), ...(this.options.lifeIntake ? [structuredClone(SERVICE_CATALOG[LIFE_INTAKE]!)] : [])];
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
    if (args.service === 'eigos.aftersales') { if (contextId && this.store.get(owner, args.originalTaskId).contextId !== contextId) throw new DomainError('INVALID_INPUT', 'Context does not match original task'); const { service, ...remedy } = args; return this.requestRemediation(p, remedy); }
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
          executionEnvironment: args.executionEnvironment ?? 'live',
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
      if (this.options.coordinator && job.service !== DELEGATE && job.service !== LIFE_INTAKE) throw new DomainError('CONFLICT', 'Historical prototype tasks are read-only in the ontology backend');
      if (job.service === DELEGATE && job.delegation?.backendVersion !== BACKEND_VERSION) throw new DomainError('CONFLICT', 'Historical backend tasks are read-only; submit a new request');
      if (job.service !== DELEGATE && job.pilot) {
        if (!this.options.pilot) throw new DomainError('INVALID_INPUT', 'Simulation pilot is not configured');
        this.options.pilot.cancel(job); if (job.delegation) job.delegation.phase = 'canceled'; this.store.save(owner, job); return job;
      }
      if (job.service === 'meituan.paotui.order') throw new DomainError('CONFLICT', 'Order workflow tasks cannot cancel provider orders; use order_state to inspect the outcome');
      if (job.state === 'completed' || job.state === 'failed' || job.state === 'rejected') throw new DomainError('CONFLICT', 'Terminal tasks cannot be canceled');
      job.state = 'canceled';
      if (job.delegation?.plan) { job.delegation.recoveryPending = this.store.cancelActions(owner, job.id); job.delegation.nextAt = 0; }
      if (job.intake) { job.intake.status = 'canceled'; job.intake.nextAction = 'none'; }
      if (job.delegation) job.delegation.phase = 'canceled';
      if (job.delegation?.plan) this.store.recordFeedback(owner, job, 'unverified', false);
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
      const d = job.delegation; const plan = d.plan;
      if (!plan || !this.options.catalog) throw new DomainError('CONFLICT', 'No fixed plan to authorize');
      if (args.action === 'approve_plan') {
        const permit = z.object({ action: z.literal('approve_plan'), requestId: z.string().min(1).max(128), planDigest: z.string().regex(/^[a-f0-9]{64}$/), allowedEffects: z.array(z.enum(['local', 'read', 'reserve', 'order', 'payment', 'change', 'cancel', 'refund'])).min(1).max(8), maxAmount: moneySchema, payeeIds: z.array(z.string().min(1).max(200)).max(8), expiresAt: z.iso.datetime({ offset: true }), environment: z.literal('sandbox') }).strict().parse(input);
        if (!this.options.allowSandboxActions || d.request.executionEnvironment !== 'sandbox' || plan.quote || permit.planDigest !== plan.digest || permit.allowedEffects.some(e => !plan.steps.some(s => s.effect === e)) || permit.payeeIds.some(payee => !plan.steps.some(s => s.cost?.payeeId === payee))) throw new DomainError('FORBIDDEN', 'Permit is outside this exact sandbox plan');
        validatePlan(this.options.catalog, owner, d.request, plan);
        this.store.grant(owner, createSandboxGrant(owner, id, plan, permit)); d.phase = 'executing'; d.nextAt = 0;
        job.updatedAt = new Date().toISOString(); job.state = 'submitted'; job.revision = (job.revision ?? 0) + 1; delete job.question;
        if (d.afterSalesCaseId) this.store.updateAfterSales(owner, d.afterSalesCaseId, 'processing');
        this.store.save(owner, job); return job;
      }
      const approval = z.object({ requestId: z.string().min(1).max(128), action: z.literal('confirm_simulated_payment'), quoteId: z.uuid(), quoteDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(input);
      if (!plan?.quote || !this.options.catalog || plan.quote.id !== approval.quoteId || plan.quote.digest !== approval.quoteDigest) throw new DomainError('CONFLICT', 'Exact plan quote approval required');
      validatePlan(this.options.catalog, owner, d.request, plan);
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
    if (!this.options.coordinator || !catalog) throw new DomainError('CONFLICT', 'Ontology backend is required for after-sales');
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
      const plan = proposePlan(catalog, owner, ctx.request, capability, candidate, { kind: 'propose_plan', requestRevision: 1, candidateId: candidate.id, message: 'Bound to the owned original operation', steps: prepared.recipe.map(s => ({ id: s.id, actionTypeRef: s.actionTypeRef, bindingRef: s.bindingRef ?? binding.ref, inputJson: JSON.stringify(s.input), dependsOn: s.dependsOn })) });
      validatePlan(catalog, owner, ctx.request, plan); job.delegation.plan = plan; job.delegation.authorizationRequest = authorizationRequest(plan, plan.steps.map(s => s.effect));
      job.question = '售后任务已建立；须批准准确的沙箱动作和金额。受理不等于退款或取消完成。';
      this.store.save(owner, job); createActionIntents(this.store, owner, job, prepared.privateData);
      this.store.createAfterSales(owner, { id: caseId, owner, originalJobId: original.id, remedyJobId: job.id, action: args.action, state: 'requested', remoteRef: operation.remoteRef, createdAt: now, updatedAt: now });
      this.store.save(owner, job);
      if (['working', 'submitted', 'input-required', 'auth-required'].includes(original.state)) { original.state = 'canceled'; d.phase = 'canceled'; d.recoveryPending = this.store.cancelActions(owner, original.id); d.nextAt = 0; original.updatedAt = now; this.store.save(owner, original); }
      return job;
    });
  }
  private view(owner: string, job: Job): Job {
    if (job.delegation?.backendVersion === BACKEND_VERSION && job.delegation.plan) {
      const intents = this.store.intents(owner, job.id).filter(i => i.planDigest === job.delegation!.plan!.digest);
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
    while ((job.state === 'working' || job.state === 'submitted') && job.executionMode !== 'intake') {
      if (this.stopping || Date.now() >= deadline) throw new Error('Blocking task wait interrupted; query the existing task or retry the same message with returnImmediately=true');
      await delay(50);
      job = this.store.get(owner, id);
    }
    return job;
  }

  async close(): Promise<void> { this.stopping = true; }

}
