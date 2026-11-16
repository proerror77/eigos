import { Conflict, digest } from '../../core/identity.js';
import { calendarJourney, journeyPolicyProposalType, journeyReplayInput, journeyReplayResult, journeyType } from '../../ontology/calendar-journey.js';
import type { Database } from '../../runtime/database.js';
import { EditHistory } from '../../runtime/edit-history.js';
import { withScenarioEvaluation, type FunctionContext, type FunctionHandler } from '../../runtime/functions.js';
import { Objects } from '../../runtime/objects.js';
import { decideJourney, epoch } from './decision.js';

export function calendarJourneyReplayFunctions(db: Database): ReadonlyMap<string, FunctionHandler> {
  const history = new EditHistory(db);

  const replay = async (raw: unknown, ctx: FunctionContext) => {
    const input = journeyReplayInput.parse(raw);
    if (input.journey.type !== journeyType) throw new Conflict('Select a CalendarJourney');
    const { model, access } = ctx.objects;
    access.source(model, 'PACalendar');
    access.source(model, 'Amap');
    const rows = new Objects(db, model, access, ctx.scenarioEvaluation?.client);
    const page = await db.withOwner(ctx.principal.owner, () => history.read(rows, input.journey, (BigInt(input.sequence) - 1n).toString(), 1));
    const record = page.items[0];
    if (record?.sequence !== input.sequence || record.action !== 'CheckCalendarJourney' || !record.taskId)
      throw new Conflict('Select a committed check of the original CalendarJourney');
    const previous = calendarJourney.parse(record.before), observed = calendarJourney.parse(record.after);
    if (!observed.checkedAt || previous.mapAuthority !== observed.mapAuthority || previous.scheduleId !== observed.scheduleId)
      throw new Conflict('The check has no compatible captured observation');
    const now = epoch(observed.checkedAt);
    if (!Number.isFinite(now) || now > (ctx.scenarioEvaluation?.evaluatedAt ?? Date.now())) throw new Conflict('Invalid check time');
    const baseline = decideJourney(previous, observed.calendar, observed.route, observed.weather, now);
    const candidate = decideJourney(previous, observed.calendar, observed.route, observed.weather, now, 'retain_earlier');
    const actualCount = Number(observed.reminderVersion !== previous.reminderVersion);
    const counted = (result: typeof baseline) => Number(result.reminderVersion !== previous.reminderVersion);
    const compatible = baseline.observation.state === observed.state && baseline.observation.reason === observed.reason
      && digest(baseline.observation.timing) === digest(observed.timing)
      && baseline.reminderVersion === observed.reminderVersion && digest(baseline.reminder) === digest(observed.reminder);
    return journeyReplayResult.parse({
      evidence: observed.calendar?.status === 'available' ? observed.calendar.evidence : 'unavailable',
      evidenceDigest: digest([record.sequence, record.release, record.taskId, previous, observed]),
      observedState: observed.state, decisionMatchesHistory: compatible,
      baselineReminderChanges: counted(baseline), candidateReminderChanges: counted(candidate), observedReminderChanges: actualCount,
      leadTimeDeltaSeconds: baseline.reminder && candidate.reminder ?
        (epoch(baseline.reminder.prepareAt) - epoch(candidate.reminder.prepareAt)) / 1000 : null,
      keepsSafety: candidate.observation.state === baseline.observation.state
        && candidate.observation.reason === baseline.observation.reason
        && (baseline.reminder === null ? candidate.reminder === null :
          candidate.reminder !== null && epoch(candidate.reminder.prepareAt) <= epoch(baseline.reminder.prepareAt)),
    });
  };

  const stage: FunctionHandler = withScenarioEvaluation(async (raw, ctx) => {
    if (!ctx.objects.model.scenario || !ctx.edit) throw new Conflict('Policy evaluation proposals must be staged in a Scenario');
    const { journey, sequence } = journeyReplayInput.parse(raw);
    const facts = await replay(raw, ctx);
    if (!facts.decisionMatchesHistory || !facts.keepsSafety)
      throw new Conflict('The replay differed from history or failed the safety check');
    const ref = { type: journeyPolicyProposalType, id: digest([journey, sequence, 'retain_earlier']) };
    return ctx.edit(ref, async graph => {
      await graph.create(ref, {
        id: ref.id, name: 'Retain the earlier reminder on a small route improvement',
        policy: 'retain_earlier', sequence, ...facts,
      });
      await graph.link({ type: 'CalendarJourneyPolicyReviewEvidence', from: ref, to: journey });
    });
  });

  return new Map([['evaluateCalendarJourneyHistory', withScenarioEvaluation(replay)], ['stageCalendarJourneyPolicyReview', stage]]);
}
