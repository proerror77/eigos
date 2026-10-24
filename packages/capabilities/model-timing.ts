/** Client-observed boundaries. They do not reveal server queue or inference time. */
export interface ModelClockMark { at: string; monotonicMs: number }
export const modelClockMark = (): ModelClockMark => ({ at: new Date().toISOString(), monotonicMs: performance.now() });
export interface ModelOutputObservation {
  firstDelta?: ModelClockMark; lastDelta?: ModelClockMark; completed?: ModelClockMark;
  deltaCount: number; deltaBytes: number;
}
export interface ModelSessionStartup {
  opened: ModelClockMark; initializeSent: ModelClockMark; initialized: ModelClockMark; ready: ModelClockMark;
}
export interface ModelTiming {
  version: 'model-client-timing-v1'; clock: 'monotonic';
  outputBoundary: 'streamed_delta' | 'completed_item_only';
  totalMs: number; setupMs: number; requestToFirstOutputMs: number;
  visibleOutputMs: number | null; afterOutputMs: number;
  startup: { localPreparationMs: number; processInitializeMs: number; threadStartMs: number; readyToRequestMs: number };
  requestAcknowledgementMs: number;
  requestToFirstActivityMs: number | null; requestToFirstReasoningEventMs: number | null;
  firstActivityAt?: string; firstReasoningEventAt?: string;
  firstOutputAt: string; lastOutputAt: string; outputItemCompletedAt: string; turnCompletedAt: string;
  outputDeltaCount: number; outputDeltaBytes: number;
}
export function observedModelTiming(input: {
  started: ModelClockMark; sent: ModelClockMark; acknowledged: ModelClockMark; completed: ModelClockMark;
  turnCompleted: ModelClockMark; output: ModelOutputObservation;
  startup?: ModelSessionStartup; firstActivity?: ModelClockMark; firstReasoning?: ModelClockMark;
}): ModelTiming {
  const duration = (from: ModelClockMark, to: ModelClockMark) => {
    const value = to.monotonicMs - from.monotonicMs;
    if (!Number.isFinite(value) || value < 0) throw new Error('Invalid client timing order');
    return value;
  };
  if (!input.output.completed) throw new Error('A completed output is required for timing');
  const streamed = !!input.output.firstDelta && !!input.output.lastDelta;
  const first = input.output.firstDelta ?? input.output.completed, last = input.output.lastDelta ?? input.output.completed;
  const startup = input.startup;
  return {
    version: 'model-client-timing-v1', clock: 'monotonic', outputBoundary: streamed ? 'streamed_delta' : 'completed_item_only',
    totalMs: duration(input.started, input.completed), setupMs: duration(input.started, input.sent),
    requestToFirstOutputMs: duration(input.sent, first), visibleOutputMs: streamed ? duration(first, last) : null,
    afterOutputMs: duration(last, input.completed),
    startup: startup ? {
      localPreparationMs: duration(startup.opened, startup.initializeSent),
      processInitializeMs: duration(startup.initializeSent, startup.initialized),
      threadStartMs: duration(startup.initialized, startup.ready), readyToRequestMs: duration(startup.ready, input.sent),
    } : { localPreparationMs: 0, processInitializeMs: 0, threadStartMs: 0, readyToRequestMs: duration(input.started, input.sent) },
    requestAcknowledgementMs: duration(input.sent, input.acknowledged),
    requestToFirstActivityMs: input.firstActivity ? duration(input.sent, input.firstActivity) : null,
    requestToFirstReasoningEventMs: input.firstReasoning ? duration(input.sent, input.firstReasoning) : null,
    ...(input.firstActivity ? { firstActivityAt: input.firstActivity.at } : {}),
    ...(input.firstReasoning ? { firstReasoningEventAt: input.firstReasoning.at } : {}),
    firstOutputAt: first.at, lastOutputAt: last.at, outputItemCompletedAt: input.output.completed.at,
    turnCompletedAt: input.turnCompleted.at, outputDeltaCount: input.output.deltaCount, outputDeltaBytes: input.output.deltaBytes,
  };
}
