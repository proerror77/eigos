// The model and PA answers are fixtures. No personal calendar connection exists.
import { randomUUID } from 'node:crypto';
import { JobStore } from '../../packages/core/store.js';
import { createExecutionCatalog } from '../../packages/capabilities/catalog.js';
import { digest } from '../../packages/core/delegation.js';
import type { PAAnswer } from '../../packages/core/pa-questions.js';
import type { AgentDecision } from '../../packages/ontology/agent-actions.js';
import type { AgentPlanningContext, PlanningAccess, Reasoner } from '../../packages/coordinator/coordinator.js';
import type { Job } from '../../packages/core/domain.js';
import { backend, evidence, interpretation, owner, principal, syntheticGoalReview } from '../backend-fixture.js';

export function choosePAFacts(ctx: AgentPlanningContext, access: PlanningAccess): AgentDecision {
  access.session.call('describe_ontology', { actions: ['AskPACalendarStatus', 'StartTaskObservationWatch'] });
  access.session.call('query_ontology', { object: ctx.state.scope });
  const answer = ctx.state.observations.filter(ref => ref.type === 'PACalendarAnswer').at(-1);
  const execute = (action: string, args: object): AgentDecision => ({ kind: 'execute', requestRevision: ctx.request.revision, message: 'Synthetic factual question selection', steps: [{ id: 'step', action, argumentsJson: JSON.stringify(args), dependsOn: [], inputRefs: [] }], completionJson: '' });
  if (!answer) return execute('AskPACalendarStatus', { scope: ctx.state.scope });
  access.session.call('query_ontology', { object: answer });
  const result = access.session.call('evaluate_ontology', { function: 'paCalendarStatus', object: answer }) as { status: string; value?: { matches: boolean } };
  if (result.status !== 'known') return execute('AskPACalendarStatus', { scope: ctx.state.scope });
  if (!result.value?.matches) return { kind: 'clarify', requestRevision: ctx.request.revision, message: 'PA 回答的当前安排与目标不符，请补充用户决定后的最新事实。', steps: [], completionJson: '' };
  const completionJson = JSON.stringify({ answer, rationale: 'Matches the fresh confirmed facts provided by the requesting PA; no calendar execution claimed' });
  if (ctx.request.monitoring && Date.now() < Date.parse(ctx.request.monitoring.until) && !ctx.situation?.watches.some(w => w.status === 'active'))
    return execute('StartTaskObservationWatch', { scope: ctx.state.scope, observation: answer, action: 'AskPACalendarStatus', argumentsJson: JSON.stringify({ scope: ctx.state.scope }), policy: { intervalMs: 60000, maxAgeMs: 300000 }, refreshCompletion: true, completionJson });
  return { kind: 'complete', requestRevision: ctx.request.revision, message: 'Confirmed PA facts match', steps: [], completionJson };
}

export function paFactsFixture(path = ':memory:') {
  const store = new JobStore(path), catalog = createExecutionCatalog({ store });
  const input = { eventKey: 'test-event', title: 'Test exhibition', startsAt: new Date(Date.now() + 86400000).toISOString(), endsAt: new Date(Date.now() + 90000000).toISOString(), timeZone: 'Asia/Shanghai', location: '场馆 A' };
  let modelCalls = 0;
  const model: Reasoner = { reviewGoal: syntheticGoalReview, ground: async request => ({ decision: { ...interpretation(request, 'pa.context.calendar', input), capabilityRef: { id: 'pa.context.calendar', version: '1' } }, evidence: evidence() }),
    plan: async () => { throw new Error('No fixed calendar recipe'); }, act: async (ctx, _signal, access) => { modelCalls++; const decision = choosePAFacts(ctx, access); return { decision, evidence: { ...evidence(), decisionDigest: digest(decision) } }; } };
  const b = backend(catalog, model, store);
  const until = async (id: string, predicate: (job: Job) => boolean) => {
    for (let i = 0; i < 25; i++) {
      const job = store.get(owner, id); if (predicate(job)) return job;
      if (!['submitted', 'working'].includes(job.state)) throw new Error(JSON.stringify({ state: job.state, question: job.question, error: job.error, feedback: job.delegation?.agent?.feedback }));
      await b.run();
    }
    throw new Error(JSON.stringify(store.get(owner, id).delegation?.agent?.feedback));
  };
  const known = (): PAAnswer => { const { eventKey: subjectKey, ...arrangement } = input; return { status: 'known', basis: 'checked', observedAt: new Date().toISOString(), facts: { exists: true, subjectKey, arrangement } }; };
  const report = (job: Job, answer: PAAnswer = known()) => { const current = job.delegation!.paQuestion!; return { action: 'answer_pa_question' as const, taskId: job.id, questionId: current.question.id, questionDigest: current.question.digest, expectedAnswerRevision: current.answerRevision, requestId: randomUUID(), answer }; };
  return { ...b, catalog, model, input, known, report, until, modelCalls: () => modelCalls,
    submit: (extra: object = {}) => b.submit({ goal: '向我的 PA 核实这次活动的日历时间地点是否与目标一致。只询问信息。', executionEnvironment: 'live', ...extra }),
    answer: (job: Job, answer?: PAAnswer) => b.tasks.answerPAQuestion(principal, report(job, answer)), close: () => store.close() };
}
