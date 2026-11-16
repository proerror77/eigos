import { z } from 'zod';
import { Conflict, NotFound, digest } from '../core/identity.js';
import { ontologyName } from '../ontology/schema.js';
import type { Access } from './access.js';
import type { Database } from './database.js';
import type { Metadata } from './metadata.js';

const releaseId = z.string().regex(/^[0-9a-f]{64}$/);
const cursorSchema = z.strictObject({
  scope: releaseId,
  appliedAt: z.iso.datetime(),
  requestId: z.string(),
});
export const actionLogSchema = z.strictObject({
  action: ontologyName.optional(),
  release: releaseId.optional(),
  cursor: z.string().max(1_024).optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
export type ActionLogInput = z.input<typeof actionLogSchema>;
export type ActionLogEntry = { requestId: string; action: string; appliedAt: string; executorKind: string | null };

export async function listActionLog(db: Database, metadata: Metadata, access: Access, ontology: string, input: ActionLogInput) {
  const { action, cursor, limit, release } = actionLogSchema.parse(input);
  const owner = access.principal.owner;
  if (release && !(await db.query(`SELECT 1 FROM ${db.schema}.releases
    WHERE digest=$1 AND body->>'id'=$2 AND state IN ('active','retired')`, [release, ontology])).rowCount)
    throw new NotFound('Action log publication is unavailable');
  const model = release ? await metadata.get(release) : await metadata.active(ontology);
  const names = [...model.actions.values()].filter(definition =>
    (!action || action === definition.apiName) && access.canDefine(model, 'action', definition.apiName) &&
    access.canSeeModelData(definition.classification));
  const scope = digest([owner, model.release, action ?? null]);
  let after: z.infer<typeof cursorSchema> | undefined;
  if (cursor) {
    try {
      after = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    } catch {
      throw new Conflict('Action log cursor is invalid');
    }
    if (after.scope !== scope) throw new Conflict('Action log cursor belongs to another selection');
  }
  const rows = await db.query<ActionLogEntry>(`SELECT request_id AS "requestId", action,
    to_char(applied_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "appliedAt", executor_kind AS "executorKind"
    FROM ${db.schema}.actions WHERE owner=$1 AND release=$2 AND action=ANY($3::text[])
      AND ($4::timestamptz IS NULL OR (applied_at,request_id) < ($4::timestamptz,$5::text))
    ORDER BY applied_at DESC,request_id DESC LIMIT $6`,
  [owner, model.release, names.map(item => item.apiName), after?.appliedAt ?? null, after?.requestId ?? null, limit + 1]);
  const items = rows.rows.slice(0, limit);
  for (const name of new Set(items.map(item => item.action))) {
    access.definition(model, 'action', name, true);
    access.useModelData(model.action(name).classification);
  }
  const last = items.at(-1);
  return { release: model.release, items, ...(last && rows.rows.length > limit
    ? { cursor: Buffer.from(JSON.stringify({ scope, appliedAt: last.appliedAt, requestId: last.requestId })).toString('base64url') }
    : {}) };
}
