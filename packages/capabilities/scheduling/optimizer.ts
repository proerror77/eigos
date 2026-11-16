import type { ObjectRef } from '../../ontology/schema.js';
import { Conflict } from '../../core/identity.js';

type Slot = { start: number; end: number };
export type OptimizationActivity = {
  activity: ObjectRef; revision: number; original: Slot; windows: Slot[]; predecessors: string[]; successors: string[];
};
const compare = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
};

export function optimizeSchedule(activities: OptimizationActivity[], step: number,
  objective: 'minimum_displacement' | 'earliest_finish', signal: AbortSignal, limit = 50_000) {
  const assignments = new Map<string, Slot>();
  const ids = new Set(activities.map(item => item.activity.id));
  if (ids.size !== activities.length) throw new Conflict('Schedule activities must be distinct');
  const domains = activities.map(item => {
    const duration = item.original.end - item.original.start;
    const domain = new Set<number>();
    for (const window of item.windows) {
      for (let start = Math.ceil(window.start / step) * step; start + duration <= window.end; start += step)
        domain.add(start);
      if (item.original.start >= window.start && item.original.end <= window.end) domain.add(item.original.start);
    }
    const starts = [...domain].sort((a,b) => objective === 'earliest_finish' ? a-b :
      Math.abs(a-item.original.start)-Math.abs(b-item.original.start) || a-b);
    return { ...item, duration, starts };
  }).sort((a,b) => a.starts.length-b.starts.length || a.activity.id.localeCompare(b.activity.id));
  let best: Map<string, Slot> | undefined;
  let score: number[] | undefined;
  let explored = 0, exhausted = false;
  const metric = (shift: number, end: number) => objective === 'earliest_finish' ? [end,shift] : [shift,end];

  function search(index: number, shift: number, end: number) {
    if (score && compare(metric(shift,end),score) >= 0) return;
    if (index === domains.length) {
      best = new Map(assignments);
      score = metric(shift,end);
      return;
    }
    const item = domains[index]!;
    for (const start of item.starts) {
      signal.throwIfAborted();
      if (++explored > limit) { exhausted = true; return; }
      const slot = { start, end: start + item.duration };
      if ([...assignments.values()].some(other => other.start < slot.end && slot.start < other.end)) continue;
      if (item.predecessors.some(id => (assignments.get(id)?.end ?? -Infinity) > slot.start)
        || item.successors.some(id => (assignments.get(id)?.start ?? Infinity) < slot.end)) continue;
      assignments.set(item.activity.id,slot);
      search(index+1,shift+Math.abs(start-item.original.start),Math.max(end,slot.end));
      assignments.delete(item.activity.id);
      if (exhausted) return;
    }
  }
  search(0,0,0);
  return {
    status: best ? (exhausted ? 'feasible' as const : 'optimal' as const) : (exhausted ? 'search_limit' as const : 'infeasible' as const),
    explored: Math.min(explored,limit),
    moves: best ? activities.map(item => {
      const slot = best!.get(item.activity.id)!;
      return { activity:item.activity, revision:item.revision, start:new Date(slot.start).toISOString(), end:new Date(slot.end).toISOString() };
    }) : [],
  };
}
