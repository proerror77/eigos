import {digest} from '../core/identity.js';
import {resourceGroups} from '../ontology/resource-mapping.js';
import { PublicPlaceCatalogue } from '../capabilities/public-places/catalogue.js';
import { listPublicPlacesSchema, publishPublicPlaceSchema, withdrawPublicPlaceSchema } from '../ontology/public-places.js';
import {
  EntityResolution,
  bindEntitySchema,
  entityLookupSchema,
  entityHistorySchema,
} from './entity-resolution.js';
import { Applications, objectViewSchema, graphSchema, mapSchema } from './applications.js';
import { Automation, workflowSchema, saveRuleSchema, runWorkflowSchema, automationPreviewSchema, publishWorkflowSchema, withdrawWorkflowSchema, runPublishedWorkflowSchema } from './automation.js';
import { analyzeMachinery, listMachineryProcesses, machineryAnalysisSchema } from './machinery-analysis.js';
import { ingestMachineryHistory, machineryHistorySchema } from './machinery-history.js';
import { MachineryReviews, machineryReviewSchema } from './machinery-reviews.js';
import { processStatusSchema } from './process-automation.js';
import {
  SemanticSearch,
  semanticConfigureSchema,
  semanticIndexSchema,
  semanticSearchSchema,
  semanticStatusSchema,
} from './semantic.js';
import {
  OntologyPackages,
  exportPackageSchema,
  importPackageSchema,
  migrateDefinitionsSchema,
  migrateOntologyDataSchema,
  readDataMigrationSchema,
} from './ontology-packages.js';
import { Tasks, publicTask, type TaskResultProjection } from './tasks.js';
import type { Actions } from './actions.js';
import { z } from 'zod';
import type { Principal } from '../core/identity.js';
import { Conflict, PermissionDenied, requireScope } from '../core/identity.js';
import { machineryModelSchema, objectRefSchema, ontologyName } from '../ontology/schema.js';
import { Access } from './access.js';
import { Database } from './database.js';
import { Metadata } from './metadata.js';
import { ScenarioEvaluations, compareScenariosSchema, trialScenariosSchema, saveEvaluationSuiteSchema, runEvaluationSuiteSchema, promoteEvaluationSchema, evaluationCasesFromSetSchema } from './scenario-evaluation.js';
import { Scenarios, continueScenarioSchema } from './scenarios.js';
import { Objects } from './objects.js';
import {
  ObjectSets,
  evaluateSetViewSchema,
  aggregateSetViewSchema,
  saveSetSchema,
  listSetsSchema,
} from './object-sets.js';
import { Indexing, indexingInputSchema } from './indexing.js';
import { Materializations, materializationInputSchema } from './materializations.js';
import { EditHistory, conflictPolicySchema, setConflictPolicy } from './edit-history.js';
import { ExecutionTrace, executionTraceSchema } from './execution-trace.js';
import { actionBatchSchema, actionCallSchema } from '../ontology/invocation.js';
import { actionLogSchema, listActionLog } from './action-log.js';
import {
  Governance,
  projectSchema,
  assignProjectSchema,
  branchCreateSchema,
  branchRevisionSchema,
  branchReviewSchema,
  branchUpdateSchema,
} from './governance.js';
import { Effects } from './effects.js';
import type { Functions } from './functions.js';
import type { Bindings } from './metadata.js';

export function ontologyServices(
  db: Database,
  metadata: Metadata,
  bindings: Bindings & { projectTaskResult: TaskResultProjection },
  functions: Functions,
  effects: Effects,
  actions: Actions,
  ontologyId = 'Eigos',
) {
  const active = () => metadata.active(ontologyId);
  const applications = new Applications(db),
    automation = new Automation(db, metadata, actions),
    machinery = new MachineryReviews(db, metadata, new ScenarioEvaluations(db, actions, functions)),
    semantic = new SemanticSearch(db, functions),
    packages = new OntologyPackages(db, metadata, bindings);
  const sets = new ObjectSets(db),
    indexing = new Indexing(db, metadata),
    materializations = new Materializations(db),
    governance = new Governance(db, metadata, bindings);
  const idSchema = z.strictObject({ id: z.uuid() }),
    ontology = z.strictObject({ ontology: z.string().default('Eigos') });
  const services = new Map<
    string,
    {
      schema: z.ZodType;
      description: string;
      invoke: (principal: Principal, input: unknown) => Promise<unknown>;
    }
  >();
  const register = <S extends z.ZodType>(
    name: string,
    description: string,
    schema: S,
    write: boolean,
    run: (access: Access, input: z.output<S>) => Promise<unknown>,
  ) => {
    services.set(name, {
      schema,
      description,
      invoke: async (principal, raw) => {
        requireScope(principal, write ? 'ontology:write' : 'ontology:read');
        const access = await Access.load(db, principal),
          result = await run(access, schema.parse(raw));
        if (!write && !(await access.canReturn(access.dataRequirements())))
          throw new PermissionDenied('Result permissions changed');
        return result;
      },
    });
  };
  const define = async (access:Access) => {
    const model=await active();
    access.require(model.document.id,'edit_definition',model.document.id);
    return model;
  };
  register('workbench_access','Report the verified account’s Workbench role and available editing scope.',
    z.strictObject({}),false,async a=>{
      const model=await active(), ontology=model.document.id;
      a.require(ontology,'view_definition',ontology);
      const role=a.workbenchRole(ontology), writable=a.principal.scopes.includes('ontology:write');
      return {role,ontology,version:model.document.version,
        canAuthorWorkflows:writable && a.allows({ontology,resource:ontology,permission:'edit_definition'}),
        canPublishWorkflows:writable && role==='admin'};
    });
  register('published_workflows','List compatible published Workflows the caller can use.',
    z.strictObject({}),false,async a=>automation.listPublishedWorkflows(a,await active()));
  register('publish_workflow','Publish an exact Workflow draft revision for authorized users.',
    publishWorkflowSchema,true,async(a,input)=>automation.publishWorkflow(a,await active(),input));
  register('withdraw_workflow','Withdraw an exact published Workflow revision.',
    withdrawWorkflowSchema,true,async(a,input)=>automation.withdrawWorkflow(a,await active(),input));
  register('run_published_workflow','Execute an exact published Workflow revision against the caller’s authorized object.',
    runPublishedWorkflowSchema,true,async(a,input)=>automation.runPublishedWorkflow(a,await active(),input));
  const view = async (access: Access, scenarioId?: string) => {
    const model = await active();
    return scenarioId ? new Scenarios(db).view(access, model, scenarioId) : model;
  };
  register(
    'evaluate_set',
    'Evaluate a composed or saved object set with current permissions.',
    evaluateSetViewSchema,
    false,
    async (a, { scenarioId, ...input }) => sets.evaluate(a, await view(a, scenarioId), input),
  );
  register(
    'aggregate_set',
    'Group and aggregate a complete authorized object set.',
    aggregateSetViewSchema,
    false,
    async (a, { scenarioId, ...input }) => sets.aggregate(a, await view(a, scenarioId), input),
  );
  register(
    'save_set',
    'Save static membership or a dynamic set definition with explicit readers.',
    saveSetSchema,
    true,
    async (a, input) => sets.save(a, await active(), input),
  );
  register(
    'get_set',
    'Read a saved object set definition permitted to this identity.',
    idSchema,
    false,
    async (a, input) => sets.get(a, await active(), input.id),
  );
  register('list_sets', 'List owned and shared set definitions.', listSetsSchema, false, async (a, input) =>
    sets.list(a, await active(), input),
  );
  register(
    'delete_set',
    'Delete an owned saved set at its reviewed revision.',
    idSchema.extend({ revision: z.number().int().positive() }),
    true,
    async (a, input) => sets.remove(a, await active(), input.id, input.revision),
  );
  register(
    'submit_index',
    'Submit an authorized source transaction with ordered offset.',
    indexingInputSchema,
    true,
    async (a, input) => indexing.submit(a, await active(), input),
  );
  register('index_status', 'Read durable source indexing progress.', idSchema, false, async (a, input) =>
    indexing.inspect(a, await active(), input.id),
  );
  register(
    'retry_index',
    'Retry a failed source transaction with its original identity.',
    idSchema,
    true,
    async (a, input) => indexing.retry(a, await active(), input.id),
  );
  register(
    'cancel_index',
    'Cancel an owned source transaction and skip its ordered offset.',
    idSchema,
    true,
    async (a, input) => indexing.cancel(a, await active(), input.id),
  );
  register(
    'materialize',
    'Capture resolved objects and links in an atomic authorized dataset.',
    materializationInputSchema,
    true,
    async (a, input) => materializations.capture(a, await active(), input),
  );
  register(
    'read_materialization',
    'Read a captured dataset after current object and property authorization.',
    idSchema.extend({ cursor: z.string().optional() }),
    false,
    async (a, input) => materializations.read(a, await active(), input.id, input.cursor),
  );
  register(
    'materialized_links',
    'Read authorized relationships from a materialization.',
    idSchema.extend({ after: z.number().int().min(0).optional() }),
    false,
    async (a, input) => materializations.links(a, await active(), input.id, input.after),
  );
  register(
    'edit_history',
    'Read object edit history under current security policies.',
    z.strictObject({
      object: objectRefSchema,
      after: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    false,
    async (a, input) =>
      new EditHistory(db).read(new Objects(db, await active(), a), input.object, input.after, input.limit),
  );
  register(
    'execution_trace',
    'Read causal identities and states for an owned task or committed Action.',
    executionTraceSchema,
    false,
    (a, input) => new ExecutionTrace(db, metadata).read(a, ontologyId, input),
  );
  register(
    'validate_action',
    'Check a published Action’s parameters, object access and submission criteria without executing it.',
    actionCallSchema,
    true,
    async (a, input) => actions.validate(a, await view(a, input.scenarioId), input),
  );
  register(
    'apply_action_batch',
    'Atomically submit up to 20 live declarative Actions without declared effects or Scenario merges, each with its own request ID.',
    actionBatchSchema,
    true,
    async (a, input) => actions.applyBatch(a, await active(), input),
  );
  register(
    'list_action_log',
    'List committed Action receipts for one publication using current Action definition permissions.',
    actionLogSchema,
    false,
    (a, input) => listActionLog(db, metadata, a, ontologyId, input),
  );
  register(
    'edit_policy',
    'Configure source and user edit conflict resolution.',
    z.strictObject({ type: z.string(), policy: conflictPolicySchema }),
    true,
    async (a, input) => setConflictPolicy(db, a, await active(), input.type, input.policy),
  );
  register(
    'project',
    'Create or update a project for Ontology resource ownership.',
    projectSchema,
    true,
    (a, input) => governance.project(a, input),
  );
  if (ontologyId === 'Eigos') {
    const publicPlaces = new PublicPlaceCatalogue(db, metadata, actions);
    register('list_public_places', 'List explicitly published places in an authorized organization project.',
      listPublicPlacesSchema, false, (access, input) => publicPlaces.list(access, input));
    register('publish_public_place', 'Publish or revise reviewed public location fields in an organization project.',
      publishPublicPlaceSchema, true, (access, input) => publicPlaces.publish(access, input));
    register('withdraw_public_place', 'Withdraw a published location at its reviewed revision.',
      withdrawPublicPlaceSchema, true, (access, input) => publicPlaces.withdraw(access, input));
  }
  register(
    'assign_project',
    'Assign published resources to a project.',
    assignProjectSchema,
    true,
    (a, input) => governance.assign(a, input),
  );
  register(
    'create_branch',
    'Create an isolated Ontology definition branch.',
    branchCreateSchema,
    true,
    (a, input) => governance.create(a, input),
  );
  register('get_branch', 'Inspect a definition branch and proposal.', idSchema, false, (a, input) =>
    governance.read(a, input.id),
  );
  register('list_branches', 'List accessible Ontology branches.', ontology, false, (a, input) =>
    governance.list(a, input.ontology),
  );
  register(
    'update_branch',
    'Update a branch at its expected revision.',
    branchUpdateSchema,
    true,
    (a, input) => governance.update(a, input),
  );
  register(
    'prepare_branch',
    'Validate branch bindings and prepare a candidate projection.',
    branchRevisionSchema,
    true,
    (a, input) => governance.prepare(a, input),
  );
  register(
    'review_branch',
    'Approve the exact candidate publication for a branch.',
    branchReviewSchema,
    true,
    (a, input) => governance.review(a, input),
  );
  register(
    'merge_branch',
    'Activate a reviewed candidate publication atomically.',
    branchReviewSchema,
    true,
    (a, input) => governance.merge(a, input),
  );
  register(
    'rebase_branch',
    'Rebase a branch onto the current Ontology definition.',
    branchRevisionSchema,
    true,
    (a, input) => governance.rebase(a, input),
  );
  register(
    'catch_up_branch',
    'Synchronize candidate data and require a fresh proposal review.',
    branchRevisionSchema,
    true,
    (a, input) => governance.catchUp(a, input),
  );
  register(
    'function_versions',
    'List registered function versions visible to this identity.',
    z.strictObject({}),
    false,
    async (a) => {
      const model = await active();
      return functions
        .versions()
        .filter((fn) => model.functions.has(fn.name) && a.canDefine(model, 'function', fn.name));
    },
  );
  register(
    'effect_status',
    'Read Action effect delivery state.',
    z.strictObject({ requestId: z.string().min(1).max(128) }),
    false,
    (a, input) => effects.status(a, input.requestId),
  );
  register(
    'retry_effect',
    'Retry a failed Action effect using its stable idempotency key.',
    z.strictObject({ id: z.string().regex(/^[a-f0-9]{64}$/) }),
    true,
    (a, input) => effects.retry(a, input.id),
  );
  register(
    'raw_definition',
    'Read the complete definition for authorized editing.',
    z.strictObject({}),
    false,
    async (a) => {
      const model = await active();
      a.require(model.document.id, 'view_definition', model.document.id);
      if (a.workbenchRole(model.document.id)==='member') throw new PermissionDenied('Ontology management requires service team access');
      return model.document;
    },
  );
  register(
    'read_object',
    'Read one authorized object.',
    z.strictObject({ object: objectRefSchema, scenarioId: z.uuid().optional() }),
    false,
    async (a, input) => new Objects(db, await view(a, input.scenarioId), a).read(input.object),
  );
  register(
    'follow_links',
    'Read up to 100 objects related by a published Link. Use query_ontology with from and cursor for larger relationships.',
    z.strictObject({ object: objectRefSchema, link: z.string(), scenarioId: z.uuid().optional() }),
    false,
    async (a, input) => new Objects(db, await view(a, input.scenarioId), a).follow(input.object, input.link, input.object.type, 100),
  );
  register(
    'object_view',
    'Read the configured object view.',
    z.strictObject({ type: z.string() }),
    false,
    async (a, input) => applications.view(a, await active(), input.type),
  );
  register(
    'save_object_view',
    'Save an object view configuration.',
    objectViewSchema,
    true,
    async (a, input) => applications.saveView(a, await active(), input),
  );
  register(
    'explore_graph',
    'Expand relationships from an authorized object.',
    graphSchema.extend({ scenarioId: z.uuid().optional() }),
    false,
    async (a, { scenarioId, ...input }) => applications.graph(a, await view(a, scenarioId), input),
  );
  register(
    'map_objects',
    'Read authorized object coordinates.',
    mapSchema.extend({ scenarioId: z.uuid().optional() }),
    false,
    async (a, { scenarioId, ...input }) => applications.map(a, await view(a, scenarioId), input),
  );
  register(
    'semantic_configure',
    'Configure a published embedding Function and vector index.',
    semanticConfigureSchema,
    true,
    async (a, input) => semantic.configure(a, await active(), input),
  );
  register(
    'semantic_index',
    'Index authorized current object text using the configured embedding Function.',
    semanticIndexSchema,
    true,
    async (a, input) => semantic.index(a, await active(), input),
  );
  register(
    'semantic_search',
    'Search authorized objects by meaning in the live Ontology or a Scenario. Pass from for documents linked to a business object.',
    semanticSearchSchema.extend({ scenarioId: z.uuid().optional() }),
    false,
    async (a, { scenarioId, ...input }) => semantic.search(a, await view(a, scenarioId), input),
  );
  register(
    'semantic_status',
    'Read semantic index coverage and model binding in the live Ontology or a Scenario.',
    semanticStatusSchema.extend({ scenarioId: z.uuid().optional() }),
    false,
    async (a, { scenarioId, name }) => semantic.status(a, await view(a, scenarioId), name),
  );
  register(
    'export_package',
    'Export authorized ontology resources with dependency closure.',
    exportPackageSchema,
    false,
    (a, input) => packages.export(a, input),
  );
  register(
    'import_package',
    'Prepare a shared or copied package import as a definition proposal.',
    importPackageSchema,
    true,
    (a, input) => packages.import(a, input),
  );
  register(
    'migrate_definitions',
    'Map resources into another Ontology through a proposal.',
    migrateDefinitionsSchema,
    true,
    (a, input) => packages.migrate(a, input),
  );
  register(
    'open_scenario_session',
    'Open a session for temporary scenarios.',
    z.strictObject({ ttlSeconds: z.number().int().min(60).max(86400).optional() }),
    true,
    (a, input) => new Scenarios(db).openSession(a, input.ttlSeconds),
  );
  register(
    'close_scenario_session',
    'Close the session and clean its temporary scenarios.',
    z.strictObject({ sessionId: z.uuid() }),
    true,
    (a, input) => new Scenarios(db).closeSession(a, input.sessionId),
  );
  const evaluations = new ScenarioEvaluations(db, actions, functions);
  register('trial_candidate_scenarios','Run an offline trial against a prepared definition and release projection without activating it.',
    z.strictObject({release:z.string().regex(/^[0-9a-f]{64}$/),trial:trialScenariosSchema}),true,async(a,input)=>{
      requireScope(a.principal,'ontology:read');
      const current=await active();
      a.require(current.document.id,'edit_definition',current.document.id);
      const candidate=await metadata.get(input.release);
      if(candidate.document.id!==current.document.id)throw new Conflict('Candidate belongs to another Ontology');
      metadata.checkBindings(candidate,bindings);
      return evaluations.trial(a,candidate,input.trial,current.release);
    });
  register('evaluation_suites','List saved evaluation suites and run references.',
    z.strictObject({}),false,async a=>evaluations.listSuites(a,await active()));
  register('evaluation_cases_from_set','Generate trial case inputs from authorized Object Set members and their current revisions.',
    evaluationCasesFromSetSchema,false,async(a,input)=>evaluations.casesFromSet(a,await active(),input));
  register('save_evaluation_suite','Save a revisioned Scenario trial, optionally scoped to a Machinery Object Set.',
    saveEvaluationSuiteSchema,true,async(a,input)=>evaluations.saveSuite(a,await active(),input));
  register('run_evaluation_suite','Run a saved revision and retain a release-bound result receipt.',
    runEvaluationSuiteSchema,true,async(a,input)=>{
      requireScope(a.principal,'ontology:read');
      return evaluations.runSuite(a,await active(),input);
    });
  register('promote_evaluation_candidate','Re-evaluate a selected trial result and create a persisted Scenario for invited reviewers.',
    promoteEvaluationSchema,true,async(a,input)=>{
      requireScope(a.principal,'ontology:read');
      return evaluations.promote(a,await active(),input);
    });
  register('scenario_continuation_sources','List owned temporary or previous-release drafts eligible for a continuation attempt.',
    z.strictObject({}),false,async a=>new Scenarios(db).continuationSources(a,await active()));
  register('continue_scenario','Replay a compatible Scenario journal into a new persisted draft with fresh review.',
    continueScenarioSchema,true,async (a,input)=>new Scenarios(db).continueScenario(a,await active(),input));
  register('preview_automation', 'Evaluate a saved automation against Scenario revisions and preview its Actions without enqueuing a live run.',
    automationPreviewSchema,true,async (a,input)=>automation.preview(a,await define(a),input));
  register(
    'scenario_trial_options',
    'List the authorized Actions and read-only Functions available for an offline Scenario trial.',
    z.strictObject({}),
    false,
    async (access) => evaluations.options(access, await active()),
  );
  register(
    'compare_scenarios',
    'Compare exact Scenario revisions and shared metrics against one current Ontology baseline.',
    compareScenariosSchema,
    false,
    async (access, input) => evaluations.compare(access, await active(), input),
  );
  register(
    'trial_scenarios',
    'Execute published Action variants offline on the same evidence, then roll back every trial.',
    trialScenariosSchema,
    true,
    async (access, input) => {
      requireScope(access.principal, 'ontology:read');
      return evaluations.trial(access, await active(), input);
    },
  );
  register(
    'share_scenario',
    'Share persisted Scenario metadata with specific readers.',
    z.strictObject({
      id: z.uuid(),
      revision: z.number().int().positive(),
      readers: z.array(z.string()).max(100),
    }),
    true,
    async (a, input) => new Scenarios(db).share(a, await active(), input.id, input.revision, input.readers),
  );
  register(
    'undo_action',
    'Compensate recorded data edits after revision and permission checks.',
    z.strictObject({ originalRequestId: z.string().min(1), requestId: z.string().min(1) }),
    true,
    async (a, input) => actions.undo(a, await active(), input.originalRequestId, input.requestId),
  );
  const scenarioRevision = idSchema.extend({ revision: z.number().int().positive() });
  register(
    'rebase_scenario',
    'Rebase an owned proposal over compatible live object changes and issue a new revision.',
    scenarioRevision,
    true,
    async (a, input) => new Scenarios(db).rebase(a, await active(), input.id, input.revision),
  );
  register(
    'invite_scenario_reviewers',
    'Require an invited separate identity to approve the exact owned proposal revision before merge.',
    scenarioRevision.extend({ reviewers: z.array(z.string().min(1).max(200)).max(100) }),
    true,
    async (a, input) => new Scenarios(db).inviteReviewers(a, await active(), input.id, input.revision, input.reviewers),
  );
  register(
    'pending_scenario_reviews',
    'List Scenario reviews invited to the authenticated account and currently visible to it.',
    z.strictObject({ page: z.number().int().min(1).max(1000).default(1) }),
    false,
    async (a, { page }) => new Scenarios(db).pendingReviews(a, await active(), page),
  );
  register(
    'inspect_scenario_review',
    'Read the proposed edits as an invited reviewer under current object and property permissions.',
    idSchema,
    false,
    async (a, input) => new Scenarios(db).inspectReview(a, await active(), input.id),
  );
  register(
    'approve_scenario_review',
    'Approve the revision and snapshot returned by the invited reviewer inspection.',
    scenarioRevision.extend({ snapshot: z.string().regex(/^[a-f0-9]{64}$/) }),
    true,
    async (a, input) => new Scenarios(db).approveReview(a, await active(), input.id, input.revision, input.snapshot),
  );
  register(
    'save_workflow',
    'Save an authorized sequence of Actions with an optional reviewed Scenario proposal.',
    workflowSchema,
    true,
    async (a, input) => automation.workflow(a, await define(a), input),
  );
  register(
    'save_rule',
    'Configure an object-set rule or a committed process transition rule with an optional dwell time.',
    saveRuleSchema,
    true,
    async (a, input) => automation.rule(a, await define(a), input),
  );
  register('workflows', 'List workflows.', z.strictObject({}), false, async (a) =>
    automation.list(a, await define(a), 'workflows'),
  );
  register('rules', 'List rules and monitoring state.', z.strictObject({}), false, async (a) =>
    automation.list(a, await define(a), 'object_rules'),
  );
  register(
    'process_status',
    'Read the current process state, its most recent visible transition and how long the state has been recorded.',
    processStatusSchema,
    false,
    async (a, input) => automation.processStatus(a, await active(), input),
  );
  register('machinery_processes', 'Discover authorized Ontology processes and their published reference models.',
    z.strictObject({}), false, async a => listMachineryProcesses(a, await active()));
  register('machinery_analysis', 'Mine authorized process paths, compare observed transitions with a reference, and analyze dwell time.',
    machineryAnalysisSchema, false, async (a, input) => analyzeMachinery(db, a, await active(), input));
  register('ingest_machinery_history','Import idempotent observed transitions for an authorized history source.',
    machineryHistorySchema,true,async(a,input)=>ingestMachineryHistory(db,a,await active(),input));
  register('save_machinery_cases','Save all authorized matches from a Machinery filter into a static Object Set.',
    z.strictObject({analysis:machineryAnalysisSchema,name:z.string().min(1).max(200),requestId:z.string().min(1).max(128)}),
    true,async(a,input)=>{
      requireScope(a.principal,'ontology:read');
      const model=await active(), result=await analyzeMachinery(db,a,model,input.analysis,true);
      if(!result.members?.length)throw new Conflict('The analysis contains no visible cases');
      if(!await a.canReturn(a.dataRequirements()))throw new Conflict('Machinery case permissions changed');
      return sets.save(a,model,{requestId:input.requestId,name:input.name,mode:'static',set:{op:'refs',objects:result.members}});
    });
  register('machinery_propose_model', 'Open a definition branch for a manual or mined process model at the observed release.',
    z.strictObject({ type: ontologyName, model: machineryModelSchema, name: z.string().min(1).max(200),
      release: z.string().regex(/^[0-9a-f]{64}$/), project: ontologyName.optional() }), true, async (a, input) => {
      const current = await active();
      if (current.release !== input.release) throw new Conflict('Ontology changed; refresh the process analysis');
      const body = structuredClone(current.document);
      const definition = body.objectTypes.find(type => type.apiName === input.type);
      if (!definition) throw new Conflict('Select a local process definition in this Ontology');
      definition.machinery = input.model;
      return governance.create(a, { ontology: ontologyId, name: input.name, project: input.project,
        body, baseRelease: current.release });
    });
  register('save_machinery_review', 'Save or disable periodic review of an authorized Machinery process.',
    machineryReviewSchema, true, async (a, input) => machinery.save(a, await active(), input));
  register('machinery_reviews', 'List owned periodic Machinery reviews and their latest analyzed windows.',
    z.strictObject({}), false, async a => machinery.list(a, await active()));
  register('machinery_review', 'Read the last analyzed window with current process permissions.',
    idSchema, false, async (a, { id }) => machinery.read(a, await active(), id, false));
  register('run_machinery_review', 'Analyze the configured process now and record the authorized analysis window.',
    idSchema, true, async (a, { id }) => {
      requireScope(a.principal, 'ontology:read');
      return machinery.read(a, await active(), id, true);
    });
  register('workflow_runs', 'List workflow execution progress.', z.strictObject({}), false, async (a) =>
    automation.list(a, await active(), 'workflow_runs'),
  );
  register(
    'run_workflow',
    'Run a saved workflow against an authorized object.',
    runWorkflowSchema,
    true,
    async (a, input) => automation.run(a, await define(a), input),
  );
  register(
    'retry_workflow',
    'Resume the remaining steps of a failed workflow.',
    idSchema,
    true,
    async (a, input) => automation.retry(a, await active(), input.id),
  );
  register('tasks', 'Read recent owned task runs.', z.strictObject({}), false, async (a) => {
    const rows = (
      await db.query(`SELECT id FROM ${db.schema}.tasks WHERE owner=$1 ORDER BY created_at DESC LIMIT 100`, [
        a.principal.owner,
      ])
    ).rows;
    const tasks = new Tasks(db, metadata);
    return {
      items: await Promise.all(rows.map(async (row) => publicTask(await tasks.get(a.principal, row.id), bindings.projectTaskResult))),
    };
  });
  register(
    'bind_entity',
    'Bind a published source identity to a readable canonical object.',
    bindEntitySchema,
    true,
    async (a, input) => new EntityResolution(db).bind(a, await active(), input),
  );
  register(
    'lookup_entity',
    'Resolve a published source identity.',
    entityLookupSchema,
    false,
    async (a, input) => new EntityResolution(db).lookup(a, await active(), input),
  );
  register(
    'entity_history',
    'Read canonical identity binding audit.',
    entityHistorySchema,
    false,
    async (a, input) => new EntityResolution(db).history(a, await active(), input),
  );
  register(
    'cancel_workflow',
    'Cancel uncommitted workflow steps while preserving completed history.',
    idSchema,
    true,
    async (a, input) => automation.cancel(a, await active(), input.id),
  );
  register(
    'migrate_data',
    'Copy explicitly mapped authorized data into another Ontology.',
    migrateOntologyDataSchema,
    true,
    (a, input) => packages.migrateData(a, input),
  );
  register(
    'migration_receipt',
    'Read current-authorized cross-Ontology migration provenance.',
    readDataMigrationSchema,
    false,
    (a, input) => packages.migrationReceipt(a, input),
  );
  register('proposal_diff','Compare a definition proposal to its base.',idSchema,false,async(a,input)=>{
    const branch=await governance.read(a,input.id),base=await metadata.get(branch.base_release),changes=[];
    for(const [kind,field] of Object.entries(resourceGroups)){
      const key=(item:{apiName:string;version?:unknown})=>item.apiName+(item.version?'@'+item.version:'');
      const before=new Map(((base.document as any)[field] as any[]??[]).map(item=>[key(item),item]));
      const after=new Map(((branch.body as any)[field]??[]).map((item:any)=>[key(item),item])) as Map<string,any>;
      for(const name of new Set([...before.keys(),...after.keys()]))if(digest(before.get(name)??null)!==digest(after.get(name)??null))changes.push({kind,name,before:before.get(name)??null,after:after.get(name)??null});
    }
    return {id:branch.id,revision:branch.revision,changes};
  });
  return services;
}
