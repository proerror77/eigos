import type { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError, ownerKey, type Principal } from '../core/domain.js';
import { objectRefSchema, type ObjectRef } from '../ontology/model.js';
import { ontologyCursorSchema, type ObjectView } from '../ontology/object-store.js';
import type { StagedKernelBuilder } from '../ontology/seed-definition.js';
import { SecurityError } from '../security/errors.js';
import { assertReviewedModel } from '../security/model-review.js';
import { currentKernelImplementation } from '../ontology/definition-store.js';
import { stagedKernelComponents } from '../ontology/seed-definition.js';
import { projectionFields } from '../security/projections.js';
import { secureQuerySchema } from '../security/view-contracts.js';
import { PostgresProjectionGraph } from './projection-graph.js';
import { postgresBusinessSchema, postgresConstrainReadDeadline } from './runtime-transaction.js';
import { postgresTaskReadGrant, postgresTaskReadOntology, postgresTaskResourceViewValidUntil } from './task-read-access.js';
import { withPostgresTaskReadAuthorization } from './task-output.js';

const hidden = (error: unknown) => error instanceof SecurityError && ['AUTHORIZATION_REQUIRED', 'INSUFFICIENT_ACCESS', 'OUTPUT_NOT_ALLOWED'].includes(error.reason)
  || error instanceof DomainError && error.code === 'NOT_FOUND';

/** Public task query. Establish the complete task boundary and current input
 * visibility before applying data predicates or counting a page. Raw graph
 * storage is never exposed; every returned field passes the output boundary. */
export async function postgresQueryOntology(client: Client, principal: Principal, input: unknown,
  policyDigest: string, builder?: StagedKernelBuilder) {
  const p = structuredClone(principal), args = secureQuerySchema.parse(input), owner = ownerKey(p);
  let cursorWrite: { id: string; context: string; expiresAt: number; body: string } | undefined;
  const result = await withPostgresTaskReadAuthorization(client, p, args.taskId, policyDigest, async auth => {
    const admission = await postgresTaskReadGrant(client, p, args.taskId, policyDigest);
    if (!admission.grant.operations.includes('task.query')) throw new SecurityError('AUTHORIZATION_REQUIRED');
    if (args.expectedRequestRevision !== undefined && args.expectedRequestRevision !== admission.grant.requestRevision) throw new SecurityError('POLICY_CHANGED');
    const ontology = await postgresTaskReadOntology(client, p, args.taskId, policyDigest, builder), model = ontology.model;
    const current = builder === undefined ? currentKernelImplementation() : stagedKernelComponents(builder).model;
    assertReviewedModel(current, model);
    const q = `"${postgresBusinessSchema(client)}"`, query = args.query;
    const requireResource = async (kind: string, id: string) => {
      const until = await postgresTaskResourceViewValidUntil(client, p, args.taskId, policyDigest, kind, id, builder);
      if (until <= Date.now()) throw new SecurityError('AUTHORIZATION_REQUIRED');
      postgresConstrainReadDeadline(client, until);
    };
    const checkedRead = async (ref: ObjectRef, fields?: string[]) => {
      const result = await auth.readObject(ref, fields);
      await auth.authorizeEvidence(result.envelope);
      return result.object;
    };
    if ('as' in query && query.as) await requireResource('interface', query.as);
    let target: string;
    if ('object' in query) {
      await checkedRead(query.object);
      target = query.as ?? query.object.type;
    } else if ('from' in query) {
      await checkedRead(query.from);
      const nav = model.navigation(query.from.type, query.link, query.as);
      await requireResource('linkType', nav.link.id);
      target = nav.viewType ?? nav.other.type;
    } else target = query.type;
    await requireResource(model.isInterface(target) ? 'interface' : 'objectType', target);
    const rows = await client.query(`SELECT DISTINCT b.type,b.object_id FROM ${q}.security_bindings b
      JOIN ${q}.security_grants issued ON issued.id=b.grant_id
      WHERE b.owner=$1 AND b.task_id=$2 AND b.request_revision=$3
        AND issued.installation_id=$4 AND issued.kind='task_data' LIMIT 2001`,
    [owner, args.taskId, admission.grant.requestRevision, admission.actor.installationId]);
    if (rows.rows.length > 2000) throw new DomainError('CONFLICT', 'Task object boundary exceeds the supported query budget');
    const types = new Set(model.concreteTypes(target)), visible: ObjectRef[] = [];
    for (const row of rows.rows) {
      if (!types.has(String(row.type)) || 'object' in query && (row.type !== query.object.type || row.object_id !== query.object.id)) continue;
      const ref = objectRefSchema.parse({ type: row.type, id: row.object_id });
      const definition = model.object(ref.type), fields = [...new Set([definition.primaryKey, definition.titleKey,
        ...query.where.map(filter => model.propertyName(ref.type, target, filter.property))])];
      try { await checkedRead(ref, fields); visible.push(ref); }
      catch (error) { if (!hidden(error)) throw error; }
    }
    // Match SQLite's opaque, installation/grant/policy-bound cursor contract.
    // The public token never reveals owner, model digest or hidden row position.
    const bindings = await client.query(`SELECT type,object_id,object_revision FROM ${q}.security_bindings
      WHERE grant_id=$1 ORDER BY type COLLATE "C",object_id COLLATE "C"`, [admission.grant.id]);
    if (bindings.rows.length > 2000) throw new DomainError('CONFLICT', 'Task object boundary exceeds the supported query budget');
    const revision = parseInt(digest([admission.policyRevision, admission.grant.id, bindings.rows.map(row => ({
      type: row.type, object_id: row.object_id, object_revision: z.number().int().positive().safe().parse(Number(row.object_revision)),
    }))]).slice(0, 12), 16);
    const queryDigest = digest({ ...query, cursor: undefined }), context = digest([admission.actor.installationId,
      admission.actor.authEpoch, admission.grant.id, admission.grant.revision, admission.policyRevision, queryDigest, revision]);
    let after: ObjectRef | undefined;
    if (query.cursor) {
      const cursor = await client.query(`SELECT CASE WHEN octet_length(body)<=1024 THEN body END AS body
        FROM ${q}.security_cursors WHERE id=$1 AND context=$2 AND expires_at>$3 LIMIT 2`, [query.cursor, context, Date.now()]);
      if (cursor.rowCount !== 1 || typeof cursor.rows[0].body !== 'string') throw new SecurityError('POLICY_CHANGED');
      after = objectRefSchema.parse(JSON.parse(cursor.rows[0].body));
    }
    const graph = await PostgresProjectionGraph.create(client, owner, ontology.ref, builder);
    const result = await graph.queryVisible(owner, { ...query, cursor: undefined }, { remaining: 1000 }, context, {
      refs: visible, revision, after,
      properties: type => ({ ...model.properties(type), ...projectionFields(type) }),
      async project(ref, view, selected): Promise<ObjectView> {
        if (view === ref.type) return checkedRead(ref, selected);
        const names = selected ?? Object.keys(model.properties(view)).filter(name => {
          const property = model.properties(view)[name]!; return !property.restricted && !property.derived;
        });
        const actual = names.map(name => model.propertyName(ref.type, view, name));
        const object = await checkedRead(ref, selected ? actual : undefined);
        return { ...object, properties: Object.fromEntries(names.filter((_, index) => Object.hasOwn(object.properties, actual[index]!))
          .map((name, index) => [name, object.properties[actual[index]!]])) };
      },
    });
    let cursor: string | undefined;
    if (result.page.cursor) {
      const internal = ontologyCursorSchema.parse(JSON.parse(Buffer.from(result.page.cursor, 'base64url').toString()));
      cursor = randomUUID();
      cursorWrite = { id: cursor, context, expiresAt: Math.min(Date.now() + 300000, admission.validUntil), body: JSON.stringify(internal.last) };
    }
    return { version: 2, taskId: args.taskId, requestRevision: admission.grant.requestRevision,
      items: result.items.map(({ ref, revision, properties, derived }) => ({ ref, revision, properties, ...(derived ? { derived } : {}) })),
      page: { limit: result.page.limit, hasMore: result.page.hasMore, cursor } };
  }, builder);
  if (cursorWrite) {
    const q = `"${postgresBusinessSchema(client)}"`, saved = cursorWrite;
    await client.query(`DELETE FROM ${q}.security_cursors WHERE expires_at<=$1`, [Date.now()]);
    await client.query(`INSERT INTO ${q}.security_cursors(id,context,expires_at,body) VALUES($1,$2,$3,$4)`, [saved.id, saved.context, saved.expiresAt, saved.body]);
  }
  return result;
}
