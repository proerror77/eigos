import { z } from 'zod';
import { Conflict, NotFound, digest } from '../core/identity.js';
import { objectRefSchema, type ObjectRef } from '../ontology/schema.js';
import { Access } from './access.js';
import type { Database, Sql } from './database.js';
import { Objects } from './objects.js';
import type { PublishedOntology } from './metadata.js';

export const entityLookupSchema = z.strictObject({
  source: z.string().min(1).max(80),
  externalId: z.string().min(1).max(512),
});
export const bindEntitySchema = entityLookupSchema.extend({
  target: objectRefSchema,
  expectedRevision: z.number().int().min(0),
  reason: z.string().min(1).max(1000),
});
export const entityHistorySchema = entityLookupSchema.extend({
  after: z.string().regex(/^\d+$/).optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

export async function initializeEntityResolution(db: Database) {
  await db.query(`CREATE TABLE IF NOT EXISTS ${db.schema}.entity_bindings (
    ontology text NOT NULL, owner text NOT NULL, source text NOT NULL, external_id text NOT NULL,
    target_type text NOT NULL, target_id text NOT NULL, revision bigint NOT NULL,
    release text NOT NULL REFERENCES ${db.schema}.releases(digest), updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(ontology,owner,source,external_id));
    CREATE TABLE IF NOT EXISTS ${db.schema}.entity_binding_history (
      sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, ontology text NOT NULL, owner text NOT NULL,
      source text NOT NULL, external_id text NOT NULL, revision bigint NOT NULL, before_target jsonb,
      after_target jsonb NOT NULL, reason text NOT NULL, actor text NOT NULL,
      release text NOT NULL REFERENCES ${db.schema}.releases(digest), happened_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(ontology,owner,source,external_id,revision));
    CREATE INDEX IF NOT EXISTS entity_binding_history_lookup ON ${db.schema}.entity_binding_history(ontology,owner,source,external_id,sequence);`);
}

function authorize(access: Access, model: PublishedOntology, source: string, write = false) {
  access.definition(model, 'datasource', source);
  const definition = model.sources.get(source);
  if (!definition) throw new Conflict('A published data source is required for entity resolution');
  const provider = model.functions.get(definition.function)?.source;
  if (provider) access.source(model, provider);
  if (write) access.require(model.document.id, 'ingest_source', `${model.document.id}/datasource/${source}`);
  access.read(model, definition.objectType);
  return definition;
}

export class EntityResolution {
  constructor(private readonly db: Database) {}
  private async binding(
    access: Access,
    model: PublishedOntology,
    source: string,
    externalId: string,
    client: Sql = this.db.pool,
  ) {
    return (
      await this.db.query(
        `SELECT target_type,target_id,revision,release FROM ${this.db.schema}.entity_bindings
      WHERE ontology=$1 AND owner=$2 AND source=$3 AND external_id=$4`,
        [model.document.id, access.principal.owner, source, externalId],
        client,
      )
    ).rows[0];
  }
  private async selected(graph: Objects, source: string, externalId: string, fallbackId?: string) {
    const mapping = authorize(graph.access, graph.model, source);
    const row = await this.binding(graph.access, graph.model, source, externalId, graph.client);
    if (!row)
      return {
        ref: objectRefSchema.parse({
          type: mapping.objectType,
          id: fallbackId ?? digest([graph.model.document.id, graph.owner, source, externalId]),
        }),
        revision: 0,
        bound: false,
      };
    if (row.target_type !== mapping.objectType)
      throw new Conflict('Entity binding type differs from the published source mapping');
    const ref = { type: String(row.target_type), id: String(row.target_id) };
    await graph.read(ref);
    return { ref, revision: Number(row.revision), bound: true };
  }
  async lookup(access: Access, model: PublishedOntology, raw: unknown) {
    const input = entityLookupSchema.parse(raw);
    const result = await this.selected(new Objects(this.db, model, access), input.source, input.externalId);
    await access.refresh();
    if (!(await access.canReturn(access.dataRequirements())))
      throw new Error('Entity binding permissions changed');
    return result;
  }
  /** Source adapters call inside their write transaction, before mapping a source row's primary key. */
  async resolve(graph: Objects, source: string, externalId: string, fallbackId?: string): Promise<ObjectRef> {
    entityLookupSchema.parse({ source, externalId });
    if (graph.client === this.db.pool || graph.model.scenario)
      throw new Conflict('Entity resolution for ingestion requires a live object transaction');
    await graph.lockWrites();
    return (await this.selected(graph, source, externalId, fallbackId)).ref;
  }
  async bind(access: Access, model: PublishedOntology, raw: unknown) {
    const input = bindEntitySchema.parse(raw);
    if (model.scenario) throw new Conflict('Entity bindings belong to the live Ontology');
    const mapping = authorize(access, model, input.source, true);
    if (input.target.type !== mapping.objectType)
      throw new Conflict('Canonical object type must match the source mapping');
    return this.db.transaction(async (client) => {
      const graph = new Objects(this.db, model, access, client);
      await graph.lockWrites();
      await access.refresh(client);
      await graph.read(input.target);
      const previous = await this.binding(access, model, input.source, input.externalId, client);
      const before = previous ? { type: String(previous.target_type), id: String(previous.target_id) } : null;
      if (previous)
        await graph.read(before!).catch((error) => {
          if (!(error instanceof NotFound)) throw error;
        });
      const revision = Number(previous?.revision ?? 0);
      if (revision !== input.expectedRevision) throw new Conflict('Entity binding revision changed');
      if (before && digest(before) === digest(input.target))
        return { ref: input.target, revision, bound: true };
      await this.db.query(
        `INSERT INTO ${this.db.schema}.entity_bindings(ontology,owner,source,external_id,target_type,target_id,revision,release)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(ontology,owner,source,external_id) DO UPDATE SET
        target_type=excluded.target_type,target_id=excluded.target_id,revision=excluded.revision,release=excluded.release,updated_at=now()`,
        [
          model.document.id,
          access.principal.owner,
          input.source,
          input.externalId,
          input.target.type,
          input.target.id,
          revision + 1,
          model.release,
        ],
        client,
      );
      await this.db.query(
        `INSERT INTO ${this.db.schema}.entity_binding_history(ontology,owner,source,external_id,revision,before_target,after_target,reason,actor,release)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          model.document.id,
          access.principal.owner,
          input.source,
          input.externalId,
          revision + 1,
          before,
          input.target,
          input.reason,
          access.principal.owner,
          model.release,
        ],
        client,
      );
      await access.refresh(client);
      if (!(await access.canReturn(access.dataRequirements(), client)))
        throw new Error('Entity binding permissions changed');
      return { ref: input.target, revision: revision + 1, bound: true };
    });
  }
  async history(access: Access, model: PublishedOntology, raw: unknown) {
    const input = entityHistorySchema.parse(raw);
    authorize(access, model, input.source, true);
    const graph = new Objects(this.db, model, access);
    const result = await this.db.query(
      `SELECT sequence::text,revision,before_target,after_target,reason,actor,release,happened_at
      FROM ${this.db.schema}.entity_binding_history WHERE ontology=$1 AND owner=$2 AND source=$3 AND external_id=$4
      AND sequence>$5::bigint ORDER BY sequence LIMIT $6`,
      [
        model.document.id,
        access.principal.owner,
        input.source,
        input.externalId,
        input.after ?? '0',
        input.limit + 1,
      ],
    );
    const rows = result.rows.slice(0, input.limit);
    for (const row of rows) {
      await graph.read(objectRefSchema.parse(row.after_target));
      if (row.before_target) await graph.read(objectRefSchema.parse(row.before_target));
    }
    await access.refresh();
    if (!(await access.canReturn(access.dataRequirements())))
      throw new Error('Entity history permissions changed');
    return {
      items: rows,
      cursor: result.rows.length > input.limit ? (rows.at(-1)!.sequence as string) : undefined,
    };
  }
}
