import type { Client } from 'pg';
import { digest } from '../core/delegation.js';
import { DomainError } from '../core/domain.js';
import type { ActionDefinition } from '../ontology/model.js';
import type {
  OntologyDocument,
  OntologyReleaseRef,
} from '../ontology/definition-contracts.js';
import type { TextEmbedder } from './local-embedding.js';
import { validateVector } from './local-embedding.js';

export type SemanticKind = 'action' | 'object' | 'function';
export interface SemanticDocument {
  kind: SemanticKind;
  id: string;
  metadataDigest: string;
  text: string;
  contentDigest: string;
}
export type SemanticRanking =
  import('../core/action-bindings.js').SemanticActionRanking;
export interface SemanticActionRanker {
  rank(
    client: Client,
    release: OntologyReleaseRef,
    actions: readonly ActionDefinition[],
    query: string,
  ): Promise<SemanticRanking>;
}
export function sqlIdentifier(name: string) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name))
    throw Error('Invalid semantic schema or role');
  return '"' + name + '"';
}
function document(
  kind: SemanticKind,
  id: string,
  value: unknown,
  text: string,
): SemanticDocument {
  return {
    kind,
    id,
    metadataDigest: digest(value),
    text: text.slice(0, 3000),
    contentDigest: digest({ kind, id, text: text.slice(0, 3000) }),
  };
}
export function actionDocument(
  a: ActionDefinition & { resourceId?: string },
): SemanticDocument {
  // Publication identities and executable handlers are resolved by exact readback.
  const {
    resourceId: _resourceId,
    implementation: _implementation,
    ...contract
  } = a;
  const outputs =
    a.resultTypes ??
    (a.read
      ? [a.read.resultType]
      : a.operation
        ? [a.operation.resultType]
        : []);
  return document(
    'action',
    a.id,
    contract,
    [
      a.id,
      a.description,
      'Inputs ' +
        Object.entries(a.inputs)
          .map(([role, type]) => role + ' ' + type)
          .join(', '),
      'Outputs ' + outputs.join(', '),
    ].join('\n'),
  );
}
export function catalogDocuments(value: OntologyDocument): SemanticDocument[] {
  return [
    ...value.actions.map(actionDocument),
    ...value.objects.map((o) =>
      document(
        'object',
        o.id,
        o,
        [o.id, o.name, o.description, ...o.aliases].join('\n'),
      ),
    ),
    ...value.functions.map((f) =>
      document(
        'function',
        f.id,
        f,
        [f.id, f.description, ...f.inputTypes].join('\n'),
      ),
    ),
  ];
}
export class SemanticCatalog implements SemanticActionRanker {
  readonly schema: string;
  constructor(
    private readonly embedder: TextEmbedder,
    schema = 'eigos_semantic',
  ) {
    if (!/^eigos_semantic(?:_[a-z0-9]{1,32})?$/.test(schema))
      throw Error('Use a dedicated eigos_semantic schema');
    this.schema = sqlIdentifier(schema);
  }
  /** Operator-only setup. An existing vector extension is required. */
  async initialize(client: Client, readerRole?: string) {
    if (client.getTransactionStatus() !== 'T' || client.pipeline !== false)
      throw Error('Semantic setup requires an owned transaction');
    const extension = await client.query(
      "SELECT n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector'",
    );
    if (extension.rows[0]?.schema !== 'extensions')
      throw Error('Reviewed vector extension in extensions schema is required');
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
    await client.query(`REVOKE ALL ON SCHEMA ${this.schema} FROM PUBLIC`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${this.schema}.catalog (
      ontology_id text NOT NULL,release_digest text NOT NULL,model_id text NOT NULL,kind text NOT NULL CHECK(kind IN('action','object','function')),
      resource_id text NOT NULL,metadata_digest text NOT NULL,content_digest text NOT NULL,
      embedding extensions.vector(384) NOT NULL,PRIMARY KEY(ontology_id,release_digest,model_id,kind,resource_id))`);
    await client.query(
      `REVOKE ALL ON TABLE ${this.schema}.catalog FROM PUBLIC`,
    );
    await client.query(`CREATE OR REPLACE FUNCTION ${this.schema}.rank_catalog(ns text,release text,model text,expected jsonb,query_vector text)
      RETURNS TABLE(kind text,id text,score double precision) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $rank$
      SELECT c.kind,c.resource_id,1-(c.embedding OPERATOR(extensions.<=>) query_vector::extensions.vector(384))
      FROM ${this.schema}.catalog c JOIN jsonb_to_recordset(expected) AS e(kind text,id text,metadata_digest text,content_digest text)
      ON c.kind=e.kind AND c.resource_id=e.id AND c.metadata_digest=e.metadata_digest AND c.content_digest=e.content_digest
      WHERE c.ontology_id=ns AND c.release_digest=release AND c.model_id=model
      ORDER BY c.embedding OPERATOR(extensions.<=>) query_vector::extensions.vector(384),c.kind,c.resource_id LIMIT 2000 $rank$`);
    await client.query(
      `REVOKE ALL ON FUNCTION ${this.schema}.rank_catalog(text,text,text,jsonb,text) FROM PUBLIC`,
    );
    if (readerRole) {
      const role = sqlIdentifier(readerRole);
      await client.query(`GRANT USAGE ON SCHEMA ${this.schema} TO ${role}`);
      await client.query(
        `GRANT SELECT(ontology_id,release_digest,model_id,kind,resource_id,metadata_digest,content_digest) ON ${this.schema}.catalog TO ${role}`,
      );
      await client.query(
        `GRANT EXECUTE ON FUNCTION ${this.schema}.rank_catalog(text,text,text,jsonb,text) TO ${role}`,
      );
    }
  }
  /** Build before opening the write transaction; publishing remains independent. */
  async encode(documents: readonly SemanticDocument[]) {
    if (
      documents.length > 4000 ||
      new Set(documents.map((d) => d.kind + ':' + d.id)).size !==
        documents.length
    )
      throw Error('Semantic catalog exceeds its complete bound');
    const rows = [];
    for (const d of documents)
      rows.push({
        ...d,
        embedding: validateVector(await this.embedder.embed(d.text, 'passage')),
      });
    return rows;
  }
  async replace(
    client: Client,
    release: OntologyReleaseRef,
    rows: Awaited<ReturnType<SemanticCatalog['encode']>>,
  ) {
    if (client.getTransactionStatus() !== 'T' || client.pipeline !== false)
      throw Error('Semantic index replacement requires an owned transaction');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      release.ontologyId + release.digest + this.embedder.modelId,
    ]);
    await client.query(
      `DELETE FROM ${this.schema}.catalog WHERE ontology_id=$1 AND release_digest=$2 AND model_id=$3`,
      [release.ontologyId, release.digest, this.embedder.modelId],
    );
    for (const row of rows)
      await client.query(
        `INSERT INTO ${this.schema}.catalog VALUES($1,$2,$3,$4,$5,$6,$7,$8::extensions.vector)`,
        [
          release.ontologyId,
          release.digest,
          this.embedder.modelId,
          row.kind,
          row.id,
          row.metadataDigest,
          row.contentDigest,
          JSON.stringify(validateVector(row.embedding)),
        ],
      );
  }
  async search(
    client: Client,
    release: OntologyReleaseRef,
    documents: readonly SemanticDocument[],
    query: string,
  ) {
    if (!documents.length) return [];
    if (documents.length > 2000 || !query.trim() || query.length > 1000)
      throw Error('Semantic query exceeds its bound');
    const expected = documents.map((d) => ({
      kind: d.kind,
      id: d.id,
      metadata_digest: d.metadataDigest,
      content_digest: d.contentDigest,
    }));
    // Check complete coverage of the *authorized* set, not the whole namespace.
    const coverage = await client.query(
      `SELECT count(*) AS n FROM ${this.schema}.catalog c
      JOIN jsonb_to_recordset($4::jsonb) AS e(kind text,id text,metadata_digest text,content_digest text)
      ON c.kind=e.kind AND c.resource_id=e.id AND c.metadata_digest=e.metadata_digest AND c.content_digest=e.content_digest
      WHERE ontology_id=$1 AND release_digest=$2 AND model_id=$3`,
      [
        release.ontologyId,
        release.digest,
        this.embedder.modelId,
        JSON.stringify(expected),
      ],
    );
    if (Number(coverage.rows[0]?.n) !== documents.length)
      throw new DomainError(
        'CONFLICT',
        'Semantic index is not ready for the authorized release; rebuild this version',
      );
    const vector = JSON.stringify(
      validateVector(await this.embedder.embed(query, 'query')),
    );
    const result = await client.query(
      `SELECT * FROM ${this.schema}.rank_catalog($1,$2,$3,$4::jsonb,$5)`,
      [
        release.ontologyId,
        release.digest,
        this.embedder.modelId,
        JSON.stringify(expected),
        vector,
      ],
    );
    const allowed = new Set(documents.map((d) => d.kind + ':' + d.id));
    if (
      result.rows.length !== documents.length ||
      new Set(result.rows.map((row) => row.kind + ':' + row.id)).size !==
        documents.length ||
      result.rows.some(
        (row) =>
          !allowed.has(row.kind + ':' + row.id) ||
          !Number.isFinite(Number(row.score)),
      )
    )
      throw Error('Semantic result differs from the authorized descriptor set');
    return result.rows.map((row) => ({
      kind: String(row.kind) as SemanticKind,
      id: String(row.id),
      score: Number(row.score),
    }));
  }
  async rank(
    client: Client,
    release: OntologyReleaseRef,
    actions: readonly ActionDefinition[],
    query: string,
  ): Promise<SemanticRanking> {
    let rows: Awaited<ReturnType<SemanticCatalog['search']>>;
    try {
      rows = await this.search(
        client,
        release,
        actions.map(actionDocument),
        query,
      );
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        'CONFLICT',
        'Semantic retrieval is unavailable; verify the configured index and runtime role',
      );
    }
    const scores = rows.map((row) => ({ actionId: row.id, score: row.score }));
    return {
      actionIds: scores.map((s) => s.actionId),
      modelId: this.embedder.modelId,
      contextDigest: digest({
        release,
        model: this.embedder.modelId,
        query,
        documents: actions.map(actionDocument).map((d) => d.contentDigest),
        scores,
      }),
      scores,
    };
  }
}
