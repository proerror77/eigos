import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import type { AgentProgram, AgentProgramContext } from '../core/agent-program.js';
import type { ExecutionCatalog, Delivery } from '../core/catalog.js';
import { assertAcceptedOutputCurrent, componentContext } from '../core/composed-actions.js';
import { assertGoalContract, type GoalAssessment, type GoalContract } from '../core/goal-contract.js';
import {runGraphProgram} from '../ontology/graph-program.js';
import {assessGoalProgram,partialGoalArtifactProgram} from './goal-assessment-program.js';
import type { AgentExecutionState } from '../ontology/agent-actions.js';
import type { PlanningSnapshot } from '../ontology/planning-contract.js';
import type { ServiceCapability, ServiceRequest } from '../ontology/execution.js';
import { goalCompletionSchema } from '../ontology/goal-completion-contract.js';
export { goalCompletionSchema } from '../ontology/goal-completion-contract.js';

function fail(message: string): never { throw new DomainError('CONFLICT', message); }
export function goalState(request: ServiceRequest, goal: GoalContract): AgentExecutionState {
  return { version: '2', programRef: { id: 'eigos.goal', version: '1' }, programDigest: digest({ engine: 'eigos.goal@1', goal: goal.digest, release: goal.ontologyRelease }),
    scope: { type: 'ServiceRequest', id: request.id }, input: {}, requestRevision: request.revision, plans: [], observations: [], feedback: [],
    composition: { version: '1', contexts: [], goal } };
}
/** Preserve observed source data on interruption without calling it accepted
 * whole-goal delivery. Large objects remain available through their exact refs. */
export function partialGoalArtifact(ctx:AgentProgramContext):Delivery['artifact']|undefined {
  return runGraphProgram(ctx.graph,partialGoalArtifactProgram(ctx));
}

/** Task-level policy only. All source calls are resolved from the selected step;
 * this program contains no business operation, adapter or action sequence. */
export class GoalProgram implements AgentProgram {
  readonly ref = { id: 'eigos.goal', version: '1' };
  readonly actionIds: string[] = [];
  readonly completionSchema = z.toJSONSchema(goalCompletionSchema);
  readonly guidance = 'Discover exact task-scoped actions. Prepare a pure context for each selected program, then choose actions and dependencies from current evidence. Complete every fixed goal criterion using independently verified component results.';
  readonly configurationDigest: string;
  constructor(private goal: GoalContract) { this.configurationDigest = digest({ engine: 'eigos.goal@1', goal: goal.digest, release: goal.ontologyRelease }); }
  permitted() { return true; }
  capability(): ServiceCapability {
    return { ref: this.ref, ontologyRef: { id: this.goal.ontologyRelease.ontologyId, version: this.goal.ontologyRelease.digest },
      name: 'Whole-goal evidence verification', description: this.guidance, tags: [], inputSchema: {}, ontology: { goal: structuredClone(this.goal) }, actions: [],
      predicates: this.goal.criteria.map(criterion => ({ id: criterion.predicate, description: criterion.description })), outcomePredicates: this.goal.criteria.map(criterion => criterion.predicate),
      verifierRef: { id: 'eigos.goal.independent', version: '1' }, completion: 'domain', environment: 'local' };
  }
  assertContext(ctx: AgentProgramContext) { assertGoalContract(this.goal, ctx.request, ctx.graph.releaseRef); }
  initialize(): never { return fail('Goal initialization requires the frozen request contract'); }
  schema(): never { return fail('Select an exact discovered action binding'); }
  definition(): never { return fail('Select an exact discovered action binding'); }
  validate(): never { return fail('Select an exact discovered action binding'); }
  async invoke(): Promise<never> { return fail('The goal policy has no executable business action'); }
  project(): never { return fail('The goal policy cannot manufacture source observations'); }
  complete(): never { return fail('Goal completion requires all component verifiers'); }
}

export {aggregateGoalFacts,assessGoalProgram,partialGoalArtifactProgram} from './goal-assessment-program.js';
export type {GoalAssessmentContext,GoalAssessmentPorts,GoalCompletionProgram} from './goal-assessment-program.js';

export function assessGoal(catalog:ExecutionCatalog,ctx:AgentProgramContext,proposal:unknown,reads:PlanningSnapshot):{assessment:GoalAssessment;delivery:Delivery}{
  return runGraphProgram(ctx.graph,assessGoalProgram(ctx,proposal,reads,{
    resolveProgram:function*(_context,component){
      const {program}=catalog.resolveActionBinding(ctx.graph,ctx.owner,ctx.request,component.initializedBy.binding);
      const scoped=componentContext(ctx,component,program);
      return {ref:program.ref,configurationDigest:program.configurationDigest,capability:()=>program.capability(),
        assertContextProgram:function*(){program.assertContext?.(scoped);},
        completeProgram:function*(_scoped,value,snapshot){return program.complete(scoped,value,snapshot);}};
    },
    assertAcceptedOutputCurrentProgram:function*(_context,intent,port){return assertAcceptedOutputCurrent(catalog,ctx,intent,port);},
  }));
}
