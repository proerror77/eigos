import { randomUUID } from 'node:crypto';

/** A wakeup is only a hint. Message contents and permissions always come from
 * the store again, including after a timeout or a coordinator restart. */
export interface RelayNotifications {
  snapshot(): Promise<string>;
  wait(revision: string, milliseconds: number, signal?: AbortSignal): Promise<void>;
  notify(): Promise<void>;
}

export class MemoryRelayNotifications implements RelayNotifications {
  private revision = randomUUID();
  private readonly waiting = new Set<() => void>();
  async snapshot() { return this.revision; }
  async notify() {
    this.revision = randomUUID();
    for (const wake of [...this.waiting]) wake();
  }
  async wait(revision: string, milliseconds: number, signal?: AbortSignal) {
    if (revision !== this.revision || signal?.aborted || milliseconds <= 0) return;
    if (this.waiting.size >= 128) throw new Error('Relay notification capacity exceeded');
    await new Promise<void>(resolve => {
      const wake = () => { clearTimeout(timer); this.waiting.delete(wake); signal?.removeEventListener('abort', wake); resolve(); };
      const timer = setTimeout(wake, Math.min(25000, milliseconds));
      this.waiting.add(wake); signal?.addEventListener('abort', wake, { once: true });
      // Register before checking again so a change cannot fall between them.
      if (revision !== this.revision || signal?.aborted) wake();
    });
  }
}
