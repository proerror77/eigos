import { AsyncLocalStorage } from 'node:async_hooks';
import { Conflict, digest } from '../core/identity.js';
import { Database, type Sql } from './database.js';
import { PermissionDenied, type Requirement } from './access.js';
import type { Objects } from './objects.js';
import { ActionWriteBudgets } from './provider-budgets.js';

type Reader = Pick<Objects, 'access' | 'read'>;

const observing = new AsyncLocalStorage<boolean>();
/** Observation Actions may reconcile an existing operation, but cannot claim a new supplier mutation. */
export function withoutExternalDispatch<T>(operation:()=>Promise<T>):Promise<T>{
  return observing.run(true,operation);
}
export class UnknownExternalOperation extends Conflict {}
/** Provider mutations are recorded before dispatch. A lost response is an
 * unresolved original operation, never permission to submit another order. */
export class ExternalOperations {
  private readonly writeBudgets: ActionWriteBudgets;
  constructor(private readonly db: Database) {
    this.writeBudgets = new ActionWriteBudgets(db);
  }
  async inspect(owner: string, key: string, client?: Sql) {
    const row = (
      await this.db.query(
        `SELECT state,created_at,updated_at FROM ${this.db.schema}.external_operations WHERE owner=$1 AND operation_key=$2`,
        [owner, key], client,
      )
    ).rows[0];
    return row ? { state: row.state, createdAt: row.created_at, updatedAt: row.updated_at } : null;
  }
  private async original(owner: string, key: string, scope: unknown, reader?: Reader) {
    const row = (
      await this.db.query(`SELECT * FROM ${this.db.schema}.external_operations WHERE owner=$1 AND operation_key=$2`, [
        owner,
        key,
      ])
    ).rows[0];
    if (!row) return;
    if (row.scope_digest !== digest(scope)) throw new Conflict('External operation key is bound to different input');
    const requirements = row.requirements as Requirement[];
    if (!Array.isArray(requirements))
      throw new PermissionDenied('Original operation permission evidence is unavailable');
    if (requirements.length) {
      if (!reader || reader.access.principal.owner !== owner || !(await reader.access.canReturn(requirements)))
        throw new PermissionDenied('Original operation data permissions changed');
      for (const requirement of requirements)
        reader.access.require(requirement.ontology, requirement.permission, requirement.resource, true);
      const rows = new Map(
        requirements.flatMap((requirement) =>
          requirement.row
            ? [
                [
                  JSON.stringify([requirement.row.type, requirement.row.id]),
                  { type: requirement.row.type, id: requirement.row.id },
                ] as const,
              ]
            : [],
        ),
      );
      for (const ref of rows.values()) await reader.read(ref);
    }
    return row;
  }
  async recover<T>(owner: string, key: string, scope: unknown, reader?: Reader): Promise<T | undefined> {
    const row = await this.original(owner, key, scope, reader);
    if (!row) return;
    if (row.state !== 'confirmed')
      throw new UnknownExternalOperation(
        'The original external operation may have been dispatched; reconcile it before any further submission',
      );
    return row.result as T;
  }
  /** Promote an existing dispatch only with independent evidence for the original request. */
  async reconcile<T>(
    owner: string,
    key: string,
    scope: unknown,
    guard: (client: Sql) => Promise<void>,
    readback: () => Promise<T | undefined>,
    reader?: Reader,
  ): Promise<T | undefined> {
    const row = await this.original(owner, key, scope, reader);
    if (!row) return;
    if (row.state === 'confirmed') return row.result as T;
    const result = await readback();
    if (result === undefined) return;
    const updated = await this.db.transaction(async client => {
      await guard(client);
      return this.db.query(
        `UPDATE ${this.db.schema}.external_operations SET state='confirmed',result=$3,updated_at=now()
          WHERE owner=$1 AND operation_key=$2 AND scope_digest=$4 AND state IN ('dispatched','unknown')
          RETURNING result`,
        [owner, key, result, digest(scope)], client,
      );
    });
    return updated.rowCount ? result : this.recover<T>(owner, key, scope, reader);
  }
  async run<T>(
    owner: string,
    key: string,
    scope: unknown,
    guard: (client: Sql) => Promise<void>,
    invoke: () => Promise<T>,
    reader?: Reader,
    origin?: { requestId?: string; taskId?: string },
  ): Promise<T> {
    const previous = await this.recover<T>(owner, key, scope, reader);
    if (previous !== undefined) return previous;
    await this.db.transaction(async (client) => {
      await guard(client);
      await this.claimDispatch(client, owner, key, scope, reader, origin);
    });
    try {
      const result = await invoke();
      // Preserve provider success even if task cancellation or a later graph
      // commit fails. Recovery can project the same receipt without dispatch.
      const updated = await this.db.query(
        `UPDATE ${this.db.schema}.external_operations SET state='confirmed',result=$3,updated_at=now()
          WHERE owner=$1 AND operation_key=$2 AND scope_digest=$4 AND state='dispatched' RETURNING result`,
        [owner, key, result, digest(scope)],
      );
      if (updated.rowCount) return result;
      const recovered = await this.recover<T>(owner, key, scope, reader);
      if (recovered === undefined) throw new UnknownExternalOperation('The original dispatch record is unavailable');
      return recovered;
    } catch (error) {
      await this.db
        .query(
          `UPDATE ${this.db.schema}.external_operations SET state='unknown',updated_at=now() WHERE owner=$1 AND operation_key=$2 AND state='dispatched'`,
          [owner, key],
        )
        .catch(() => {});
      throw new UnknownExternalOperation(
        'The original external operation has an unresolved result; automatic resubmission is disabled',
        { cause: error },
      );
    }
  }
  /** Claim an external operation in the same transaction that makes it dispatchable. */
  async claimDispatch(
    client: Sql, owner: string, key: string, scope: unknown,
    reader?: Reader, origin?: { requestId?: string; taskId?: string },
  ) {
    if(observing.getStore())throw new PermissionDenied('An observation cannot dispatch a supplier mutation');
    const claimed = await this.db.query(
      `INSERT INTO ${this.db.schema}.external_operations(owner,operation_key,scope_digest,state,requirements,request_id,task_id)
        VALUES($1,$2,$3,'dispatched',$4,$5,$6) ON CONFLICT DO NOTHING RETURNING operation_key`,
      [owner, key, digest(scope), JSON.stringify(reader?.access.dataRequirements() ?? []), origin?.requestId ?? null, origin?.taskId ?? null],
      client,
    );
    if (!claimed.rowCount)
      throw new UnknownExternalOperation('Original external operation already exists; inspect it without resubmitting');
    // The claim and the charge commit together. A replay, permission failure or exhausted burst cannot spend a token.
    await this.writeBudgets.take(owner, client);
  }
}
