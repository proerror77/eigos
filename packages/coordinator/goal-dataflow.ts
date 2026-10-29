import { DomainError } from '../core/domain.js';
import type { ExecutionCatalog } from '../core/catalog.js';
import type { AgentProgramContext } from '../core/agent-program.js';
import type { ActionIntent } from '../ontology/actions.js';
import type { AgentActionPlan, AgentDecision } from '../ontology/agent-actions.js';
import { objectRefSchema, type ObjectRef } from '../ontology/model.js';
import { assertAcceptedOutputCurrent, componentContext } from '../core/composed-actions.js';
import { dataflowArguments, validatePlannedCompletion } from './read-dataflow.js';

const fail=(message:string):never=>{throw new DomainError('CONFLICT',message);};
const unique=(values:string[])=>new Set(values).size===values.length;

/** Validate a proposal before any source read. Only explicitly opted-in read
 * modules can select future component evidence; effects keep normal review. */
export function validateGoalDataflow(catalog:ExecutionCatalog,ctx:AgentProgramContext,decision:AgentDecision):void {
  const selected=decision.plannedGoalCompletion;
  if(!selected)return;
  const composition=ctx.state.composition??fail('Future goal completion requires a native goal');
  if(decision.kind!=='execute'||decision.plannedCompletion||decision.completionJson||!decision.steps.length
    ||decision.steps.some(step=>ctx.graph.model.action(step.action).read?.effect!=='read'))fail('Future goal completion requires an exclusively read-only frontier');
  const ids=selected.components.map(value=>value.contextId);
  if(!unique(ids)||!unique(selected.criteria.map(value=>value.id))||!unique(selected.conditions.map(value=>value.conditionId)))fail('Future completion repeats a component or criterion');
  if(selected.criteria.length!==composition.goal.criteria.length
    ||selected.criteria.some(value=>!composition.goal.criteria.some(criterion=>criterion.id===value.id)||!unique(value.contextIds)||value.contextIds.some(id=>!ids.includes(id))))fail('Future completion must explicitly assign every fixed goal criterion');
  const conditions=(ctx.request.conditions??[]).filter(value=>value.phase==='result');
  if(selected.conditions.some(value=>!conditions.some(condition=>condition.id===value.conditionId)||!ids.includes(value.contextId))
    ||conditions.some(value=>value.strength==='hard'&&!selected.conditions.some(condition=>condition.conditionId===value.id)))fail('Future completion omits a required result condition');
  for(const component of selected.components){
    const prepared=composition.contexts.find(value=>value.id===component.contextId)??fail('Unknown future completion context');
    const {program}=catalog.resolveActionBinding(ctx.graph,ctx.owner,ctx.request,prepared.initializedBy.binding);
    program.assertContext?.(componentContext(ctx,prepared,program));
    const steps=decision.steps.filter(step=>step.contextId===component.contextId);
    for(const ref of component.inputRefs){
      const source=steps.find(step=>step.id===ref.stepId)??fail('Future component evidence must come from its own selected action');
      const port=ctx.graph.model.action(source.action).composition?.outputs[ref.port];
      if(!port||port.kind!=='object'||port.cardinality!=='one')fail('Future completion requires an exact single-object output port');
    }
    validatePlannedCompletion(ctx.graph,program,{...decision,steps,plannedGoalCompletion:undefined,
      plannedCompletion:{argumentsJson:component.argumentsJson,inputRefs:component.inputRefs.map(({port:_port,...ref})=>ref)}});
  }
}

/** Read only the original accepted ports. The returned proposal must still
 * pass fresh planning receipts, component verification and whole-goal checks. */
export function bindGoalCompletion(catalog:ExecutionCatalog,ctx:AgentProgramContext,plan:AgentActionPlan,intent:(id:string)=>ActionIntent){
  const decision=plan.modelDecision??fail('Future completion has no authenticated model decision');
  validateGoalDataflow(catalog,ctx,decision);
  const selected=decision.plannedGoalCompletion??fail('Future goal completion was not selected');
  const refs:ObjectRef[]=[plan.scope],actions:string[]=[];
  const components=selected.components.map(component=>{
    refs.push(ctx.state.composition!.contexts.find(value=>value.id===component.contextId)!.scope);
    const proposal=dataflowArguments(component.argumentsJson);
    for(const ref of component.inputRefs){
      const step=plan.steps.find(step=>step.id===ref.stepId&&step.contextId===component.contextId)??fail('Future completion producer changed');
      const output=assertAcceptedOutputCurrent(catalog,ctx,intent(step.intentId),ref.port);
      if(output.definition.kind!=='object'||output.definition.cardinality!=='one')fail('Future completion port changed');
      const object=objectRefSchema.parse(output.value);
      proposal[ref.targetKey]=object;refs.push(object);actions.push(step.action);
    }
    return {contextId:component.contextId,proposalJson:JSON.stringify(proposal)};
  });
  return {proposal:{components,criteria:selected.criteria,conditions:selected.conditions},refs,actions:[...new Set(actions)]};
}
