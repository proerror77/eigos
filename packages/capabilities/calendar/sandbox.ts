import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from '../../core/delegation.js';
import { DomainError } from '../../core/domain.js';
import { AgentOperationRejected, type AgentActionContext, type AgentActionResult } from '../../core/agent-program.js';
import { calendarInputSchema, calendarEntry, calendarDataSchema, calendarResultSchema, type CalendarData } from '../../ontology/calendar.js';
import type { CalendarSource } from './program.js';

export interface CalendarSandboxOptions { databasePath: string; owner: string; accountRef: string; calendarId: string }
/** An isolated, durable synthetic system of record. Construction is metadata
 * only, so Gateway capability discovery never opens or mutates its database. */
export class CalendarSandboxSource implements CalendarSource {
  readonly kind = 'synthetic' as const;
  readonly environment = 'sandbox' as const;
  readonly identity: string; readonly configurationDigest: string; readonly accountRef: string; readonly calendarId: string;
  private db?: DatabaseSync;
  constructor(readonly options: CalendarSandboxOptions) {
    if (options.databasePath !== ':memory:' && !isAbsolute(options.databasePath) || !options.owner || !options.accountRef || !options.calendarId) throw new DomainError('INVALID_INPUT', 'Synthetic calendar requires a separate absolute database and explicit owner/account');
    this.accountRef = options.accountRef; this.calendarId = options.calendarId; this.identity = `calendar-sandbox:${digest({ account: options.accountRef, calendar: options.calendarId }).slice(0, 24)}`;
    this.configurationDigest = digest({ options, schema: 'calendar-sandbox-1' });
  }
  permitted(owner: string) { return owner === this.options.owner; }
  private database() {
    if (!this.db) {
      if (this.options.databasePath !== ':memory:') mkdirSync(dirname(this.options.databasePath), { recursive: true, mode: 0o700 });
      this.db = new DatabaseSync(this.options.databasePath);
      this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS calendar_items(owner TEXT NOT NULL,event_key TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(owner,event_key));
        CREATE TABLE IF NOT EXISTS calendar_operations(owner TEXT NOT NULL,operation_key TEXT NOT NULL,input_digest TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(owner,operation_key));`);
    }
    return this.db;
  }
  close() { this.db?.close(); this.db = undefined; }
  async call(ctx: AgentActionContext, action: string, input: Record<string, unknown>, signal: AbortSignal, recovery = false): Promise<AgentActionResult | undefined> {
    if (!this.permitted(ctx.owner) || ctx.request.executionEnvironment !== 'sandbox' || !ctx.operationKey) throw new DomainError('FORBIDDEN', 'Synthetic calendar is outside this owned sandbox task');
    if (!['ReadCalendarEntry', 'CreateCalendarEntrySandbox', 'UpdateCalendarEntrySandbox'].includes(action)) throw new DomainError('FORBIDDEN', 'Calendar operation is not supported');
    signal.throwIfAborted(); const db = this.database(), now = new Date().toISOString();
    let data: CalendarData;
    if (recovery) {
      const operation = db.prepare('SELECT body FROM calendar_operations WHERE owner=? AND operation_key=?').get(ctx.owner, ctx.operationKey);
      if (!operation) return;
      data = calendarDataSchema.parse({ ...JSON.parse(String(operation.body)), observedAt: now, independentRead: false });
    } else {
      const desired = calendarInputSchema.parse(input.desired), current = db.prepare('SELECT * FROM calendar_items WHERE owner=? AND event_key=?').get(ctx.owner, desired.eventKey);
      if (action === 'ReadCalendarEntry') {
        const entry = current ? JSON.parse(String(current.body)) : null;
        data = calendarDataSchema.parse({ accountRef: this.accountRef, calendarId: this.calendarId, eventKey: desired.eventKey, providerEventId: current ? String(current.id) : null,
          providerVersion: current ? `version-${current.version}` : null, state: current ? 'present' : 'missing', entry, independentRead: true, observedAt: now });
        if (input.originalEventId && data.providerEventId && data.providerEventId !== input.originalEventId) throw new DomainError('CONFLICT', 'Synthetic source item was substituted');
      } else {
        if (!ctx.assertDispatchAllowed) throw new DomainError('FORBIDDEN', 'Calendar write has no current plan grant');
        ctx.assertDispatchAllowed(); signal.throwIfAborted();
        const fingerprint = digest({ action, input }), previous = calendarDataSchema.parse(input.previous);
        db.exec('BEGIN IMMEDIATE');
        try {
          const oldOperation = db.prepare('SELECT * FROM calendar_operations WHERE owner=? AND operation_key=?').get(ctx.owner, ctx.operationKey);
          if (oldOperation) {
            if (oldOperation.input_digest !== fingerprint) throw new DomainError('CONFLICT', 'Original calendar operation input changed');
            data = calendarDataSchema.parse({ ...JSON.parse(String(oldOperation.body)), observedAt: now });
          } else {
            const item = db.prepare('SELECT * FROM calendar_items WHERE owner=? AND event_key=?').get(ctx.owner, desired.eventKey);
            if (action === 'CreateCalendarEntrySandbox' ? !!item || previous.state !== 'missing' : !item || previous.providerEventId !== item.id || previous.providerVersion !== `version-${item.version}`) {
              throw new AgentOperationRejected('The original calendar item or its conditional version changed; independently read it before another decision', [digest({ item: item?.id ?? null, version: item?.version ?? null })]);
            }
            const id = item ? String(item.id) : randomUUID(), version = Number(item?.version ?? 0) + 1;
            db.prepare('INSERT INTO calendar_items VALUES(?,?,?,?,?) ON CONFLICT(owner,event_key) DO UPDATE SET version=excluded.version,body=excluded.body').run(ctx.owner, desired.eventKey, id, version, JSON.stringify(calendarEntry(desired)));
            data = calendarDataSchema.parse({ accountRef: this.accountRef, calendarId: this.calendarId, eventKey: desired.eventKey, providerEventId: id, providerVersion: `version-${version}`, state: 'present', entry: calendarEntry(desired), independentRead: false, observedAt: now });
            db.prepare('INSERT INTO calendar_operations VALUES(?,?,?,?)').run(ctx.owner, ctx.operationKey, fingerprint, JSON.stringify(data));
          }
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      }
    }
    const expiresAt = new Date(Date.now() + 300_000).toISOString(), payload = { data, expiresAt };
    const receipt = { id: digest(randomUUID()), ownerDigest: digest(ctx.owner), requestId: ctx.request.id, requestRevision: ctx.request.revision, action,
      planId: ctx.planId, intentId: ctx.intentId, attemptId: ctx.attemptId, modelRunId: ctx.modelRunId, operationKey: ctx.operationKey, readbackSequence: 0,
      sourceIdentity: this.identity, method: recovery || action === 'ReadCalendarEntry' ? 'GET' as const : 'POST' as const, path: '/synthetic-calendar', status: 200 as const,
      responseSha256: digest(payload), payloadDigest: digest(payload), signature: digest({ synthetic: true, payload }), startedAt: now, receivedAt: new Date().toISOString() };
    const result = calendarResultSchema.parse({ ...payload, receipt, evidenceLevel: 'synthetic' });
    return { value: result, evidenceRefs: [receipt.id] };
  }
}
