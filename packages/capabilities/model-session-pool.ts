import { createHash } from 'node:crypto';
import { openCodexModelSession, type StructuredModelSession } from './model-session.js';
import { SessionPromptData } from '../coordinator/prompt-data.js';

type Entry = { session: Promise<StructuredModelSession>; controller: AbortController; data: SessionPromptData; busy: boolean; schema: string; timer?: ReturnType<typeof setTimeout>; closing?: Promise<void> };

/** Only the same owner/request/revision/ontology key may retain a conversation.
 * A lease has no tools or authority; every decision still owns fresh host reads. */
export class ModelSessionPool {
  private entries = new Map<string, Entry>();
  constructor(private binary: string, private timeoutMs: number, private idleMs = 30000) {}
  async acquire(key: string, schema: object, signal: AbortSignal): Promise<StructuredModelSession> {
    signal.throwIfAborted();
    const schemaDigest = createHash('sha256').update(JSON.stringify(schema)).digest('hex');
    let entry = this.entries.get(key);
    if (entry?.busy) throw new Error('Task model conversation already leased');
    if (entry && entry.schema !== schemaDigest) { await this.close(key); entry = undefined; }
    if (!entry) {
      // At most two retained conversations, matching Worker task concurrency.
      if (this.entries.size >= 2) {
        const idle = [...this.entries].find(([, value]) => !value.busy);
        if (idle) await this.close(idle[0]);
        else return openCodexModelSession(this.binary, this.timeoutMs, schema, signal);
      }
      const controller = new AbortController();
      entry = { controller, session: openCodexModelSession(this.binary, this.timeoutMs, schema, controller.signal), data: new SessionPromptData(), busy: false, schema: schemaDigest };
      this.entries.set(key, entry);
    }
    const current = entry;
    current.busy = true; clearTimeout(current.timer);
    const abort = () => { void this.discard(key, current); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    let session: StructuredModelSession;
    try { session = await current.session; signal.throwIfAborted(); }
    catch (error) { signal.removeEventListener('abort', abort); await this.discard(key, current); throw error; }
    let released = false, failed = false;
    return {
      packData: input => current.data.pack(input),
      run: async prompt => {
        if (released) throw new Error('Task model conversation lease closed');
        signal.throwIfAborted();
        try { const result = await session.run(prompt); signal.throwIfAborted(); return result; }
        catch (error) { failed = true; throw error; }
      },
      close: async () => {
        if (released) return; released = true;
        signal.removeEventListener('abort', abort);
        if (failed || current.controller.signal.aborted) { await this.discard(key, current); return; }
        current.busy = false;
        current.timer = setTimeout(() => { void this.discard(key, current); }, this.idleMs);
        current.timer.unref();
      },
    };
  }
  private discard(key: string, entry: Entry) {
    if (!entry.closing) {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      clearTimeout(entry.timer); entry.controller.abort();
      entry.closing = (async () => { try { await (await entry.session).close(); } catch { /* Failed startup already cleaned its process. */ } })();
    }
    return entry.closing;
  }
  async close(key?: string) {
    const entries = key === undefined ? [...this.entries] : this.entries.has(key) ? [[key, this.entries.get(key)!] as const] : [];
    for (const [id, entry] of entries) {
      if (this.entries.get(id) !== entry) continue;
      await this.discard(id, entry);
    }
  }
}
