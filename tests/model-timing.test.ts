import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observedModelTiming, type ModelClockMark } from '../packages/capabilities/model-timing.js';

const mark = (ms: number): ModelClockMark => ({ monotonicMs: ms, at: new Date(100000 + ms).toISOString() });
const base = () => ({ started: mark(0), sent: mark(30), acknowledged: mark(40), completed: mark(120), turnCompleted: mark(115),
  startup: { opened: mark(0), initializeSent: mark(5), initialized: mark(15), ready: mark(25) },
  output: { deltaCount: 2, deltaBytes: 12, firstDelta: mark(70), lastDelta: mark(100), completed: mark(110) },
  firstActivity: mark(35), firstReasoning: mark(50) });

test('Observed phases partition the client interval and keep nested acknowledgement/reasoning windows separate', () => {
  const result = observedModelTiming(base());
  assert.equal(result.totalMs, 120); assert.equal(result.setupMs, 30);
  assert.equal(result.requestToFirstOutputMs, 40); assert.equal(result.visibleOutputMs, 30); assert.equal(result.afterOutputMs, 20);
  assert.equal(result.setupMs + result.requestToFirstOutputMs + result.visibleOutputMs! + result.afterOutputMs, result.totalMs);
  assert.equal(Object.values(result.startup).reduce((a,b) => a+b), result.setupMs);
  assert.equal(result.requestAcknowledgementMs, 10); assert.equal(result.requestToFirstReasoningEventMs, 20);
});

test('A completed-item-only response reports unavailable streaming duration instead of zero generation', () => {
  const result = observedModelTiming({ ...base(), output: { completed: mark(110), deltaCount: 0, deltaBytes: 0 } });
  assert.equal(result.outputBoundary, 'completed_item_only'); assert.equal(result.visibleOutputMs, null);
  assert.equal(result.requestToFirstOutputMs, 80); assert.equal(result.afterOutputMs, 10);
});

test('Early notifications retain their actual observation time before request acknowledgement', () => {
  const result = observedModelTiming({ ...base(), acknowledged: mark(90) });
  assert.equal(result.requestAcknowledgementMs, 60); assert.equal(result.requestToFirstOutputMs, 40);
  assert(result.firstOutputAt < mark(90).at);
});

test('A reused session charges no earlier process or thread startup', () => {
  const result = observedModelTiming({ ...base(), startup: undefined, started: mark(25) });
  assert.equal(result.setupMs, 5); assert.equal(result.startup.localPreparationMs, 0);
  assert.equal(result.startup.processInitializeMs, 0); assert.equal(result.startup.threadStartMs, 0);
  assert.equal(result.startup.readyToRequestMs, 5);
});

test('Monotonic phases stay valid across wall-clock adjustment and reject impossible local ordering', () => {
  const value = base(); value.completed.at = '1970-01-01T00:00:00.000Z';
  assert.equal(observedModelTiming(value).totalMs, 120);
  assert.throws(() => observedModelTiming({ ...base(), sent: mark(150) }), /timing order/);
});
