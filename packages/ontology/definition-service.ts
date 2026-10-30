import { z } from 'zod';
import { DomainError, ownerKey, requireScope, taskIdSchema, type Job, type Principal } from '../core/domain.js';
import type { JobStore } from '../core/store.js';
import type { TaskService } from '../core/tasks.js';
import type { ExecutionCatalog } from '../core/catalog.js';
import { taskSummary } from '../core/task-summary.js';
import { definitionKindSchema, ontologyIdSchema, ontologyReleaseRefSchema, resourceIdSchema, type DefinitionKind, type OntologyDocument } from './definition-contracts.js';
import type { DefinitionDraft, DefinitionResource } from './definition-store.js';
import { previewDeclarativeAction } from './declarative-actions.js';
import type { ManagedActionPreview } from './declarative-actions.js';
import { objectWriteScopeSchema } from './actions.js';
import { objectRefSchema } from './model.js';
import { actionDiscoverySchema } from '../core/action-bindings.js';
import { pipelineIntakeSchema, pipelineValidationRequestSchema } from './pipeline/contracts.js';
import { SecurityError } from '../security/store.js';

const ontology = { ontologyId: ontologyIdSchema.default('eigos.business') };
const page = { limit: z.number().int().min(1).max(50).default(20), offset: z.number().int().min(0).max(10000).default(0) };
const draftId = z.uuid(), expectedRevision = z.number().int().positive();
const source = { ...ontology, draftId: draftId.optional(), release: ontologyReleaseRefSchema.optional() };
export const definitionQuerySchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('list_ontologies'), ...page }),
  z.strictObject({ operation: z.literal('get_ontology'), ...ontology }),
  z.strictObject({ operation: z.literal('list_definitions'), ...source, ...page, kind: definitionKindSchema.optional(), search: z.string().max(100).optional(), customOnly: z.boolean().default(false) }),
  z.strictObject({ operation: z.literal('get_definition'), ...source, kind: definitionKindSchema, resourceId: resourceIdSchema }),
  z.strictObject({ operation: z.literal('list_drafts'), ...ontology, ...page }),
  z.strictObject({ operation: z.literal('get_draft'), ...ontology, draftId }),
  z.strictObject({ operation: z.literal('validate_draft'), ...ontology, draftId }),
  z.strictObject({ operation: z.literal('diff_draft'), ...ontology, draftId, ...page }),
  z.strictObject({ operation: z.literal('list_releases'), ...ontology, ...page }),
  z.strictObject({ operation: z.literal('get_release'), ...ontology, release: ontologyReleaseRefSchema }),
  z.strictObject({ operation: z.literal('history'), ...ontology, limit: z.number().int().min(1).max(50).default(20) }),
  z.strictObject({ operation: z.literal('get_action_task'), ...ontology, taskId: taskIdSchema }),
  z.strictObject({ operation: z.literal('discover_task_actions'), ...ontology, taskId: taskIdSchema, query: actionDiscoverySchema }),
  z.strictObject({ operation: z.literal('get_pipeline_intake'), ...source, serviceId: resourceIdSchema }),
  z.strictObject({ operation: z.literal('get_pipeline_task_uses'), ...ontology, taskId: taskIdSchema }),
  z.strictObject({ operation: z.literal('get_pipeline_task_changes'), ...ontology, taskId: taskIdSchema }),
  z.strictObject({ operation: z.literal('get_pipeline_fact'), ...ontology, taskId: taskIdSchema, object: objectRefSchema }),
]);
export const definitionCommandSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('create_ontology'), id: ontologyIdSchema.optional(), name: z.string().trim().min(1).max(160) }),
  z.strictObject({ operation: z.literal('create_draft'), ...ontology, title: z.string().trim().min(1).max(160) }),
  z.strictObject({ operation: z.literal('put_definition'), ...ontology, draftId, expectedRevision, kind: definitionKindSchema, definition: z.record(z.string(), z.unknown()) }),
  z.strictObject({ operation: z.literal('retire_definition'), ...ontology, draftId, expectedRevision, resourceId: resourceIdSchema }),
  z.strictObject({ operation: z.enum(['publish_draft', 'discard_draft']), ...ontology, draftId, expectedRevision }),
  z.strictObject({ operation: z.literal('activate_release'), ...ontology, release: ontologyReleaseRefSchema, expectedGeneration: z.number().int().nonnegative() }),
  z.strictObject({ operation: z.literal('put_pipeline_intake'), ...ontology, draftId, expectedRevision, intake: pipelineIntakeSchema }),
  z.strictObject({ operation: z.literal('validate_pipeline_intake'), ...ontology, draftId, expectedRevision, serviceId: resourceIdSchema, expiresAt: z.iso.datetime({ offset: true }) }),
  z.strictObject({ operation: z.literal('verify_pipeline_task'), ...ontology, draftId, expectedRevision, serviceId: resourceIdSchema, taskId: taskIdSchema, expiresAt: z.iso.datetime({ offset: true }) }),
  z.strictObject({ operation: z.literal('report_pipeline_source_change'), ...ontology, serviceId: resourceIdSchema, sourceDigest: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.strictObject({ operation: z.literal('revoke_pipeline_verification'), ...ontology, serviceId: resourceIdSchema, verificationId: z.string().min(1).max(100) }),
  pipelineValidationRequestSchema.extend({ operation: z.literal('prepare_pipeline_validation') }),
]);
const foundationQueries = ['get_ontology', 'get_pipeline_intake', 'get_pipeline_task_uses', 'get_pipeline_task_changes', 'get_pipeline_fact', 'discover_task_actions', 'get_action_task'];
const foundationCommands = ['create_draft', 'put_pipeline_intake', 'validate_pipeline_intake', 'publish_draft', 'discard_draft', 'activate_release', 'verify_pipeline_task', 'report_pipeline_source_change', 'revoke_pipeline_verification', 'prepare_pipeline_validation'];
const [firstFoundationQuery, ...otherFoundationQueries] = definitionQuerySchema.options.filter(schema => foundationQueries.some(operation => schema.shape.operation.safeParse(operation).success));
const [firstFoundationCommand, ...otherFoundationCommands] = definitionCommandSchema.options.filter(schema => foundationCommands.some(operation => schema.shape.operation.safeParse(operation).success));
if (!firstFoundationQuery || !firstFoundationCommand) throw new Error('Foundation Pipeline interfaces require an explicit operation allowlist');
export const foundationDefinitionQuerySchema = z.discriminatedUnion('operation', [firstFoundationQuery, ...otherFoundationQueries]);
export const foundationDefinitionCommandSchema = z.discriminatedUnion('operation', [firstFoundationCommand, ...otherFoundationCommands]);
export const prepareOntologyActionSchema = z.strictObject({ ...ontology, action: z.string().min(1).max(80).optional(), interface: z.strictObject({ object: objectRefSchema, interfaceId: z.string().min(1).max(80), actionId: z.string().min(1).max(80) }).optional(), input: z.record(z.string(), z.unknown()), requestId: z.string().min(1).max(128) }).refine(value => !!value.action !== !!value.interface, 'Choose one concrete action or interface action');
export const approveOntologyActionSchema = z.strictObject({ taskId: taskIdSchema, requestId: z.string().min(1).max(128), planDigest: z.string().regex(/^[a-f0-9]{64}$/), objectWrite: objectWriteScopeSchema, expiresAt: z.iso.datetime({ offset: true }) });
const categories = { object: 'objects', interface: 'interfaces', link: 'links', action: 'actions' } as const;
const resources = (document: OntologyDocument) => (Object.keys(categories) as DefinitionKind[]).flatMap(kind => document[categories[kind]].map(definition => ({ kind, definition })));
const summary = ({ document: _document, ...draft }: DefinitionDraft) => draft;
const immutable = (resourceId: string) => resourceId.startsWith('generated:');
function invalid(message: string): never { throw new DomainError('INVALID_INPUT', message); }
function envelope(result: unknown) {
  if (Buffer.byteLength(JSON.stringify(result)) > 256000) throw new DomainError('CONFLICT', 'Metadata response exceeds the read limit; use a narrower page or exact definition');
  return { version: 1 as const, result };
}
function paginate<T>(items: T[], query: { limit: number; offset: number }) {
  return { items: items.slice(query.offset, query.offset + query.limit), total: items.length, page: { ...query, hasMore: items.length > query.offset + query.limit } };
}

/** One permission and version boundary serves HTTP, MCP and the review page. */
export class DefinitionService {
  constructor(private readonly jobs: JobStore, private readonly tasks: TaskService, private readonly catalog: ExecutionCatalog) {}
  get secured() { return this.jobs.security.enabled; }
  private context(principal: Principal, ontologyId: string, management = false) {
    if (this.secured) this.jobs.security.agentContext(principal);
    const owner = ownerKey(principal), admin = principal.scopes.includes('ontology:admin');
    this.jobs.definitions.assertAccess(owner, ontologyId, admin);
    if (management) this.jobs.definitions.assertManagement(owner, ontologyId, admin);
    return { owner, admin };
  }
  private ownedDraft(principal: Principal, ontologyId: string, id: string, management = false) {
    this.context(principal, ontologyId, management);
    const draft = this.jobs.definitions.draft(id);
    if (draft.ontologyId !== ontologyId) throw new DomainError('NOT_FOUND', 'Draft is not available in this ontology');
    return draft;
  }
  private document(principal: Principal, args: { ontologyId: string; draftId?: string; release?: z.infer<typeof ontologyReleaseRefSchema> }) {
    this.context(principal, args.ontologyId);
    if (args.draftId && args.release) invalid('Choose either a draft or an immutable release');
    if (args.draftId) return { document: this.ownedDraft(principal, args.ontologyId, args.draftId).document, publication: 'draft' as const, release: undefined };
    if (args.release && args.release.ontologyId !== args.ontologyId) invalid('Release belongs to another ontology');
    const release = args.release ? this.jobs.definitions.resolve(args.release) : this.jobs.definitions.active(args.ontologyId);
    return { document: release.document, publication: 'published' as const, release: release.ref };
  }
  private permission(principal: Principal, namespace: { owner: string | null }) {
    const manager = namespace.owner === ownerKey(principal) || principal.scopes.includes('ontology:admin');
    return { read: principal.scopes.includes('ontology:read'), createOntology: principal.scopes.includes('ontology:write'), edit: manager && principal.scopes.includes('ontology:write'), publish: manager && principal.scopes.includes('ontology:publish'), execute: principal.scopes.includes('ontology:object_write') && principal.scopes.includes('tasks:write') };
  }
  private withTask<T>(principal: Principal, ontologyId: string, taskId: string, operation: 'task.query' | 'task.result.read', action: (job: Job, visible: Job) => T): T {
    const visible = this.tasks.get(principal, taskId), owner = ownerKey(principal);
    const read = () => {
      // The public TaskView intentionally omits the execution ledger. Load it
      // only after authorization, and keep all reads inside the current scope.
      const job = this.jobs.get(owner, taskId);
      if (this.jobs.ontologyReleaseForJob(owner, job).ontologyId !== ontologyId) throw new DomainError('NOT_FOUND', 'Task is not available in this ontology');
      return action(job, visible);
    };
    if (!this.secured) return read();
    return this.jobs.security.withAgent(principal, taskId, operation, scope => {
      const policy = this.jobs.security.policies, result = policy.readSnapshot(read);
      if (scope.lineage.size) policy.requireRecipient(scope, policy.outputEnvelope(owner), 'agent_response');
      else if (!scope.grant!.channels.includes('agent_response')) throw new SecurityError('OUTPUT_NOT_ALLOWED');
      return result;
    });
  }
  query(principal: Principal, input: unknown) {
    if (!this.secured) return this.queryInternal(principal, input);
    this.jobs.security.agentContext(principal);
    const result = this.queryInternal(principal, input);
    this.jobs.security.agentContext(principal);
    return result;
  }
  private queryInternal(principal: Principal, input: unknown) {
    requireScope(principal, 'ontology:read'); const query = definitionQuerySchema.parse(input), store = this.jobs.definitions;
    if (this.secured && !foundationQueries.includes(query.operation)) throw new DomainError('FORBIDDEN', 'This metadata query requires a separately reviewed Foundation interface');
    if (query.operation === 'list_ontologies') return envelope(paginate(store.namespaces(ownerKey(principal), principal.scopes.includes('ontology:admin')).map(namespace => ({ ...namespace, permissions: this.permission(principal, namespace) })), query));
    this.context(principal, query.ontologyId, this.secured && ['get_ontology', 'get_pipeline_intake'].includes(query.operation));
    if (query.operation === 'get_pipeline_intake') {
      const selected = this.document(principal, query), ref = selected.document.pipeline?.find(value => value.serviceId === query.serviceId);
      if (!ref) throw new DomainError('NOT_FOUND', 'Service intake is not attached to this ontology version');
      return envelope({ ...ref, publication: selected.publication, release: selected.release, intake: store.pipeline.intake(query.ontologyId, ref) });
    }
    if (query.operation === 'get_pipeline_task_uses' || query.operation === 'get_pipeline_task_changes' || query.operation === 'get_pipeline_fact') {
      return this.withTask(principal, query.ontologyId, query.taskId, 'task.query', job => {
        if (query.operation === 'get_pipeline_fact') {
          this.jobs.ontologyForJob(ownerKey(principal), job).read(ownerKey(principal), query.object);
          const state = this.jobs.pipelineFacts.current(ownerKey(principal), query.ontologyId, query.object);
          if (!state) throw new DomainError('NOT_FOUND', 'No pipeline observation exists for this object');
          const { properties: _privateProperties, semanticDigest: _privateDigest, sourceKey: _sourceKey, ...provenance } = state;
          return envelope(provenance);
        }
        if (query.operation === 'get_pipeline_task_uses') {
          const uses = store.pipeline.uses(ownerKey(principal), job.id);
          return envelope({ items: !this.secured ? uses : uses.filter(use => {
            const intake = store.pipeline.intake(use.release.ontologyId, use), policy = this.jobs.security.policies;
            try { policy.requireSource(policy.scope(ownerKey(principal)), intake.programRef.id, intake.configurationDigest); return true; }
            catch (error) { if (error instanceof SecurityError && error.reason === 'SOURCE_NOT_AUTHORIZED') return false; throw error; }
          }) });
        }
        return envelope({ items: this.jobs.ontologyForJob(ownerKey(principal), job).pipelineChanges(ownerKey(principal), job.id, job.delegation!.request.revision) });
      });
    }
    if (query.operation === 'discover_task_actions') {
      return this.withTask(principal, query.ontologyId, query.taskId, 'task.query', job => {
        const owner = ownerKey(principal), graph = this.jobs.ontologyForJob(owner, job);
        if (!job.delegation) throw new DomainError('NOT_FOUND', 'Task is not available in this ontology');
        return envelope(this.catalog.discoverActions(graph, owner, job.delegation.request, query.query));
      });
    }
    if (query.operation === 'get_ontology') { const namespace = store.namespace(query.ontologyId); return envelope({ ...namespace, permissions: this.permission(principal, namespace) }); }
    if (query.operation === 'list_definitions' || query.operation === 'get_definition') {
      const selected = this.document(principal, query), all = resources(selected.document);
      if (query.operation === 'get_definition') {
        const item = all.find(item => item.kind === query.kind && item.definition.resourceId === query.resourceId);
        if (!item) throw new DomainError('NOT_FOUND', 'Definition is not available');
        const graph = selected.release ? this.jobs.ontologyForRelease(selected.release) : undefined;
        return envelope({ ...item, publication: selected.publication, release: selected.release, readOnly: immutable(item.definition.resourceId),
          ...(item.kind === 'action' ? { availability: graph ? this.catalog.actionAvailability(graph, ownerKey(principal), item.definition.id) : { status: 'definition_only', reason: 'Drafts are not executable' } } : {}),
          dependencies: this.dependencies(item.kind, item.definition) });
      }
      const search = query.search?.toLowerCase();
      const items = all.filter(item => (!query.kind || item.kind === query.kind) && (!query.customOnly || !/^(builtin:|generated:)/.test(item.definition.resourceId)) && (!search || [item.definition.id, item.definition.description, 'name' in item.definition ? item.definition.name : ''].some(value => String(value).toLowerCase().includes(search))))
        .map(item => ({ kind: item.kind, resourceId: item.definition.resourceId, id: item.definition.id, name: 'name' in item.definition ? item.definition.name : item.definition.id, description: item.definition.description.slice(0, 400), readOnly: immutable(item.definition.resourceId), publication: selected.publication }))
        .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
      return envelope({ ...paginate(items, query), release: selected.release, publication: selected.publication });
    }
    if (query.operation === 'list_drafts') return envelope(store.draftPage(query.ontologyId, query));
    if (query.operation === 'get_draft' || query.operation === 'diff_draft' || query.operation === 'validate_draft') {
      const draft = this.ownedDraft(principal, query.ontologyId, query.draftId);
      if (query.operation === 'get_draft') return envelope(summary(draft));
      if (query.operation === 'validate_draft') {
        if (!principal.scopes.includes('ontology:write') && !principal.scopes.includes('ontology:publish')) throw new DomainError('FORBIDDEN', 'Draft validation requires edit or publish permission');
        this.context(principal, query.ontologyId, true);
        const validation = store.validate(draft.id);
        return envelope({ ...validation, changes: validation.changes.slice(0, 50), changeCount: validation.changes.length, issues: validation.issues.slice(0, 50), issueCount: validation.issues.length, unboundSourceFields: validation.unboundSourceFields.slice(0, 50), unboundSourceFieldCount: validation.unboundSourceFields.length });
      }
      const changes = paginate(store.changes(draft), query);
      return envelope({ draft: summary(draft), changes: changes.items, total: changes.total, page: changes.page });
    }
    if (query.operation === 'list_releases') return envelope(store.releasePage(query.ontologyId, query));
    if (query.operation === 'get_release') {
      if (query.release.ontologyId !== query.ontologyId) invalid('Release belongs to another ontology');
      const release = store.resolve(query.release);
      return envelope({ ref: release.ref, sequence: release.sequence, createdAt: release.createdAt, model: release.model.ref, counts: { objects: release.document.objects.length, interfaces: release.document.interfaces.length, links: release.document.links.length, actions: release.document.actions.length }, active: store.namespace(query.ontologyId).active.digest === release.ref.digest });
    }
    if (query.operation === 'get_action_task') {
      return this.withTask(principal, query.ontologyId, query.taskId, 'task.result.read', (_job, visible) => envelope({ task: taskSummary(visible) }));
    }
    return envelope({ items: store.events(query.ontologyId, query.limit) });
  }
  command(principal: Principal, input: unknown) {
    if (!this.secured) return this.commandInternal(principal, input);
    return this.jobs.transaction(() => {
      this.jobs.security.agentContext(principal);
      const result = this.commandInternal(principal, input);
      this.jobs.security.agentContext(principal);
      return result;
    });
  }
  private commandInternal(principal: Principal, input: unknown) {
    if (Buffer.byteLength(JSON.stringify(input)) > 48000) invalid('One metadata command is limited to 48 KB; edit one bounded definition at a time');
    const command = definitionCommandSchema.parse(input), publish = ['publish_draft', 'activate_release', 'verify_pipeline_task', 'report_pipeline_source_change', 'revoke_pipeline_verification', 'prepare_pipeline_validation'].includes(command.operation);
    if (this.secured && !foundationCommands.includes(command.operation)) throw new DomainError('FORBIDDEN', 'This metadata edit requires a separately reviewed Foundation interface');
    requireScope(principal, publish ? 'ontology:publish' : 'ontology:write');
    const store = this.jobs.definitions, owner = ownerKey(principal), admin = principal.scopes.includes('ontology:admin');
    if (command.operation === 'create_ontology') return envelope(store.createNamespace(owner, { ...(command.id ? { id: command.id } : {}), name: command.name }));
    this.context(principal, command.ontologyId, true);
    if (command.operation === 'prepare_pipeline_validation') {
      const { operation: _operation, ...request } = command;
      return envelope({ task: taskSummary(this.tasks.preparePipelineValidation(principal, request)), authorization: 'per_action_required', validationOnly: true });
    }
    if (command.operation === 'create_draft') return envelope(summary(store.createDraft(owner, command.ontologyId, command.title, admin)));
    if (command.operation === 'activate_release') {
      if (command.release.ontologyId !== command.ontologyId) invalid('Release belongs to another ontology');
      if (this.secured) this.jobs.security.policies.assertModel(store.resolve(command.release).model);
      return envelope(store.activate(owner, command.release, command.expectedGeneration, admin));
    }
    if (command.operation === 'report_pipeline_source_change' || command.operation === 'revoke_pipeline_verification') {
      if (!store.active(command.ontologyId).document.pipeline?.some(ref => ref.serviceId === command.serviceId)) throw new DomainError('NOT_FOUND', 'Published service intake is unavailable');
      return envelope(store.pipeline.event(command.ontologyId, owner, command.serviceId, command.operation === 'report_pipeline_source_change'
        ? { kind: 'source_changed', sourceDigest: command.sourceDigest } : { kind: 'verification_revoked', verificationId: command.verificationId }));
    }
    const currentDraft = this.ownedDraft(principal, command.ontologyId, command.draftId, true);
    if (command.operation === 'put_pipeline_intake') return envelope(summary(store.putPipeline(owner, command.draftId, command.expectedRevision, command.intake, admin)));
    if (command.operation === 'validate_pipeline_intake') return envelope(store.validatePipeline(owner, command.draftId, command.expectedRevision, command.serviceId, command.expiresAt, admin));
    if (command.operation === 'verify_pipeline_task') {
      const value = store.pipelineDraft(owner, command.draftId, command.expectedRevision, command.serviceId, admin);
      return this.jobs.transaction(() => this.withTask(principal, command.ontologyId, command.taskId, 'task.result.read', (job, visible) => {
        if (this.jobs.security.enabled && (!('accepted' in visible) || visible.accepted !== true || !('outputStatus' in visible) || visible.outputStatus !== 'available'))
          throw new DomainError('FORBIDDEN', 'Verification requires the currently authorized accepted task result');
        return envelope(store.pipeline.verifyTask(command.ontologyId, owner, value.ref, value.model, job, id => this.jobs.intent(owner, id), command.expiresAt));
      }));
    }
    if (command.operation === 'put_definition') {
      const existing = resources(currentDraft.document).find(item => item.kind === command.kind && (item.definition.resourceId === command.definition.resourceId || item.definition.id === command.definition.id));
      if (immutable(String(command.definition.resourceId ?? '')) || existing && immutable(existing.definition.resourceId)) throw new DomainError('FORBIDDEN', 'Generated execution relationships are read-only');
      return envelope(summary(store.putResource(owner, command.draftId, command.expectedRevision, command.kind, command.definition, admin)));
    }
    if (command.operation === 'retire_definition') {
      if (immutable(command.resourceId)) throw new DomainError('FORBIDDEN', 'Generated execution relationships are read-only');
      return envelope(summary(store.retireResource(owner, command.draftId, command.expectedRevision, command.resourceId, admin)));
    }
    if (command.operation === 'publish_draft') return this.jobs.transaction(() => {
      const published = store.publish(owner, command.draftId, command.expectedRevision, admin);
      if (this.secured) this.jobs.security.policies.assertModel(store.resolve(published.release).model);
      return envelope(published);
    });
    return envelope(store.discard(owner, command.draftId, command.expectedRevision, admin));
  }
  prepare(principal: Principal, input: unknown) {
    requireScope(principal, 'ontology:read'); const args = prepareOntologyActionSchema.parse(input);
    this.context(principal, args.ontologyId);
    const owner = ownerKey(principal), prepared = this.tasks.prepareOntologyAction(principal, args), job = this.jobs.get(owner, prepared.id), graph = this.jobs.ontologyForJob(owner, job);
    const inspect = () => {
      const selected = job.delegation!.callerAction!, step = job.delegation!.agent!.plans[0]!.steps[0]!, intent = this.jobs.intent(owner, step.intentId);
      let preview = (intent.lastVerifiedResult?.output?.source as { preview?: ManagedActionPreview } | undefined)?.preview;
      let status = intent.state === 'effect_confirmed' ? 'committed' : 'prepared';
      if (!preview) {
        try { const current = previewDeclarativeAction(graph, owner, selected.action, selected.input); if (current.digest === step.objectWrite?.previewDigest) preview = current; else status = 'stale'; }
        catch (error) { if (error instanceof DomainError && ['CONFLICT', 'NOT_FOUND'].includes(error.code)) status = 'stale'; else throw error; }
      }
      if (preview && preview.digest !== step.objectWrite?.previewDigest) throw new DomainError('CONFLICT', 'Original mutation preview does not match its Intent');
      return envelope({ task: taskSummary(this.secured ? prepared : job), preview: { status, planDigest: job.delegation!.agent!.plans[0]!.digest, digest: step.objectWrite!.previewDigest, scope: step.objectWrite, ...(preview ? { objects: preview.objects, links: preview.links, result: preview.result } : {}) } });
    };
    return this.secured ? this.jobs.security.withAgent(principal, job.id, 'task.query', scope => {
      graph.read(owner, { type: 'ServiceRequest', id: job.id });
      const result = inspect(); scope.policies.requireRecipient(scope, scope.policies.outputEnvelope(owner), 'agent_response'); return result;
    }) : inspect();
  }
  approve(principal: Principal, input: unknown) {
    requireScope(principal, 'ontology:object_write');
    const { taskId, ...permit } = approveOntologyActionSchema.parse(input);
    this.context(principal, permit.objectWrite.ontologyRelease.ontologyId);
    const authorized = this.tasks.authorize(principal, taskId, { ...permit, action: 'approve_object_write', environment: 'managed' });
    return envelope({ task: taskSummary(this.secured ? authorized : this.jobs.get(ownerKey(principal), authorized.id)) });
  }
  private dependencies(kind: DefinitionKind, definition: DefinitionResource): string[] {
    const value = definition as unknown as Record<string, unknown>;
    if (kind === 'link') return [(value.from as { type: string }).type, (value.to as { type: string }).type];
    const dependencies = new Set<string>();
    if (kind === 'action') {
      [...Object.values(value.inputs as Record<string, string>), ...((value.resultTypes ?? []) as string[]), ...(value.changes as string[]).map(path => path.split('.')[0]!)].forEach(item => dependencies.add(item));
      const implementation = value.implementation as { kind?: string; handlerRef?: { id: string; version: string }; mutations?: { op: string; type?: string }[] } | undefined;
      if (implementation?.handlerRef) dependencies.add(`handler:${implementation.handlerRef.id}@${implementation.handlerRef.version}`);
      for (const mutation of implementation?.mutations ?? []) if (mutation.type) dependencies.add((['add_link', 'remove_link'].includes(mutation.op) ? 'link:' : '') + mutation.type);
    } else {
      for (const property of Object.values((value.properties ?? {}) as Record<string, { derived?: string }>)) if (property.derived) dependencies.add('function:' + property.derived);
      if (kind === 'object') for (const item of (value.interfaces ?? []) as { id: string; actionMap?: Record<string, { actionId: string }> }[]) { dependencies.add(item.id); for (const mapping of Object.values(item.actionMap ?? {})) dependencies.add('action:' + mapping.actionId); }
      else {
        for (const parent of (value.parents ?? []) as string[]) dependencies.add(parent);
        for (const link of (value.links ?? []) as { target: string }[]) dependencies.add(link.target);
        for (const action of (value.actions ?? []) as { inputs: Record<string, string>; resultTypes?: string[] }[]) [...Object.values(action.inputs), ...(action.resultTypes ?? [])].forEach(item => dependencies.add(item));
      }
    }
    return [...dependencies].sort();
  }
}
