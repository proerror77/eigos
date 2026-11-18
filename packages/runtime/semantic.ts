import { documentChunkType, documentType } from '../ontology/documents.js';
import { isProtected } from '../ontology/classification.js';
import { z } from 'zod';
import { Conflict, digest, NotFound } from '../core/identity.js';
import { objectRefSchema, type ObjectData } from '../ontology/schema.js';
import { Access } from './access.js';
import type { Database, Sql } from './database.js';
import type { PublishedOntology } from './metadata.js';
import { Functions } from './functions.js';
import { Objects, querySchema } from './objects.js';
import { pgvectorNamespace } from './semantic-pgvector.js';
import { semanticIndexBinding } from './semantic-publication.js';
import { nestedValue, propertyPathSchema } from './query-filter.js';

const indexName = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9]*$/)
  .max(80);
export const semanticConfigureSchema = z.strictObject({
  name: indexName,
  type: z.string().min(1),
  property: propertyPathSchema,
  embeddingFunction: z.string().min(1),
  dimensions: z.number().int().min(1).max(4096),
});
export const semanticIndexSchema = z.strictObject({
  name: indexName,
  objects: z.array(objectRefSchema).min(1).max(100),
});
export const semanticSearchSchema = z.strictObject({
  name: indexName,
  text: z.string().min(1).max(32000),
  from: querySchema.shape.from,
  limit: z.number().int().min(1).max(100).default(10),
});
export const semanticSearchViewSchema = semanticSearchSchema.extend({ scenarioId: z.uuid().optional() });
export const semanticStatusSchema = z.strictObject({ name: indexName });
type Configuration = z.output<typeof semanticConfigureSchema> & {
  release: string;
  binding: string;
  modelVersion: string;
};
export async function initializeSemantic(db: Database) {
  await db.query(`CREATE TABLE IF NOT EXISTS ${db.schema}.semantic_indexes (
    ontology text NOT NULL,release text NOT NULL REFERENCES ${db.schema}.releases(digest),name text NOT NULL,
    type text NOT NULL,property text NOT NULL,embedding_function text NOT NULL,embedding_version text NOT NULL,binding text NOT NULL,dimensions integer NOT NULL,
    PRIMARY KEY(ontology,release,name));
    ALTER TABLE ${db.schema}.semantic_indexes ADD COLUMN IF NOT EXISTS embedding_version text;
    CREATE TABLE IF NOT EXISTS ${db.schema}.semantic_vectors (
      ontology text NOT NULL,release text NOT NULL,name text NOT NULL,owner text NOT NULL,type text NOT NULL,id text NOT NULL,
      revision bigint NOT NULL,text_digest text NOT NULL,binding text NOT NULL,dimensions integer NOT NULL,vector jsonb NOT NULL,
      indexed_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(ontology,release,name,owner,type,id),
      FOREIGN KEY(ontology,release,name) REFERENCES ${db.schema}.semantic_indexes(ontology,release,name));`);
}
function chunkCitation(object: ObjectData) {
  const { documentId, index, startOffset, endOffset, page, paragraph } = object.properties;
  if (typeof documentId !== 'string' || typeof index !== 'number' || typeof startOffset !== 'number' || typeof endOffset !== 'number') return undefined;
  return {
    version: { type: documentType, id: documentId }, chunk: object.ref, index, startOffset, endOffset,
    ...(typeof page === 'number' ? { page } : {}), ...(typeof paragraph === 'number' ? { paragraph } : {}),
  };
}
type Candidate = { object: ObjectData; citation?: ReturnType<typeof chunkCitation>; textDigest: string; tie: string };
type DocumentScope = NonNullable<z.output<typeof semanticSearchSchema>['from']>;
type Backend = 'jsonb' | 'pgvector';
type CandidateSnapshot = { candidates: Candidate[]; client: Sql; namespace?: string; match: string; values: unknown[] };
type ScoredCandidate = { ordinal: number; score: number };
const normalized = (raw: unknown, dimensions: number): number[] => {
  const vector = z.array(z.number().finite()).length(dimensions).parse(raw),
    norm = Math.hypot(...vector);
  if (!Number.isFinite(norm) || norm === 0) throw new Conflict('Embedding must have a finite nonzero norm');
  return vector.map((value) => value / norm);
};
export class SemanticSearch {
  constructor(
    private readonly db: Database,
    private readonly functions: Functions,
  ) {}
  async configure(access: Access, model: PublishedOntology, raw: unknown) {
    const input = semanticConfigureSchema.parse(raw);
    if (model.scenario) throw new Conflict('Configure semantic indexes on a published live Ontology');
    await access.refresh();
    access.require(model.document.id, 'manage_definition', model.document.id);
    const { binding, modelVersion } = semanticIndexBinding(model, model.bindings, input);
    return this.db.transaction(async (client) => {
      await new Objects(this.db, model, access, client).lockWrites();
      const existing = (
        await this.db.query(
          `SELECT * FROM ${this.db.schema}.semantic_indexes WHERE ontology=$1 AND release=$2 AND name=$3`,
          [model.document.id, model.release, input.name],
          client,
        )
      ).rows[0];
      if (
        existing &&
        (existing.type !== input.type ||
          existing.property !== input.property ||
          existing.embedding_function !== input.embeddingFunction ||
          existing.dimensions !== input.dimensions ||
          existing.binding !== binding ||
          existing.embedding_version !== modelVersion)
      )
        throw new Conflict('A semantic index configuration is immutable; use another name or publication');
      await this.db.query(
        `INSERT INTO ${this.db.schema}.semantic_indexes(ontology,release,name,type,property,embedding_function,binding,dimensions,embedding_version)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
        [
          model.document.id,
          model.release,
          input.name,
          input.type,
          input.property,
          input.embeddingFunction,
          binding,
          input.dimensions,
          modelVersion,
        ],
        client,
      );
      const configured = (
        await this.db.query(
          `SELECT type,property,embedding_function,embedding_version,dimensions,binding FROM ${this.db.schema}.semantic_indexes WHERE ontology=$1 AND release=$2 AND name=$3`,
          [model.document.id, model.release, input.name],
          client,
        )
      ).rows[0]!;
      if (
        configured.type !== input.type ||
        configured.property !== input.property ||
        configured.embedding_function !== input.embeddingFunction ||
        Number(configured.dimensions) !== input.dimensions ||
        configured.binding !== binding ||
        configured.embedding_version !== modelVersion
      )
        throw new Conflict('Concurrent semantic configuration differs');
      await access.refresh(client);
      return { ...input, release: model.release, binding, modelVersion };
    });
  }
  private async configuration(
    access: Access,
    model: PublishedOntology,
    name: string,
  ): Promise<Configuration> {
    indexName.parse(name);
    await access.refresh();
    const row = (
      await this.db.query(
        `SELECT * FROM ${this.db.schema}.semantic_indexes WHERE ontology=$1 AND release=$2 AND name=$3`,
        [model.document.id, model.release, name],
      )
    ).rows[0];
    if (!row) throw new NotFound('Semantic index is unavailable for this publication');
    access.read(model, row.type);
    access.function(model, row.embedding_function);
    if (
      row.binding !== model.bindings.functions[row.embedding_function] ||
      row.embedding_version !== model.functions.get(row.embedding_function)?.version
    )
      throw new Conflict('Semantic index model binding changed');
    return {
      name,
      type: row.type,
      property: row.property,
      embeddingFunction: row.embedding_function,
      dimensions: Number(row.dimensions),
      release: row.release,
      binding: row.binding,
      modelVersion: row.embedding_version,
    };
  }
  private async embed(access: Access, model: PublishedOntology, configuration: Configuration, text: string) {
    const result = await this.functions.invoke(
      model,
      configuration.embeddingFunction,
      { text },
      {
        principal: access.principal,
        objects: new Objects(this.db, model, access),
        signal: AbortSignal.timeout(30000),
      },
    );
    return normalized(result, configuration.dimensions);
  }
  async index(access: Access, model: PublishedOntology, raw: unknown) {
    const input = semanticIndexSchema.parse(raw),
      configuration = await this.configuration(access, model, input.name);
    if (model.scenario) throw new Conflict('Index live objects before opening a Scenario');
    const refs = [...new Map(input.objects.map((ref) => [digest(ref), ref])).values()];
    let indexed = 0;
    for (const ref of refs) {
      if (ref.type !== configuration.type) throw new Conflict('Object type differs from the semantic index');
      const graph = new Objects(this.db, model, access),
        scoped = await access.measureEgress(() => graph.readStored(ref)),
        object = scoped.result;
      if (isProtected(scoped.classification) && configuration.embeddingFunction !== 'embedTextLocal')
        throw new Conflict('Protected embedding input requires the local embedding Function');
      const text = nestedValue(object.properties, configuration.property);
      if (typeof text !== 'string' || !text.length || text.length > 32000)
        throw new Conflict('Embedding input must be an authorized string of 1 to 32000 characters');
      const textDigest = digest(text),
        vector = await this.embed(access, model, configuration, text);
      await this.db.transaction(async (client) => {
        const currentGraph = new Objects(this.db, model, access, client);
        await currentGraph.lockWrites();
        const current = await currentGraph.readStored(ref);
        if (
          current.revision !== object.revision ||
          digest(nestedValue(current.properties, configuration.property)) !== textDigest
        )
          throw new Conflict('Object changed while its embedding was generated; retry indexing');
        if (!(await access.canReturn(access.dataRequirements(), client)))
          throw new Conflict('Embedding input permissions changed');
        await this.db.query(
          `INSERT INTO ${this.db.schema}.semantic_vectors(ontology,release,name,owner,type,id,revision,text_digest,binding,dimensions,vector)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(ontology,release,name,owner,type,id)
          DO UPDATE SET revision=excluded.revision,text_digest=excluded.text_digest,binding=excluded.binding,dimensions=excluded.dimensions,vector=excluded.vector,indexed_at=now()`,
          [
            model.document.id,
            model.release,
            input.name,
            access.principal.owner,
            ref.type,
            ref.id,
            current.revision,
            textDigest,
            configuration.binding,
            configuration.dimensions,
            JSON.stringify(vector),
          ],
          client,
        );
      });
      indexed++;
    }
    return {
      name: input.name,
      indexed,
      release: model.release,
      dimensions: configuration.dimensions,
      binding: configuration.binding,
      modelVersion: configuration.modelVersion,
    };
  }
  private async documentChunks(graph: Objects, from: DocumentScope) {
    if (graph.model.navigation(from.object.type, from.link, from.as).target !== documentType) {
      throw new Conflict('Document search scope must link to a document version');
    }
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await graph.queryStored({ type: documentType, from, select: ['id'], limit: 100, cursor });
      ids.push(...page.items.map(item => item.ref.id));
      if (ids.length > 10000) throw new Conflict('Document search scope exceeds 10000 authorized document versions');
      cursor = page.cursor;
    } while (cursor);
    if (!ids.length) return [];
    const chunks = await graph.followSet(documentType, ids, 'chunks', undefined, 10000);
    if (!chunks) throw new Conflict('Document search scope needs a stored document chunk relationship');
    const approved = new Set(ids);
    return chunks.filter(chunk => typeof chunk.properties.documentId === 'string' && approved.has(chunk.properties.documentId));
  }
  private async withCandidates<T>(access: Access, model: PublishedOntology, configuration: Configuration,
    read: (snapshot: CandidateSnapshot) => Promise<T>, from?: DocumentScope) {
    return this.db.transaction(async (client) => {
      await this.db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', [], client);
      await access.refresh(client);
      const graph = new Objects(this.db, model, access, client), candidates: Candidate[] = [];
      let seen = 0;
      const accept = (objects: ObjectData[]) => {
        seen += objects.length;
        if (seen > 10000) throw new Conflict('Exact semantic search exceeds 10000 authorized objects');
        for (const object of objects) {
          const text = nestedValue(object.properties, configuration.property);
          if (typeof text !== 'string') continue;
          const citation = object.ref.type === documentChunkType ? chunkCitation(object) : undefined;
          if (object.ref.type === documentChunkType && !citation) continue;
          candidates.push({ object, citation, textDigest: digest(text), tie: digest(object.ref) });
        }
      };
      if (from) accept(await this.documentChunks(graph, from));
      else {
        let cursor: string | undefined;
        do {
          const page = await graph.queryStored({ type: configuration.type, limit: 100, cursor });
          accept(page.items);
          cursor = page.cursor;
        } while (cursor);
      }
      // Stable identity order breaks equal scores the same way in each backend.
      candidates.sort((a, b) => a.tie < b.tie ? -1 : a.tie > b.tie ? 1 : 0);
      const values = [
        model.document.id, model.release, configuration.name, access.principal.owner, configuration.binding, configuration.dimensions,
        JSON.stringify(candidates.map(({ object, textDigest }, ordinal) =>
          ({ ...object.ref, revision: object.revision, text_digest: textDigest, ordinal }))),
      ];
      const match = `FROM ${this.db.schema}.semantic_vectors v
        JOIN jsonb_to_recordset($7::jsonb) AS accepted(type text,id text,revision bigint,text_digest text,ordinal integer)
          ON (v.type,v.id,v.revision,v.text_digest)=(accepted.type,accepted.id,accepted.revision,accepted.text_digest)
        WHERE v.ontology=$1 AND v.release=$2 AND v.name=$3 AND v.owner=$4 AND v.binding=$5 AND v.dimensions=$6`;
      const namespace = await pgvectorNamespace(this.db, client);
      const backend: Backend = namespace ? 'pgvector' : 'jsonb';
      return { backend, value: await read({ candidates, client, namespace, match, values }) };
    });
  }
  private async rank(snapshot: CandidateSnapshot, query: number[], limit: number): Promise<ScoredCandidate[]> {
    const { namespace, values, match, client } = snapshot;
    if (namespace) {
      // Materialize the ACL- and freshness-matched vectors before scoring. The planner cannot use an
      // approximate vector index in place of the exact authorized ranking, even if one was added separately.
      const result = await this.db.query<ScoredCandidate>(`WITH eligible AS MATERIALIZED (
        SELECT accepted.ordinal,v.pg_embedding ${match}
      ), scored AS (
        SELECT ordinal, pg_embedding OPERATOR(${namespace}.<=>) $8::${namespace}.vector AS distance FROM eligible
      )
      SELECT ordinal,1-distance AS score FROM scored ORDER BY distance,ordinal LIMIT $9`,
      [...values, JSON.stringify(query), limit], client);
      return result.rows;
    }
    const result = await this.db.query<{ ordinal: number; vector: unknown }>(
      `SELECT accepted.ordinal,v.vector ${match}`, values, client);
    return result.rows.map(({ ordinal, vector }) => ({
      ordinal,
      score: normalized(vector, query.length).reduce((sum, value, index) => sum + value * query[index]!, 0),
    })).sort((a, b) => b.score - a.score || a.ordinal - b.ordinal).slice(0, limit);
  }
  async search(access: Access, model: PublishedOntology, raw: unknown) {
    const input = semanticSearchSchema.parse(raw),
      configuration = await this.configuration(access, model, input.name);
    if (input.from && configuration.type !== documentChunkType) throw new Conflict('Search from an object requires a document chunk index');
    const query = await this.embed(access, model, configuration, input.text);
    const { backend, value: items } = await this.withCandidates(access, model, configuration, async snapshot =>
      (await this.rank(snapshot, query, input.limit)).map(({ ordinal, score }) => {
        const { object, citation } = snapshot.candidates[ordinal]!;
        return { object, ...(citation ? { citation } : {}), score };
      }), input.from);
    if (!(await access.canReturn(access.dataRequirements())))
      throw new Conflict('Semantic result permissions changed');
    return {
      name: input.name,
      items,
      dimensions: configuration.dimensions,
      binding: configuration.binding,
      modelVersion: configuration.modelVersion,
      search: 'exact_cosine',
      backend,
    };
  }
  async status(access: Access, model: PublishedOntology, name: string) {
    const configuration = await this.configuration(access, model, name);
    const { backend, value: currentAuthorizedObjects } = await this.withCandidates(access, model, configuration,
      async ({ client, match, values }) => Number((await this.db.query(
        `SELECT count(*) AS count ${match}`, values, client)).rows[0]?.count ?? 0));
    if (!(await access.canReturn(access.dataRequirements())))
      throw new Conflict('Semantic status permissions changed');
    return { ...configuration, currentAuthorizedObjects, search: 'exact_cosine', backend };
  }
}
