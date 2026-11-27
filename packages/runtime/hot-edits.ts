import { AsyncLocalStorage } from 'node:async_hooks';
import { recordOperationEvent } from '../core/operation-timing.js';
import type { ObjectRef } from '../ontology/schema.js';
import type { Sql } from './database.js';

export type PriorEdits = Map<string, { digest: string; result: ObjectRef }>;
export type HotEdit = {
  requestId: string;
  signal: AbortSignal;
  fields: string[];
  revision: number;
  verify(client: Sql): Promise<void>;
  run(client?: Sql, prior?: PriorEdits): Promise<ObjectRef>;
};
type Pending = HotEdit & { resolve(value: ObjectRef): void; reject(error: unknown): void; begin(): void };
type Batch = (items: readonly HotEdit[]) => Promise<ObjectRef[]>;

/** One in-flight cold edit. Concurrent edits of its object queue up for one bounded commit. */
export class HotEdits {
  private readonly lanes = new Map<string, Pending[]>();

  submit(key: string, edit: HotEdit, batch: Batch): Promise<ObjectRef> {
    const current = this.lanes.get(key);
    if (current) {
      const context = AsyncLocalStorage.snapshot();
      return new Promise((resolve, reject) => {
        edit.signal.throwIfAborted();
        const abort = () => {
          const index = current.indexOf(item);
          if (index >= 0) current.splice(index,1);
          reject(edit.signal.reason);
        };
        const item: Pending = { ...edit, resolve, reject, verify: client => context(edit.verify, client), run: (client, prior) => context(edit.run, client, prior),
          begin: () => edit.signal.removeEventListener('abort',abort) };
        current.push(item);
        edit.signal.addEventListener('abort',abort,{once:true});
      });
    }
    const lane: Pending[] = [];
    this.lanes.set(key, lane);
    return edit.run().finally(() => { void this.drain(key, lane, batch); });
  }

  private async drain(key: string, lane: Pending[], batch: Batch) {
    while (lane.length) {
      const group = [lane.shift()!], fields = new Set(group[0]!.fields);
      while (lane.length && group.length < 32) {
        const next = lane[0]!;
        if (next.fields.some(field => fields.has(field)) && next.revision !== group.at(-1)!.revision + 1) break;
        group.push(lane.shift()!);
        for (const field of next.fields) fields.add(field);
      }
      for (const item of group) item.begin();
      if (group.length > 1) {
        try {
          const results = await batch(group);
          group.forEach((item, index) => item.resolve(results[index]!));
          recordOperationEvent('hot_edit_batch', { requests: group.length });
          continue;
        } catch {
          // The transaction rolled back. Recheck each original request and deliver its own outcome.
        }
      }
      for (const item of group) {
        try { item.resolve(await item.run()); } catch (error) { item.reject(error); }
      }
    }
    this.lanes.delete(key);
  }
}
