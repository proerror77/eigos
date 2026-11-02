// Synthetic model/source, real Foundation authority, Worker and whole-goal runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { securityFixture } from './fixtures/security.js';
import { FliggyProgram } from '../packages/capabilities/fliggy/program.js';
import { bindPersonalSourceOwner } from '../packages/core/source-owner.js';
import { ExecutionCatalog } from '../packages/core/catalog.js';
import { TaskService } from '../packages/core/tasks.js';
import {
  Coordinator,
  type Reasoner,
} from '../packages/coordinator/coordinator.js';
import { taskContextFields } from '../packages/security/task-context-contract.js';
import { runNativeDidiTask } from './fixtures/secured-didi.js';
import {
  evidence,
  interpretation,
  syntheticGoalReview,
  observeTaskContext,
  acknowledgeReads,
} from './backend-fixture.js';
import { digest } from '../packages/core/delegation.js';
import type { ActionDiscoveryPage } from '../packages/core/action-bindings.js';
import type { AgentDecision } from '../packages/ontology/agent-actions.js';
import { packageInput as input, packageData } from './fixtures/fliggy.js';
for (const mode of ['direct', 'native-goal'] as const)
  test(
    `Foundation Fliggy ${mode} validates the search through authorized evidence`,
    { timeout: 300000 },
    async (t) => {
      t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
      const f = securityFixture();
      let calls = 0;
      const views: string[] = [];
      const program = new FliggyProgram({
        mode: 'trial',
        evidenceKind: 'fixture',
        connector: {
          search: async (args, signal) => {
            signal.throwIfAborted();
            assert.deepEqual(args, input);
            calls++;
            return {
              data: packageData,
              observedAt: new Date().toISOString(),
              priceKind: 'reference',
              providerExpiry: 'unknown',
            };
          },
        },
      });
      bindPersonalSourceOwner(program, f.owner);
      const catalog = new ExecutionCatalog(
          [program.capability()],
          [],
          [],
          [],
          [program],
          undefined,
          f.jobs.security,
        ),
        policy = f.jobs.security.policies,
        profile = catalog.securityProfiles(f.owner)[0]!,
        until = new Date(Date.now() + 3600000).toISOString(),
        install = f.installation('Synthetic package source', 3600000);
      const resources = [
        ...new Set([
          'ServiceRequest',
          ...profile.outputTypes,
          ...Object.keys(taskContextFields),
        ]),
      ].map((type) => ({
        type,
        fields: Object.keys(policy.fields(type)).filter(
          (field) => policy.fieldPolicy(type, field) !== 'internal_only',
        ),
      }));
      f.coordinator.approveAgentGrant(f.member.id, {
        installationId: install.id,
        capabilityIds: [program.ref.id],
        resources,
        sourceBindingIds: [profile.bindingId],
        channels: ['agent_response', 'registered_model'],
        expiresAt: until,
      });
      policy.setRole(
        {
          subjectKind: 'installation',
          subjectId: install.id,
          resource: {
            kind: 'namespace',
            id: policy.model.ref.id,
            version: policy.model.ref.digest,
          },
          role: 'Viewer',
          executeActions: program.actionIds,
          invokeFunctions: policy.model
            .definitionSnapshot()
            .functions.map((fn) => fn.id),
          expiresAt: until,
        },
        policy.revision(),
      );
      const markings = [
        'member_private',
        'personal_data',
        'precise_location',
        'financial',
        'health',
        'account_private',
      ];
      policy.setRecipient(
        install.id,
        {
          classification: 'sensitive',
          markings,
          channels: ['agent_response', 'registered_model'],
          expiresAt: until,
        },
        policy.revision(),
      );
      policy.setModelChannel(
        'synthetic-package',
        { classification: 'sensitive', markings, expiresAt: until },
        policy.revision(),
      );
      policy.setSource(
        f.owner,
        {
          installationId: install.id,
          bindingId: profile.bindingId,
          programId: program.ref.id,
          programDigest: program.configurationDigest,
          operations: program.actionIds,
          outputTypes: profile.outputTypes,
          expiresAt: until,
        },
        policy.revision(),
      );
      const principal = {
          ...f.principal,
          access: f.coordinator.authenticate(f.principal, install.token),
        },
        tasks = new TaskService(f.jobs, { catalog });
      let turns = 0;
      const model: Reasoner = {
        ontologyContextMode: 'task',
        securityChannelId: 'synthetic-package',
        reviewGoal: syntheticGoalReview,
        ground: async (request, _caps, _signal, access) => {
          observeTaskContext(access);
          const decision =
            mode === 'direct'
              ? {
                  ...interpretation(request, program.ref.id, input),
                  capabilityRef: program.ref,
                }
              : {
                  kind: 'compose' as const,
                  requestRevision: request.revision,
                  message: 'Retain the original search outcome',
                  requirementsJson: '[]',
                  conditionsJson: '[]',
                  criteriaJson: JSON.stringify([
                    {
                      id: 'search',
                      description: 'Source-backed package search',
                      predicate: 'fliggy.search_observed',
                      phase: 'fact',
                      messageId: request.messages[0]!.id,
                      quote: request.originalGoal,
                      requirementIds: [],
                    },
                  ]),
                };
          acknowledgeReads(access);
          return {
            decision,
            evidence: { ...evidence(), decisionDigest: digest(decision) },
          };
        },
        plan: async () => {
          throw new Error('No legacy plan');
        },
        act: async (ctx, _signal, access) => {
          assert(++turns <= 8, 'Bounded fixture decision count');
          observeTaskContext(access);
          const pin = () => {
            const page = access.session.call('discover_actions', {
              actionId: 'SearchFliggyMarriottPackages',
              programRef: program.ref,
            }) as ActionDiscoveryPage;
            const binding = page.items[0]?.bindings.find(
              (b) => b.readiness === 'ready',
            );
            assert(binding, JSON.stringify(page));
            return binding.pin;
          };
          let decision: AgentDecision;
          if (mode === 'native-goal' && !ctx.preparedContextNavigation?.length)
            decision = {
              kind: 'prepare',
              requestRevision: ctx.request.revision,
              message: 'Prepare the exact package search context',
              steps: [],
              completionJson: '',
              contexts: [
                {
                  id: 'package',
                  bindingDigest: pin().digest,
                  inputJson: JSON.stringify(input),
                },
              ],
            };
          else {
            const scope =
              mode === 'native-goal'
                ? ctx.preparedContextNavigation![0]!.scope
                : ctx.state.scope;
            access.session.call('describe_ontology', {
              actions: ['SearchFliggyMarriottPackages'],
            });
            access.session.call('query_ontology', { object: scope });
            const ref = ctx.state.observations.find(
              (r) => r.type === 'FliggySearchObservation',
            );
            if (ref) {
              const view = access.session.call('query_ontology', {
                object: ref,
              }) as { items: { properties: Record<string, unknown> }[] };
              views.push(JSON.stringify(view));
              assert.ok(view.items[0]?.properties.observedData);
              assert.ok(!JSON.stringify(view).includes('"snapshot":'));
              const status = access.session.call('evaluate_ontology', {
                function: 'fliggySearchStatus',
                object: ref,
              }) as { status: string; reason?: string };
              assert.equal(status.status, 'known', status.reason);
              for (const field of [
                'snapshot',
                'configurationDigest',
                'actionInput',
                'planId',
                'intentId',
              ])
                assert.ok(
                  !JSON.stringify(status).includes('\"' + field + '\":'),
                  `Integrity result leaked ${field}`,
                );
            }
            const proposal = ref
              ? JSON.stringify({
                  observation: ref,
                  rationale: 'Return only source-backed reference prices',
                })
              : '';
            decision = {
              kind: ref ? 'complete' : 'execute',
              requestRevision: ctx.request.revision,
              message: 'Synthetic package decision',
              steps: ref
                ? []
                : [
                    {
                      id: 'search',
                      action: 'SearchFliggyMarriottPackages',
                      argumentsJson: JSON.stringify({ scope }),
                      dependsOn: [],
                      inputRefs: [],
                      ...(mode === 'native-goal'
                        ? {
                            contextId: 'package',
                            bindingDigest: pin().digest,
                            contributesTo: ['search'],
                          }
                        : {}),
                    },
                  ],
              completionJson:
                ref && mode === 'native-goal'
                  ? JSON.stringify({
                      components: [
                        { contextId: 'package', proposalJson: proposal },
                      ],
                      criteria: [{ id: 'search', contextIds: ['package'] }],
                      conditions: [],
                    })
                  : proposal,
            };
          }
          acknowledgeReads(access);
          return {
            decision,
            evidence: { ...evidence(), decisionDigest: digest(decision) },
          };
        },
      };
      const modelErrors: string[] = [];
      const act = model.act!;
      model.act = async (...args) => {
        try {
          return await act(...args);
        } catch (error) {
          modelErrors.push(
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error),
          );
          throw error;
        }
      };
      const coordinator = new Coordinator(f.jobs, model, catalog);
      try {
        if (mode === 'native-goal') {
          const scopePort = f.jobs.ontology.model.action(
            'SearchFliggyMarriottPackages',
          ).composition!.inputs.scope!;
          assert.equal(scopePort.semantics.phase, 'request');
          assert.deepEqual(scopePort.evidence.origins, ['managed', 'user']);
        }
        const job = tasks.submit(principal, {
          service: 'eigos.delegate',
          requestId: 'synthetic-package',
          goal: 'Search Taipei packages, no booking or payment',
          executionEnvironment: 'sandbox',
        });
        await runNativeDidiTask(
          f.jobs,
          coordinator,
          f.owner,
          job.id,
          t.signal,
          () => t.mock.timers.tick(20),
        );
        const raw = f.jobs.get(f.owner, job.id);
        assert.equal(
          raw.state,
          'completed',
          JSON.stringify({
            state: raw.state,
            modelErrors,
            feedback: raw.delegation?.agent?.feedback,
            grounding: raw.delegation?.groundingFeedback,
            recovery: raw.delegation?.recovery,
          }),
        );
        assert.equal(calls, 1);
        assert(views.length > 0);
        const delivered = tasks.get(principal, job.id);
        assert.ok(delivered.artifact);
        const text = JSON.stringify(delivered.artifact);
        for (const forbidden of [
          '"snapshot":',
          '"configurationDigest":',
          '"actionInput":',
          '/synthetic/no-secret',
        ])
          assert(!text.includes(forbidden));
        assert(text.includes('Synthetic hotel room'));
        assert(text.includes('499'));
        const beforeProducts = tasks.queryOntology(principal, { version: 2, taskId: job.id, query: { type: 'TravelProduct' } }).items;
        assert.equal(beforeProducts.length, 1);
        const oldReceipt = tasks.queryOntology(principal, { version: 2, taskId: job.id, query: { type: 'SourceReceipt' } }).items[0]!.ref;
        turns = 0;
        const repeated = tasks.submit(principal, { service: 'eigos.delegate', requestId: 'synthetic-package-repeat',
          goal: 'Search Taipei packages again, no booking or payment', executionEnvironment: 'sandbox' });
        await runNativeDidiTask(f.jobs, coordinator, f.owner, repeated.id, t.signal, () => t.mock.timers.tick(20));
        const repeatedJob = f.jobs.get(f.owner, repeated.id);
        assert.equal(repeatedJob.state, 'completed', JSON.stringify(repeatedJob.delegation?.agent?.feedback));
        const afterProducts = tasks.queryOntology(principal, { version: 2, taskId: repeated.id, query: { type: 'TravelProduct' } }).items;
        assert.deepEqual(afterProducts.map(o => [o.ref, o.revision]), beforeProducts.map(o => [o.ref, o.revision]));
        assert.equal(calls, 2);
        assert.throws(() => tasks.queryOntology(principal, { version: 2, taskId: repeated.id, query: { object: oldReceipt } }), /not available|INSUFFICIENT_ACCESS/,
          'Replacing current evidence must not grant access to the previous task receipt');
        if (mode === 'native-goal') {
          assert.equal(raw.delegation!.agent!.programRef.id, 'eigos.goal');
          assert.equal(
            raw.delegation!.agent!.composition!.assessment!.accepted,
            true,
          );
        }
        policy.revokeSource(
          f.owner,
          install.id,
          profile.bindingId,
          policy.revision(),
        );
        assert.throws(
          () => tasks.get(principal, job.id),
          /AUTHORIZATION_REQUIRED/,
        );
      } finally {
        f.close();
      }
    },
  );
