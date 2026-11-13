import { Conflict, NotFound, digest } from '../../core/identity.js';
import { type ObjectRef } from '../../ontology/schema.js';
import type { FunctionContext, FunctionHandler } from '../../runtime/functions.js';
import type { Database } from '../../runtime/database.js';
import { Scenarios } from '../../runtime/scenarios.js';
import { PARequests } from '../../runtime/pa.js';
import { activityInputSchema, calendarResponseSchema, commitPlanSchema, jsonSchema, planInputSchema, planRefSchema, removeActivitySchema, searchSlotsSchema } from './contracts.js';

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

async function readPlan(objects: Reader, raw: ObjectRef) {
  if (raw.type !== 'SchedulePlan') throw new Conflict('A SchedulePlan reference is required');
  const plan = await objects.read(raw), range = interval(plan.properties.start, plan.properties.end);
  const resources = await objects.follow(raw, 'resources');
  if (!resources.length) throw new Conflict('The plan has no authorized calendar resource');
  const calendars = await Promise.all(resources.map(async resource => {
    const snapshots = await objects.follow(resource.ref, 'availability');
    if (snapshots.length !== 1) throw new Conflict('Calendar availability is missing or ambiguous');
    objects.access.source(objects.model, 'PACalendar');
    const snapshot = snapshots[0]!, p = snapshot.properties;
    if (p.complete !== true || ms(p.expiresAt) <= Date.now() || ms(p.observedAt) > Date.now()+5000 || !Number.isFinite(ms(p.observedAt)) || !contained(interval(p.start,p.end),range)) throw new Conflict('Calendar availability is incomplete, stale or does not cover the plan');
    if (!Array.isArray(p.windows) || !Array.isArray(p.busy)) throw new Conflict('Calendar availability is unreadable');
    const assignments = await objects.follow(resource.ref, 'activities');
    return { resource, snapshot, windows: normalize(p.windows as Interval[]), busy: normalize(p.busy as Interval[]), assignments };
  }));
  const activities = await objects.follow(raw, 'activities');
  return { plan, range, calendars, activities };
}

async function validate(objects: Reader, plan: ObjectRef) {
  const state = await readPlan(objects, plan), violations: { severity: 'hard'; code: string; activity: ObjectRef; related: ObjectRef[] }[] = [];
  const add = (code: string, activity: ObjectRef, related: ObjectRef[] = []) => violations.push({ severity: 'hard', code, activity, related });
  for (const activity of state.activities) {
    const span = interval(activity.properties.start,activity.properties.end);
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
  return { valid: violations.length === 0, evaluatedAt:new Date().toISOString(), violations, calendarEvidence: state.calendars.map(c => ({ resource: c.resource.ref, sourceVersion: c.snapshot.properties.sourceVersion, observedAt: c.snapshot.properties.observedAt, expiresAt: c.snapshot.properties.expiresAt, evidence: c.snapshot.properties.evidence })), externalCalendarUpdated: false };
}

export function schedulingFunctions(db: Database): ReadonlyMap<string, FunctionHandler> {
  return new Map<string, FunctionHandler>([
    ['prepareSchedulePlan', async (raw, context) => {
      const input = planInputSchema.parse(raw); zone(input.timeZone);
      const range = interval(input.start,input.end);
      if (ms(range.end)-ms(range.start) > 31*86400000 || ms(range.end) <= Date.now()) throw new Conflict('Use a future planning window of at most 31 days');
      if (!context.execution || !context.operationId || !context.edit) throw new Conflict('Request calendar information through the original PA task');
      const response = calendarResponseSchema.parse(await new PARequests(context.execution.tasks).request(context.execution.task, context.operationId, 'calendar.freebusy',
        { start: input.start, end: input.end, timeZone: input.timeZone, fields: ['busy', 'windows'], purpose: input.title }, jsonSchema(calendarResponseSchema)));
      if (response.status !== 'available') throw new Conflict(`PA calendar response is ${response.status}`);
      const now = Date.now();
      if (ms(response.start) !== ms(input.start) || ms(response.end) !== ms(input.end) || response.timeZone !== input.timeZone || ms(response.observedAt)>now+5000 || ms(response.observedAt)<now-300000 || ms(response.expiresAt)<=now || ms(response.expiresAt)>ms(response.observedAt)+300000) throw new Conflict('PA calendar response has a stale or mismatched range');
      for (const span of [...response.windows,...response.busy]) if (!contained(range,interval(span.start,span.end))) throw new Conflict('PA must clip availability to the requested range');
      const resource = { type: 'ScheduleResource', id: digest([context.principal.owner,'personal-calendar']) }, availability = { type: 'CalendarAvailability', id: resource.id };
      const plan = input.plan ?? { type: 'SchedulePlan', id: context.operationId };
      if (plan.type !== 'SchedulePlan') throw new Conflict('Expected a SchedulePlan');
      if (input.plan) await context.objects.read(plan);
      return context.edit(plan, async graph => {
        await graph.create(resource,{ id: resource.id, name: 'User calendar' });
        const { status: _status, ...facts } = response;
        const properties = { id: availability.id, name: 'PA calendar availability', ...facts };
        const old = await graph.read(availability).catch(error => { if (error instanceof NotFound) return undefined; throw error; });
        if (old) {
          if(ms(old.properties.observedAt)>ms(response.observedAt) || ms(old.properties.observedAt)===ms(response.observedAt) && digest(old.properties)!==digest(properties))throw new Conflict('A newer or conflicting PA calendar snapshot already exists');
          if(digest(old.properties)!==digest(properties))await graph.edit(availability,old.revision,properties);
        } else await graph.create(availability,properties);
        const fields = { id: plan.id, name: input.title, start: input.start, end: input.end, timeZone: input.timeZone, durationMinutes: input.durationMinutes };
        if (input.plan) { const current = await graph.read(plan); await graph.edit(plan,current.revision,fields); } else await graph.create(plan,fields);
        await graph.linkBatch([{ type:'ResourceAvailability',from:resource,to:availability },{ type:'PlanResource',from:plan,to:resource }]);
      });
    }],
    ['findScheduleSlots', async (raw, context) => {
      const input = searchSlotsSchema.parse(raw), state = await readPlan(context.objects,input.plan);
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
        for (let start=ms(window.start)+Math.max(0,Math.ceil((Date.now()-ms(window.start))/step))*step;start+duration<=ms(window.end) && slots.length<input.limit;start+=step) slots.push({ start:new Date(start).toISOString(),end:new Date(start+duration).toISOString() });
        if (slots.length===input.limit) break;
      }
      return { plan: input.plan, slots, timeZone: state.plan.properties.timeZone, resources:state.calendars.map(c=>c.resource.ref), calendarEvidence:state.calendars.map(c=>({resource:c.resource.ref,sourceVersion:c.snapshot.properties.sourceVersion,observedAt:c.snapshot.properties.observedAt,expiresAt:c.snapshot.properties.expiresAt,evidence:c.snapshot.properties.evidence})),evaluatedAt:new Date().toISOString(),externalCalendarUpdated:false };
    }],
    ['editScheduleActivity', async (raw, context) => {
      const input = activityInputSchema.parse(raw), ref = { type:'ScheduledActivity',id:digest([input.plan.id,input.id]) };
      interval(input.start,input.end);
      if (context.execution && !context.objects.model.scenario) throw new Conflict('The Agent must propose activity edits in a scenario for PA review');
      if (!context.edit) throw new Conflict('Activity edits require an Action');
      return context.edit(ref,async graph => {
        const state = await readPlan(graph,input.plan), fields = { id:ref.id,name:input.name,start:input.start,end:input.end };
        if (input.revision) {
          if (!state.activities.some(a=>same(a.ref,ref))) throw new Conflict('Activity does not belong to this plan');
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
    }],
    ['removeScheduleActivity', async (raw,context) => {
      const input=removeActivitySchema.parse(raw);
      if(context.execution && !context.objects.model.scenario)throw new Conflict('The Agent must propose activity edits in a scenario for PA review');
      if (!context.edit || input.activity.type!=='ScheduledActivity') throw new Conflict('A ScheduledActivity Action is required');
      const plans=await context.objects.follow(input.activity,'plan'); if(plans.length!==1)throw new Conflict('Activity must have one plan');
      return context.edit(plans[0]!.ref,async graph=>{await graph.remove(input.activity,input.revision);});
    }],
    ['validateSchedule', async (raw,context)=>validate(context.objects,planRefSchema.parse(raw).plan)],
    ['readSchedulePlan', async (raw,context)=>{
      const input=planRefSchema.parse(raw),state=await readPlan(context.objects,input.plan);
      return { plan:state.plan,activities:state.activities,validation:await validate(context.objects,input.plan),scenarioId:context.objects.model.scenario??null,externalCalendarUpdated:false };
    }],
    ['commitSchedulePlan',async(raw,context)=>{
      const input=commitPlanSchema.parse(raw);
      if (!context.edit || context.execution) throw new Conflict('The PA must apply the reviewed merge Action explicitly');
      return context.edit(input.plan,async graph=>{
        await new Scenarios(db).mergeInto(graph,input.scenarioId,input.revision,{objects:['ScheduledActivity'],links:['ActivityPlan','ActivityResource','ActivityDependency'],validate:async(view,touched)=>{
          for(const item of touched){
            const plans=await (item.deleted?graph:view).follow(item.ref,'plan');
            if(plans.length!==1 || !same(plans[0]!.ref,input.plan))throw new Conflict('Scenario contains activities outside the selected plan');
          }
        }});
        const result=await validate(graph,input.plan);
        if (!result.valid) throw new Conflict('Current calendar or schedule constraints reject this scenario');
      });
    }],
  ]);
}
