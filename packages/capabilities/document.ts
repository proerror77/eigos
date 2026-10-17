import { z } from 'zod';
import type { ActionAdapter, Preparation, AdapterContext, Delivery } from '../core/catalog.js';
import type { ActionContext, ActionResult } from '../ontology/actions.js';
import type { Executor } from './executor.js';
import type { Job } from '../core/domain.js';
import type { ExecutionPlan, PlanStep, ProviderBinding, ServiceCapability } from '../ontology/execution.js';
import { digest } from '../core/delegation.js';
const inputSchema = z.object({ format: z.literal('markdown') }).strict();
export const DOCUMENT_CAPABILITY: ServiceCapability = { ref: { id: 'document.compose', version: '1' }, ontologyRef: { id: 'document-draft', version: '1' }, name: 'Produce a document draft', tags: ['document', 'markdown'],
  description: 'Actually produce a Markdown draft, agenda, analysis or plan from the requester\'s supplied facts. Only select when the requested outcome is the document itself. No external research, booking, sending, purchase or business execution. Content-specific subjective acceptance remains with the requester. Audience/group details belong in the draft, not physical fulfillment quantities. Input is format=markdown; the original goal and conversation are retained verbatim.',
  inputSchema: z.toJSONSchema(inputSchema), ontology: { objects: ['OriginalGoal', 'SuppliedContext', 'DraftDocument'], rules: ['Keep the original user goal and history', 'Draft production is not execution of its proposed business', 'Format/hash verification is not proof of factual truth or commercial fulfillment'] },
  actions: [{ ref: { id: 'compose_document', version: '1' }, effect: 'local' }], completion: 'artifact', verifierRef: { id: 'document.format-and-hash', version: '1' }, predicates: [{ id: 'document.markdown', description: 'Nonempty Markdown draft produced' }, { id: 'execution.no_external_effects', description: 'Document-only model, tools and external actions disabled' }] };
export const DOCUMENT_BINDING: ProviderBinding = { ref: { id: 'local-codex-document', version: '1' }, capabilityRef: DOCUMENT_CAPABILITY.ref, providerId: 'local-codex', channelId: 'local', adapterId: 'document.codex.v1', protocol: 'local', enabled: true,
  verification: { level: 'local_test', evidenceRefs: ['tests/executor.test.ts'] }, recovery: { idempotency: 'none', lookup: false } };
export class DocumentAdapter implements ActionAdapter {
  readonly id = 'document.codex.v1'; readonly environment = 'live' as const;
  constructor(private executor?: Executor) {}
  permitted() { return true; }
  async prepare(_ctx: AdapterContext, input: unknown): Promise<Preparation> {
    const value = inputSchema.parse(input);
    return { kind: 'ready', input: value, details: { documentOnly: true }, facts: { conditions: ['document.markdown', 'execution.no_external_effects'] }, evidenceRefs: ['local:document-contract'], observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString() };
  }
  validateInput(_step: PlanStep, input: Record<string, unknown>) { inputSchema.parse(input); }
  async dispatch(ctx: ActionContext, _data: unknown, signal: AbortSignal): Promise<ActionResult> {
    if (!this.executor) throw new Error('Document executor is only configured in Worker');
    if ((ctx.modelReceipts ?? []).filter(r => r.purpose === 'document').length >= 6) return { kind: 'requires_input', eventId: `${ctx.attempt.id}:limit`, sourceVersion: ctx.attempt.ordinal, message: '本任务的文档模型调用已达六次上限，请检查已有上下文后再决定新任务。', evidenceRefs: [] };
    const now = new Date().toISOString();
    const job: Job = { id: ctx.requestId, contextId: ctx.requestId, service: 'eigos.delegate', goal: ctx.goal, state: 'working', messages: ctx.messages ?? [{ id: 'original', role: 'user', text: ctx.goal, at: now }], createdAt: now, updatedAt: now };
    const response = await this.executor.run(job, signal); const version = ctx.attempt.ordinal; const receipt = { ...response.evidence, purpose: 'document' as const };
    if (response.output.decision === 'ask_user') return { kind: 'requires_input', eventId: receipt.id, sourceVersion: version, message: response.output.message, evidenceRefs: [receipt.id], runEvidence: receipt };
    const markdown = response.output.artifact;
    const delivery: Delivery = { artifact: { id: digest({ run: response.evidence.id, markdown }), name: 'deliverable.md', data: { goal: ctx.goal, deliverable: '文档草稿已生成，格式及摘要已核对；内容需按实际用途审阅，未执行文档中的业务。', execution: 'completed', markdown, result: { modelGenerated: true, contentSha256: digest(markdown), noExternalActions: true } } }, facts: { conditions: ['document.markdown', 'execution.no_external_effects'] }, evidenceRefs: [response.evidence.id] };
    return { kind: 'confirmed', eventId: receipt.id, sourceVersion: version, delivery, evidenceRefs: delivery.evidenceRefs, runEvidence: receipt };
  }
  async resume(ctx: ActionContext, data: unknown, signal: AbortSignal) { return this.dispatch(ctx, data, signal); }
  async observe(ctx: ActionContext): Promise<ActionResult> { return this.reconcile(ctx); }
  async reconcile(ctx: ActionContext): Promise<ActionResult> { return { kind: 'requires_input', eventId: `${ctx.attempt.id}:document-review`, sourceVersion: ctx.attempt.ordinal, message: '上次文档模型调用的结果无法回查。若仍需草稿，请在本任务明确确认重新生成。', evidenceRefs: [] }; }
  verifyAction(_ctx: ActionContext, result: ActionResult) { return { accepted: result.kind === 'requires_input' || result.kind === 'confirmed' && !!result.runEvidence && !!result.delivery, reason: 'Bounded model receipt; no external business authority' }; }
  verify(ctx: AdapterContext, _plan: ExecutionPlan, _data: unknown, delivery: Delivery) {
    const data = delivery.artifact.data; const result = data.result as { contentSha256?: string; noExternalActions?: boolean } | undefined;
    const accepted = delivery.artifact.name === 'deliverable.md' && data.goal === ctx.request.originalGoal && typeof data.markdown === 'string' && !!data.markdown.trim() && data.markdown.length <= 40000 && result?.contentSha256 === digest(data.markdown) && result.noExternalActions === true;
    return { accepted, reason: 'Document format, original goal, content hash and document-only boundary verified; semantic quality is not independently certified' };
  }
}
