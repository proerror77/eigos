import type { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError, ownerKey, type Principal } from '../core/domain.js';
import { objectRefSchema, type ObjectRef } from '../ontology/model.js';
import { ontologyCursorSchema, type ObjectView, type ReadBudget } from '../ontology/object-store.js';
import type { StagedKernelBuilder } from '../ontology/seed-definition.js';
import { SecurityError } from '../security/errors.js';
import { assertReviewedModel } from '../security/model-review.js';
import { currentKernelImplementation } from '../ontology/definition-store.js';
import { stagedKernelComponents } from '../ontology/seed-definition.js';
import { projectionFields } from '../security/projections.js';
import type { SecurityEnvelope } from '../security/envelope.js';
import { secureQuerySchema } from '../security/view-contracts.js';
import { PostgresProjectionGraph } from './projection-graph.js';
import { postgresBusinessSchema, postgresBusinessToken, postgresConstrainReadDeadline } from './runtime-transaction.js';
import { withPostgresTaskReadGrant, postgresTaskReadOntology, postgresTaskQuerySelection, postgresTaskResourceViewValidUntil } from './task-read-access.js';
import type { PostgresTaskReadAuthorization, PostgresDerivedRead } from './task-output.js';

const hidden = (error: unknown) => error instanceof SecurityError && ['AUTHORIZATION_REQUIRED', 'INSUFFICIENT_ACCESS', 'OUTPUT_NOT_ALLOWED'].includes(error.reason)
  || error instanceof DomainError && error.code === 'NOT_FOUND';

export interface PostgresOntologyCursor{id:string;context:string;expiresAt:number;body:string}

/** Raw selection rows in one explicitly immutable planning callback. This
 * carries no object/field/source/output permission; every logical query still
 * runs its normal checks. A pooled client cannot lend this to a new transaction. */
export class PostgresPlanningReadRows {
  private readonly token: object;
  private closed = false;
  private bytes = 0;
  private readonly rows = new Map<string, { value: unknown[]; bytes: number }>();
  constructor(private readonly client: Client) { this.token = postgresBusinessToken(client); }
  private active(client: Client) {
    if (this.closed || client !== this.client || postgresBusinessToken(client) !== this.token) throw new SecurityError('AUTHORIZATION_REQUIRED');
  }
  async read<T>(client: Client, identity: unknown, load: () => Promise<T[]>): Promise<T[]> {
    this.active(client); const key = digest(identity), cached = this.rows.get(key);
    if (cached) return structuredClone(cached.value) as T[];
    const value = await load(); this.active(client);
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes <= 4194304) {
      while (this.rows.size >= 128 || this.bytes + bytes > 8388608) {
        const first = this.rows.keys().next().value; if (first === undefined) break;
        this.bytes -= this.rows.get(first)!.bytes; this.rows.delete(first);
      }
      this.rows.set(key, { value: structuredClone(value), bytes }); this.bytes += bytes;
    }
    return value;
  }
  close() { this.closed = true; this.rows.clear(); this.bytes = 0; }
}
/** Internal checked query on the caller's existing read snapshot. Calculation
 * cursors stay in that callback; public cursors are persisted after it closes. */
export async function postgresQueryAuthorizedObjects(client:Client,principal:Principal,input:z.output<typeof secureQuerySchema>,
  policyDigest:string,auth:PostgresTaskReadAuthorization,builder?:StagedKernelBuilder,
  options:{budget?:ReadBudget;readScope?:string;cursors?:Map<string,PostgresOntologyCursor>;graph?:PostgresProjectionGraph;readRows?:PostgresPlanningReadRows;onRead?:(envelope:SecurityEnvelope)=>void;derive?:(functionId:string,ref:ObjectRef,budget:ReadBudget)=>Promise<PostgresDerivedRead>}={}){
  const p=structuredClone(principal),args=secureQuerySchema.parse(input),owner=ownerKey(p);
  let cursorWrite:PostgresOntologyCursor|undefined;
  const budget=options.budget??{remaining:1000};
    const admission = await withPostgresTaskReadGrant(client,p,args.taskId,policyDigest,async admitted=>admitted);
    if (!admission.grant.operations.includes(admission.actor.actorKind==='worker'?'task.process':'task.query')) throw new SecurityError('AUTHORIZATION_REQUIRED');
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
      options.onRead?.(structuredClone(result.envelope));
      return result.object;
    };
    if ('as' in query && query.as) await requireResource('interface', query.as);
    let target: string;
    let relationship: { from:ObjectRef; type:string; side:'from'|'to'; other:'from'|'to' } | undefined;
    if ('object' in query) {
      await checkedRead(query.object,[model.object(query.object.type).primaryKey,model.object(query.object.type).titleKey]);
      target = query.as ?? query.object.type;
    } else if ('from' in query) {
      await checkedRead(query.from,[model.object(query.from.type).primaryKey,model.object(query.from.type).titleKey]);
      const nav = model.navigation(query.from.type, query.link, query.as);
      await requireResource('linkType', nav.link.id);
      target = nav.viewType ?? nav.other.type;
      const side=nav.direction==='forward'?'from':'to';
      relationship={from:query.from,type:nav.link.id,side,other:side==='from'?'to':'from'};
    } else target = query.type;
    await requireResource(model.isInterface(target) ? 'interface' : 'objectType', target);
    const selection=await postgresTaskQuerySelection(client,p,args.taskId,policyDigest);
    const types = new Set(model.concreteTypes(target)), visible: ObjectRef[] = [];
    let candidates=selection.rows;
    if(relationship){
      const {from,type,side,other}=relationship,scoped=ontology.ref.ontologyId!=='eigos.business';
      // Narrow the already admitted inventory, without reading object bodies or
      // granting access. queryVisible still validates every stored definition
      // and relationship; checkedRead retains each candidate's full boundary.
      const values=[JSON.stringify(selection.rows),owner,type,from.type,from.id,...(scoped?[ontology.ref.ontologyId]:[])];
      const load=async()=>(await client.query<{type:string;object_id:string}>(`SELECT selected.type,selected.object_id
        FROM jsonb_to_recordset($1::jsonb) AS selected(type text,object_id text)
        WHERE EXISTS(SELECT 1 FROM ${q}.ontology_${scoped?'scoped_':''}links l
          WHERE l.owner=$2 AND l.type=$3 AND l.${side}_type=$4 AND l.${side}_id=$5
            AND l.${other}_type=selected.type AND l.${other}_id=selected.object_id${scoped?' AND l.ontology_id=$6':''})`,
      values)).rows;
      candidates=options.readRows?await options.readRows.read(client,['related-candidates',q,side,other,values],load):await load();
    }
    for (const row of candidates) {
      if (!types.has(String(row.type)) || 'object' in query && (row.type !== query.object.type || row.object_id !== query.object.id)) continue;
      const ref = objectRefSchema.parse({ type: row.type, id: row.object_id });
      const definition = model.object(ref.type), fields = [...new Set([definition.primaryKey, definition.titleKey,
        ...query.where.map(filter => model.propertyName(ref.type, target, filter.property))])];
      try { await checkedRead(ref, fields); visible.push(ref); }
      catch (error) { if (!hidden(error)) throw error; }
    }
    // Match SQLite's opaque, installation/grant/policy-bound cursor contract.
    // The public token never reveals owner, model digest or hidden row position.
    const revision=selection.revision;
    const queryDigest = digest({ ...query, cursor: undefined,...(options.readScope?{readScope:options.readScope}:{}) }), context = digest([admission.actor.installationId,
      admission.actor.authEpoch, admission.grant.id, admission.grant.revision, admission.policyRevision, queryDigest, revision]);
    let after: ObjectRef | undefined;
    if (query.cursor) {
      const local=options.cursors?.get(query.cursor);
      if(local){if(local.context!==context||local.expiresAt<=Date.now())throw new SecurityError('POLICY_CHANGED');after=objectRefSchema.parse(JSON.parse(local.body));}
      else{
      const cursor = await client.query(`SELECT CASE WHEN octet_length(body)<=1024 THEN body END AS body
        FROM ${q}.security_cursors WHERE id=$1 AND context=$2 AND expires_at>$3 LIMIT 2`, [query.cursor, context, Date.now()]);
      if (cursor.rowCount !== 1 || typeof cursor.rows[0].body !== 'string') throw new SecurityError('POLICY_CHANGED');
      after = objectRefSchema.parse(JSON.parse(cursor.rows[0].body));
      }
    }
    const graph = options.graph??await PostgresProjectionGraph.create(client,owner,ontology.ref,builder,{readOnly:true});
    if(digest(graph.releaseRef)!==digest(ontology.ref))throw new SecurityError('POLICY_CHANGED');
    const result = await graph.queryVisible(owner, { ...query, cursor: undefined }, budget, context, {
      refs: visible, revision, after,
      properties: type => ({ ...model.properties(type), ...projectionFields(type) }),
      async project(ref,view,selected):Promise<ObjectView>{
        const value=await auth.readView(ref,view,selected,options.derive?(functionId,object)=>options.derive!(functionId,object,budget):undefined);await auth.authorizeEvidence(value.envelope);
        options.onRead?.(structuredClone(value.envelope));return value.object;
      },
    });
    let cursor: string | undefined;
    if (result.page.cursor) {
      const internal = ontologyCursorSchema.parse(JSON.parse(Buffer.from(result.page.cursor, 'base64url').toString()));
      cursor = randomUUID();
      cursorWrite = { id: cursor, context, expiresAt: Math.min(Date.now() + 300000, admission.validUntil), body: JSON.stringify(internal.last) };
    }
    if(cursorWrite)options.cursors?.set(cursorWrite.id,cursorWrite);
    return {query:{...result,page:{...result.page,cursor}},requestRevision:admission.grant.requestRevision,cursorWrite};
}
