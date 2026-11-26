import { setTimeout as delay } from 'node:timers/promises';

/** The Indexer's automation work: Scenario cleanup, rule scans and durable workflow runs. */
export interface AutomationDispatch {
  /** Removes expired Scenario state and reports whether more remains. */
  cleanup(): Promise<{ more: boolean }>;
  /** Independent change consumers; each scan reports whether it found work. */
  scans: readonly (() => Promise<boolean>)[];
  /** Claims and executes one durable workflow run, reporting whether one was claimed. */
  run(signal: AbortSignal): Promise<boolean>;
}

/**
 * Runs Scenario cleanup, each scan and workflow execution in separate loops, so a slow run does not delay rule
 * discovery and a slow consumer does not delay the others. Runs stay durable rows claimed with leases; a productive
 * scan wakes an idle runner. If any loop fails, the others stop after their current step and the first error is reported.
 */
export async function dispatchAutomation(parts: AutomationDispatch, signal: AbortSignal, idleMs = 1000) {
  const stop = new AbortController(), stopped = AbortSignal.any([signal, stop.signal]);
  let found = 0, wakeRunner: (() => void) | undefined;
  const runnerIdle = () => new Promise<void>(resolve => {
    if (stopped.aborted) return resolve();
    const done = () => { clearTimeout(timer); stopped.removeEventListener('abort', done); wakeRunner = undefined; resolve(); };
    const timer = setTimeout(done, idleMs);
    stopped.addEventListener('abort', done, { once: true });
    wakeRunner = done;
  });
  const pause = (ms: number) => delay(ms, undefined, { signal: stopped }).catch(() => {});
  async function cleanup() {
    while (!stopped.aborted) {
      const cleaned = await parts.cleanup();
      await pause(cleaned.more ? Math.min(1000, idleMs) : 60000);
    }
  }
  async function scan(scanOne: () => Promise<boolean>) {
    while (!stopped.aborted) {
      if (await scanOne()) { found++; wakeRunner?.(); }
      else await pause(idleMs);
    }
  }
  async function run() {
    while (!stopped.aborted) {
      const seen = found;
      // The process signal, not a sibling failure, interrupts a run already in progress.
      if (await parts.run(signal)) continue;
      if (seen === found) await runnerIdle();
    }
  }
  let failure: { error: unknown } | undefined;
  const settle = (loop: Promise<void>) => loop.catch(error => { failure ??= { error }; stop.abort(); });
  await Promise.all([settle(cleanup()), ...parts.scans.map(scanOne => settle(scan(scanOne))), settle(run())]);
  if (failure) throw failure.error;
}
