import assert from 'node:assert/strict';
import type { AgentDriver, AgentTool } from '../packages/runtime/agent.js';
import type { ObjectRef } from '../packages/ontology/schema.js';

export function planningInput() {
 const start=new Date(Date.now()+3600000);start.setUTCSeconds(0,0);start.setUTCMinutes(0);
 return {title:'Synthetic planning request',start:start.toISOString(),end:new Date(start.getTime()+4*3600000).toISOString(),timeZone:'Asia/Shanghai',durationMinutes:30};
}
export function calendarAnswer(input=planningInput()) {
 return {status:'available' as const,complete:true as const,start:input.start,end:input.end,timeZone:input.timeZone,
  observedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+240000).toISOString(),sourceVersion:'fixture-1',evidence:'synthetic' as const,calendars:['synthetic-personal'],
  windows:[{start:input.start,end:input.end}],busy:[{start:input.start,end:new Date(Date.parse(input.start)+3600000).toISOString()}]};
}
/** Recorded decisions exercise the same tool boundary as the production model. */
export class PlanningFixtureAgent implements AgentDriver {
 readonly model='fixture-planning-decisions';
 async run(prompt:string,tools:ReadonlyMap<string,AgentTool>) {
  const task=JSON.parse(prompt.split('\n').at(-1)!);const input=JSON.parse(task.userRequest.message).planning;
  const result=await tools.get('apply_action')!.invoke({interface:{type:'SchedulablePlan',implementation:'SchedulePlan',action:'prepare'},input}) as ObjectRef;
  if(!result?.id)return;
  const scene=await tools.get('create_scenario')!.invoke({requestId:'chosen-plan',name:'Suggested time'}) as {id:string};
  const output=await tools.get('evaluate_function')!.invoke({scenarioId:scene.id,function:'findScheduleSlots',input:{plan:result}}) as {slots:{start:string;end:string}[]};
  assert(output.slots.length>0);
  await tools.get('apply_action')!.invoke({scenarioId:scene.id,action:'SaveScheduleActivity',input:{plan:result,id:'meeting',name:'Meeting',...output.slots[0]}});
  await tools.get('complete_with_function')!.invoke({scenarioId:scene.id,function:'readSchedulePlan',input:{plan:result}});
 }
}
