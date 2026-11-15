import { Conflict, NotFound, digest } from '../../core/identity.js';
import { type ObjectRef } from '../../ontology/schema.js';
import { diningEvidence, diningSource } from '../../ontology/dining.js';
import { diningProof } from '../dining/research.js';
import type { z } from 'zod';
import { withScenarioEvaluation, withScenarioPARead, type FunctionContext, type FunctionHandler } from '../../runtime/functions.js';
import type { Database } from '../../runtime/database.js';
import { Scenarios } from '../../runtime/scenarios.js';
import { PARequests } from '../../runtime/pa.js';
import { Objects } from '../../runtime/objects.js';
import { recordScenarioAction } from '../../runtime/scenario-store.js';
import { currentService } from '../services/functions.js';
import { activityInputSchema, calendarResponseSchema, commitPlanSchema, diningActivityInputSchema, jsonSchema, planInputSchema, planRefSchema, removeActivitySchema, searchSlotsSchema } from './contracts.js';

type Reader = FunctionContext['objects'];
type Interval = { start: string; end: string };
const same = (a: ObjectRef, b: ObjectRef) => a.type === b.type && a.id === b.id;
const ms = (value: unknown) => typeof value === 'string' ? Date.parse(value) : NaN;
const overlaps = (a: Interval, b: Interval) => ms(a.start) < ms(b.end) && ms(b.start) < ms(a.end);
const interval = (start: unknown, end: unknown): Interval => {
  if (!Number.isFinite(ms(start)) || !Number.isFinite(ms(end)) || ms(start) >= ms(end)) throw new Conflict('A valid start and end time are required');
  return { start: String(start), end: String(end) };
};
const contained = (outer: Interval, inner: Interval) => ms(outer.start) <= ms(inner.start) && ms(inner.end) <= ms(outer.end);
const zone = (value: string) => { try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); } catch { throw new Conflict('Use an IANA time zone'); } };
const normalize = (ranges: Interval[]) => {
  const sorted = ranges.map(r => interval(r.start, r.end)).sort((a,b) => ms(a.start)-ms(b.start));
  const result: Interval[] = [];
  for (const range of sorted) {
    const last = result.at(-1);
    if (last && ms(range.start) <= ms(last.end)) last.end = new Date(Math.max(ms(last.end), ms(range.end))).toISOString();
    else result.push({ ...range });
  }
  return result;
};
const intersects = (a: Interval[], b: Interval[]) => normalize(a.flatMap(x => b.flatMap(y => overlaps(x,y) ? [{ start: new Date(Math.max(ms(x.start),ms(y.start))).toISOString(), end: new Date(Math.min(ms(x.end),ms(y.end))).toISOString() }] : [])));
const subtract = (windows: Interval[], busy: Interval[]) => busy.reduce((free, block) => free.flatMap(window => {
  if (!overlaps(window,block)) return [window];
  const pieces: Interval[] = [];
  if (ms(window.start) < ms(block.start)) pieces.push({ start: window.start, end: block.start });
  if (ms(block.end) < ms(window.end)) pieces.push({ start: block.end, end: window.end });
  return pieces;
}), windows);

export async function readPlan(objects: Reader, raw: ObjectRef, now = Date.now()) {
  if (raw.type !== 'SchedulePlan') throw new Conflict('A SchedulePlan reference is required');
  const plan = await objects.read(raw), range = interval(plan.properties.start, plan.properties.end);
  const resources = await objects.follow(raw, 'resources');
  if (!resources.length) throw new Conflict('The plan has no authorized calendar resource');
  const coverage = await Promise.all((await objects.follow(raw,'availability')).map(async snapshot => ({snapshot,resources:await objects.follow(snapshot.ref,'resource')})));
  const calendars = await Promise.all(resources.map(async resource => {
    const snapshots = coverage.filter(item=>item.resources.length===1 && same(item.resources[0]!.ref,resource.ref)).map(item=>item.snapshot);
    if (snapshots.length !== 1) throw new Conflict('Calendar availability is missing or ambiguous');
    objects.access.source(objects.model, 'PACalendar');
    const snapshot = snapshots[0]!, p = snapshot.properties;
    if (p.complete !== true || ms(p.expiresAt) <= now || ms(p.observedAt) > now+5000 || !Number.isFinite(ms(p.observedAt)) || !contained(interval(p.start,p.end),range)) throw new Conflict('Calendar availability is incomplete, stale or does not cover the plan');
    if (!Array.isArray(p.windows) || !Array.isArray(p.busy)) throw new Conflict('Calendar availability is unreadable');
    const assignments = await objects.follow(resource.ref, 'activities');
    return { resource, snapshot, windows: normalize(p.windows as Interval[]), busy: normalize(p.busy as Interval[]), assignments };
  }));
  const activities = await objects.follow(raw, 'activities');
  return { plan, range, calendars, activities };
}

export async function validate(objects: Reader, plan: ObjectRef, sourceTrip?:ObjectRef, proposedTimes:ReadonlySet<string>=new Set(), now = Date.now()) {
  const state = await readPlan(objects, plan, now), violations: { severity: 'hard'; code: string; activity: ObjectRef; related: ObjectRef[] }[] = [];
  const add = (code: string, activity: ObjectRef, related: ObjectRef[] = []) => violations.push({ severity: 'hard', code, activity, related });
  for (const activity of state.activities) {
    const span = interval(activity.properties.start,activity.properties.end);
    if(proposedTimes.has(activity.ref.id)&&ms(span.start)<now)add('activity_in_past',activity.ref);
    if (!contained(state.range,span)) add('outside_plan_window', activity.ref);
    const assigned = await objects.follow(activity.ref,'resources');
    if (assigned.length !== state.calendars.length || state.calendars.some(c => !assigned.some(r => same(r.ref,c.resource.ref)))) add('required_resource_missing',activity.ref);
    for (const calendar of state.calendars) {
      if (!calendar.windows.some(w => contained(w,span))) add('outside_available_window',activity.ref,[calendar.resource.ref]);
      if (calendar.busy.some(b => overlaps(b,span))) add('calendar_busy',activity.ref,[calendar.snapshot.ref]);
      for (const other of calendar.assignments) if (!same(activity.ref,other.ref) && overlaps(span,interval(other.properties.start,other.properties.end))) add('resource_overlap',activity.ref,[other.ref]);
    }
    for (const successor of await objects.follow(activity.ref,'successors')) if (ms(span.end)>ms(successor.properties.start)) add('downstream_dependency_order',activity.ref,[successor.ref]);
    for (const predecessor of await objects.follow(activity.ref,'predecessors')) {
      if (ms(predecessor.properties.end) > ms(span.start) || same(predecessor.ref,activity.ref)) add('dependency_order',activity.ref,[predecessor.ref]);
    }
  }
  if(objects.model.objects.has('EventTrip'))for(const trip of await objects.follow(plan,'trips')){
    // Completed dispatch/cancellation is historical. Its remaining activities
    // still participate in the resource and dependency checks above.
    if(trip.properties.state==='dispatched'||trip.properties.state==='canceled')continue;
    // Execution rechecks the selected trip's external facts. Other reviewed
    // activities still participate in all resource/time conflict checks above.
    if(sourceTrip&&!same(trip.ref,sourceTrip))continue;
    const events=await objects.follow(trip.ref,'event'),travels=await objects.follow(trip.ref,'travel'),activities=await objects.follow(trip.ref,'activities');
    if(events.length!==1||travels.length!==1||activities.length!==2){add('trip_relationship_incomplete',trip.ref);continue;}
    await currentService(objects,events[0]!.ref);
    const travel=travels[0]!,event=events[0]!,p=trip.properties;
    if(event.properties.status!=='active')add('event_not_active',trip.ref);
    if(!Number.isFinite(ms(travel.properties.expiresAt))||!Number.isFinite(ms(travel.properties.observedAt))||ms(travel.properties.expiresAt)<=now||ms(travel.properties.observedAt)>now+5000)add('trip_route_stale',trip.ref);
    if(typeof p.waitMinutes!=='number'||typeof p.entryMinutes!=='number'||typeof travel.properties.durationSeconds!=='number')add('trip_timing_unknown',trip.ref);
    if(p.eventBindingId!==event.properties.bindingId||p.sourceAuthority!==travel.properties.authorityId)add('trip_source_changed',trip.ref);
    const call=ms(event.properties.start)-Number(p.entryMinutes)*60000-Number(travel.properties.durationSeconds)*1000-Number(p.waitMinutes)*60000;
    if(ms(p.callAt)!==call||ms(p.eventStart)!==ms(event.properties.start)||ms(p.eventEnd)!==ms(event.properties.end)||p.eventIdentity!==event.properties.nativeId||p.venueAddress!==event.properties.address)add('trip_timing_changed',trip.ref);
    const expected=[{id:digest([trip.ref.id,'travel']),start:ms(p.callAt),end:ms(p.eventStart)},{id:digest([trip.ref.id,'event']),start:ms(p.eventStart),end:ms(p.eventEnd)}];
    for(const span of expected)if(!activities.some(a=>a.ref.id===span.id&&ms(a.properties.start)===span.start&&ms(a.properties.end)===span.end))add('trip_activity_changed',trip.ref);
  }
  return { valid: violations.length === 0, evaluatedAt:new Date(now).toISOString(), violations, calendarEvidence: state.calendars.map(c => ({ resource: c.resource.ref, sourceVersion: c.snapshot.properties.sourceVersion, observedAt: c.snapshot.properties.observedAt, expiresAt: c.snapshot.properties.expiresAt, evidence: c.snapshot.properties.evidence })), externalCalendarUpdated: false };
}

export function schedulingFunctions(db: Database): ReadonlyMap<string, FunctionHandler> {
  const proposedTimes=async(objects:Reader)=>{
    if(!objects.model.scenario)return new Set<string>();
    const rows=(await db.query(`SELECT id FROM ${db.schema}.scenario_objects WHERE scenario_id=$1 AND owner=$2 AND type='ScheduledActivity' AND properties IS NOT NULL
      AND (base_properties IS NULL OR properties->'start' IS DISTINCT FROM base_properties->'start' OR properties->'end' IS DISTINCT FROM base_properties->'end')`,[objects.model.scenario,objects.access.principal.owner],objects instanceof Objects?objects.client:undefined)).rows;
    return new Set(rows.map(row=>String(row.id)));
  };
  const saveActivity = async (input: z.output<typeof activityInputSchema>, context: FunctionContext, requestId?: string) => {
    const ref = input.activity??{ type:'ScheduledActivity',id:digest([input.plan.id,input.id]) };
    if(ref.type!=='ScheduledActivity')throw new Conflict('Expected a ScheduledActivity reference');
    if(input.activity&&!input.revision)throw new Conflict('Editing an activity reference requires its current revision');
    interval(input.start,input.end);
    if (context.execution && !context.objects.model.scenario) throw new Conflict('The Agent must propose activity edits in a scenario for PA review');
    if (!context.edit) throw new Conflict('Activity edits require an Action');
    return context.edit(ref,async graph => {
      const state = await readPlan(graph,input.plan,context.scenarioEvaluation?.evaluatedAt);
      let dining: z.output<typeof diningEvidence> | undefined;
      if (requestId) {
        const task = context.execution?.task;
        if (!task || !graph.model.scenario) throw new Conflict('Stage dining through the original task’s Scenario');
        graph.access.source(graph.model, diningSource);
        dining = await diningProof(db,graph.client,{ owner:graph.owner,taskId:task.id,requestId,start:input.start,end:input.end });
      }
      const fields = { id:ref.id,name:dining?.restaurant ?? input.name,start:input.start,end:input.end,...(dining ? { dining } : {}) };
      if(!graph.model.scenario&&ms(input.start)<Date.now()){
        const old=state.activities.find(activity=>same(activity.ref,ref));
        if(!old||old.properties.start!==input.start||old.properties.end!==input.end)throw new Conflict('New or moved activities must start in the future');
      }
      if (input.revision) {
        const activity = state.activities.find(item => same(item.ref, ref));
        if (!activity) throw new Conflict('Activity does not belong to this plan');
        if (Object.hasOwn(activity.properties, 'dining') && !dining &&
            (activity.properties.name !== input.name || ms(activity.properties.start) !== ms(input.start) || ms(activity.properties.end) !== ms(input.end))) {
          throw new Conflict('Refresh the verified dining evidence before editing this meal');
        }
        await graph.edit(ref,input.revision,fields);
        for (const before of await graph.follow(ref,'predecessors')) await graph.unlink({ type:'ActivityDependency',from:ref,to:before.ref });
      } else {
        if(state.activities.some(a=>same(a.ref,ref)))throw new Conflict('Existing activities require their current revision');
        await graph.create(ref,fields);
      }
      await graph.link({ type:'ActivityPlan',from:ref,to:input.plan });
      for (const calendar of state.calendars) await graph.link({ type:'ActivityResource',from:ref,to:calendar.resource.ref });
      for (const predecessor of input.predecessors) {
        if (predecessor.type!=='ScheduledActivity' || same(predecessor,ref)) throw new Conflict('Invalid activity dependency');
        await graph.read(predecessor); await graph.link({ type:'ActivityDependency',from:ref,to:predecessor });
      }
      // Scenarios retain conflicting edits for comparison; live writes must be feasible.
      if (!graph.model.scenario && !(await validate(graph,input.plan)).valid) throw new Conflict('Schedule constraints are not satisfied');
    });
  };
  const handlers = new Map<string, FunctionHandler>([
    ['prepareSchedulePlan', withScenarioPARead(async (raw, context) => {
      const input = planInputSchema.parse(raw); zone(input.timeZone);
      if(input.plan&&!input.scenarioId)throw new Conflict('Replanning an existing plan requires a scenarioId');
      if(input.scenarioId&&!input.plan)throw new Conflict('Scenario preparation requires an existing plan');
      const range = interval(input.start,input.end);
      if (ms(range.end)-ms(range.start) > 31*86400000 || ms(range.end) <= Date.now()) throw new Conflict('Use a future planning window of at most 31 days');
      if (!context.execution || !context.operationId || !context.edit) throw new Conflict('Request calendar information through the original PA task');
      const requests = new PARequests(context.execution.tasks);
      const scope = { start: new Date(ms(input.start)).toISOString(), end: new Date(ms(input.end)).toISOString(), timeZone: input.timeZone };
      const request = { start: input.start, end: input.end, timeZone: input.timeZone, fields: ['busy', 'windows'], purpose: input.title };
      const schema = jsonSchema(calendarResponseSchema);
      let replaces: string | undefined;
      let response: z.infer<typeof calendarResponseSchema>;
      for (;;) {
        context.signal.throwIfAborted();
        const receipt = await requests.requestWithId(context.execution.task, context.operationId, 'calendar.freebusy',
          request, schema, replaces ? { ...scope, replaces } : scope);
        response = calendarResponseSchema.parse(receipt.response);
        if (response.status !== 'available') throw new Conflict(`PA calendar response is ${response.status}`);
        if (response.exclusions?.length) throw new Conflict('This planning request did not authorize calendar exclusions');
        const now = Date.now(), observed = ms(response.observedAt), expires = ms(response.expiresAt);
        if (ms(response.start) !== ms(input.start) || ms(response.end) !== ms(input.end) || response.timeZone !== input.timeZone ||
            observed > now + 5000 || expires <= observed) {
          throw new Conflict('PA calendar response has a stale or mismatched range');
        }
        for (const span of [...response.windows, ...response.busy])
          if (!contained(range, interval(span.start, span.end))) throw new Conflict('PA must clip availability to the requested range');
        if (expires > now) {
          if (expires > observed + 300000) throw new Conflict('PA calendar response has a stale or mismatched range');
          break;
        }
        if (observed < receipt.requestedAt.getTime() - 5000) throw new Conflict('PA calendar response has a stale or mismatched range');
        replaces = receipt.requestId;
      }
      const resource = { type: 'ScheduleResource', id: digest([context.principal.owner,'personal-calendar']) };
      const plan = input.plan ?? { type: 'SchedulePlan', id: context.operationId };
      const availability = { type:'CalendarAvailability',id:digest([resource.id,plan.id]) };
      if (plan.type !== 'SchedulePlan') throw new Conflict('Expected a SchedulePlan');
      if (input.plan) await context.objects.read(plan);
      return context.edit(plan, async live => {
        if (input.scenarioId && live.model.scenario && input.scenarioId !== live.model.scenario)
          throw new Conflict('Calendar preparation must stay within the selected scenario');
        const view=input.scenarioId&&!live.model.scenario?await new Scenarios(db).view(live.access,live.model,input.scenarioId,live.client):undefined;
        const graph=view?new Objects(db,view,live.access,live.client,{...live.change,scenarioEdits:[]}):live;
        await graph.create(resource,{ id: resource.id, name: 'User calendar' });
        const { status: _status, ...facts } = response;
        const properties = { id: availability.id, name: 'PA calendar availability', ...facts };
        const old = await graph.read(availability).catch(error => { if (error instanceof NotFound) return undefined; throw error; });
        if (old) {
          if(ms(old.properties.observedAt)>ms(response.observedAt) || ms(old.properties.observedAt)===ms(response.observedAt) && digest(old.properties)!==digest(properties))throw new Conflict('A newer or conflicting PA calendar snapshot already exists');
          if(digest(old.properties)!==digest(properties))await graph.edit(availability,old.revision,properties);
        } else await graph.create(availability,properties);
        const fields = { id: plan.id, name: input.title, start: input.start, end: input.end, timeZone: input.timeZone, durationMinutes: input.durationMinutes };
        if (input.plan) {
          const current = await graph.read(plan);
          // The Workflow's reviewed delta must include the final confirmation.
          const confirm = context.execution?.task.cognitive_context && graph.model.object('SchedulePlan').properties.state;
          await graph.edit(plan, current.revision, { ...fields, ...(confirm ? { state: 'confirmed' } : {}) });
        } else await graph.create(plan,{...fields,...(graph.model.object('SchedulePlan').properties.state?{state:'prepared'}:{})});
        await graph.linkBatch([{ type:'ResourceAvailability',from:resource,to:availability },{ type:'PlanResource',from:plan,to:resource },{ type:'PlanAvailability',from:plan,to:availability }]);
        if(view)await recordScenarioAction(graph,'PrepareSchedulePlan',raw,plan,context.operationId!);
      });
    })],
    ['findScheduleSlots', async (raw, context) => {
      const now = context.scenarioEvaluation?.evaluatedAt ?? Date.now();
      const input = searchSlotsSchema.parse(raw), state = await readPlan(context.objects,input.plan,now);
      if (input.ignoreActivity && !state.activities.some(a => same(a.ref,input.ignoreActivity!))) throw new Conflict('Only an activity in this plan can be excluded for rescheduling');
      let free = [state.range];
      for (const calendar of state.calendars) {
        const occupied = calendar.assignments.filter(a => !input.ignoreActivity || !same(a.ref,input.ignoreActivity)).map(a => interval(a.properties.start,a.properties.end));
        free = intersects(free,subtract(calendar.windows,normalize([...calendar.busy,...occupied])));
      }
      if (input.ignoreActivity) {
        const predecessors=await context.objects.follow(input.ignoreActivity,'predecessors'),successors=await context.objects.follow(input.ignoreActivity,'successors');
        const start=Math.max(ms(state.range.start),...predecessors.map(p=>ms(p.properties.end)));
        const end=Math.min(ms(state.range.end),...successors.map(p=>ms(p.properties.start)));
        free=start<end?intersects(free,[{start:new Date(start).toISOString(),end:new Date(end).toISOString()}]):[];
      }
      const duration = Number(state.plan.properties.durationMinutes)*60000, step = input.stepMinutes*60000, slots: { start: string; end: string }[] = [];
      for (const window of free) {
        for (let start=ms(window.start)+Math.max(0,Math.ceil((now-ms(window.start))/step))*step;start+duration<=ms(window.end) && slots.length<input.limit;start+=step) slots.push({ start:new Date(start).toISOString(),end:new Date(start+duration).toISOString() });
        if (slots.length===input.limit) break;
      }
      return { plan: input.plan, slots, timeZone: state.plan.properties.timeZone, resources:state.calendars.map(c=>c.resource.ref), calendarEvidence:state.calendars.map(c=>({resource:c.resource.ref,sourceVersion:c.snapshot.properties.sourceVersion,observedAt:c.snapshot.properties.observedAt,expiresAt:c.snapshot.properties.expiresAt,evidence:c.snapshot.properties.evidence})),evaluatedAt:new Date(now).toISOString(),externalCalendarUpdated:false };
    }],
    ['editScheduleActivity', (raw, context) => saveActivity(activityInputSchema.parse(raw), context)],
    ['stageDiningActivity', (raw, context) => {
      const { requestId, ...input } = diningActivityInputSchema.parse(raw);
      return saveActivity(input, context, requestId);
    }],
    ['removeScheduleActivity', async (raw,context) => {
      const input=removeActivitySchema.parse(raw);
      if(context.execution && !context.objects.model.scenario)throw new Conflict('The Agent must propose activity edits in a scenario for PA review');
      if (!context.edit || input.activity.type!=='ScheduledActivity') throw new Conflict('A ScheduledActivity Action is required');
      const plans=await context.objects.follow(input.activity,'plan'); if(plans.length!==1)throw new Conflict('Activity must have one plan');
      return context.edit(plans[0]!.ref,async graph=>{await graph.remove(input.activity,input.revision);});
    }],
    ['validateSchedule', async (raw,context)=>validate(context.objects,planRefSchema.parse(raw).plan,undefined,await proposedTimes(context.objects),context.scenarioEvaluation?.evaluatedAt)],
    ['readSchedulePlan', async (raw,context)=>{
      const input=planRefSchema.parse(raw),state=await readPlan(context.objects,input.plan,context.scenarioEvaluation?.evaluatedAt);
      return { plan:state.plan,activities:state.activities,validation:await validate(context.objects,input.plan,undefined,await proposedTimes(context.objects),context.scenarioEvaluation?.evaluatedAt),scenarioId:context.objects.model.scenario??null,externalCalendarUpdated:false };
    }],
    ['commitSchedulePlan',async(raw,context)=>{
      const input=commitPlanSchema.parse(raw);
      if (!context.edit || context.execution) throw new Conflict('The PA must apply the reviewed merge Action explicitly');
      return context.edit(input.plan,async graph=>{
        const serviceLinks=[...graph.model.objects.keys()].filter(type=>graph.model.implements(type,'ServiceOffering')).map(type=>graph.model.navigation(type,'plans','ServiceOffering').link);
        await new Scenarios(db).mergeInto(graph,input.scenarioId,input.revision,{objects:['ScheduledActivity','SchedulePlan','ScheduleResource','CalendarAvailability','EventTrip'],links:['ActivityPlan','ActivityResource','ActivityDependency','PlanResource','PlanAvailability','ResourceAvailability','TripPlan','TripEvent','TripTravel','TripActivities',...serviceLinks],validateAction:context.validateScenarioAction,validate:async(view,touched,links)=>{
          if(links.some(link=>link.to.type==='SchedulePlan'&&!same(link.to,input.plan)))throw new Conflict('Scenario contains service links outside the selected plan');
          for(const item of touched){
            if(view.model.implements(item.ref.type,'ServiceOffering')){await currentService(view,item.ref);continue;}
            if(item.ref.type==='SchedulePlan'){
              if(item.deleted||!same(item.ref,input.plan))throw new Conflict('Scenario changes another plan');
              continue;
            }
            if(item.ref.type==='CalendarAvailability'){
              if(item.deleted||!(await view.follow(input.plan,'availability')).some(snapshot=>same(snapshot.ref,item.ref)))throw new Conflict('Scenario changes unrelated calendar coverage');
              continue;
            }
            if(item.ref.type==='ScheduleResource'){
              if(item.deleted||!(await view.follow(input.plan,'resources')).some(resource=>same(resource.ref,item.ref)))throw new Conflict('Scenario changes unrelated resources');
              continue;
            }
            const plans=await (item.deleted?graph:view).follow(item.ref,'plan');
            if(plans.length!==1 || !same(plans[0]!.ref,input.plan))throw new Conflict('Scenario contains activities outside the selected plan');
            if (item.ref.type === 'ScheduledActivity' && !item.deleted) {
              const activity = await view.read(item.ref);
              if (Object.hasOwn(activity.properties, 'dining')) {
                view.access.source(view.model, diningSource);
                const saved = diningEvidence.parse(activity.properties.dining);
                const current = await diningProof(db,view.client,{ owner:view.owner,taskId:saved.taskId,requestId:saved.requestId,
                  start:String(activity.properties.start),end:String(activity.properties.end) });
                if (digest(current)!==digest(saved) || activity.properties.name!==current.restaurant) {
                  throw new Conflict('Dining availability differs from the reviewed activity');
                }
              }
            }
          }
          if(!(await validate(view,input.plan,undefined,await proposedTimes(view))).valid)throw new Conflict('Proposed schedule constraints reject this scenario');
        }});
        const result=await validate(graph,input.plan);
        if (!result.valid) throw new Conflict('Current calendar or schedule constraints reject this scenario');
        if(graph.model.object('SchedulePlan').properties.state){const plan=await graph.read(input.plan);if(plan.properties.state!=='confirmed')await graph.edit(input.plan,plan.revision,{state:'confirmed'});}
      });
    }],
  ]);
  for (const name of ['findScheduleSlots', 'editScheduleActivity', 'removeScheduleActivity', 'validateSchedule', 'readSchedulePlan'])
    withScenarioEvaluation(handlers.get(name)!);
  return handlers;
}
