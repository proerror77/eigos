import { setTimeout as delay } from 'node:timers/promises';

/** The Indexer's automation work: Scenario cleanup, rule scans and durable workflow runs. */
export interface AutomationDispatch {
  /** Removes expired Scenario state and reports whether more remains. */
  cleanup(): Promise<{ more: boolean }>;
  /** Each scan reports whether it found work. */
  scans: readonly (() => Promise<boolean>)[];
  /** Claims and executes one durable workflow run, reporting whether one was claimed. */
  run(signal: AbortSignal): Promise<boolean>;
}

/**
 * Scans rules and executes workflow runs in separate loops, so a slow run does not delay rule
 * discovery. Runs stay durable rows claimed with leases; a productive scan wakes an idle runner.
 * If either loop fails, the other stops after its current step and the first error is reported.
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
  async function scan() {
    let nextCleanup = 0;
    while (!stopped.aborted) {
      if (Date.now() >= nextCleanup) {
        const cleaned = await parts.cleanup();
        nextCleanup = Date.now() + (cleaned.more ? 1000 : 60000);
      }
      let worked = false;
      for (const scanOne of parts.scans) worked = await scanOne() || worked;
      if (worked) { found++; wakeRunner?.(); }
      else await delay(idleMs, undefined, { signal: stopped }).catch(() => {});
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
  await Promise.all([settle(scan()), settle(run())]);
  if (failure) throw failure.error;
}
