import { Conflict } from '../core/identity.js';
import type { Database, Sql } from './database.js';
import type { PublishedOntology } from './metadata.js';

export type SemanticIndexInput = {
  name: string; type: string; property: string; embeddingFunction: string; dimensions: number;
};

/** Configuration and publication use the same stored-text and versioned-model contract. */
export function semanticIndexBinding(model: PublishedOntology, input: SemanticIndexInput) {
  const property = model.object(input.type).properties[input.property.split('.')[0]!];
  if (!property || property.derived) throw new Conflict('Semantic indexes require a stored text property');
  let schema = property.schema;
  for (const field of input.property.split('.').slice(1)) {
    const next = schema.type === 'array' && /^\d+$/.test(field)
      ? schema.items : (schema.properties as Record<string, unknown> | undefined)?.[field];
    if (!next || typeof next !== 'object') throw new Conflict('Unknown nested embedding property');
    schema = next as Record<string, unknown>;
  }
  if (schema.type !== 'string' && !(Array.isArray(schema.type) && schema.type.includes('string')))
    throw new Conflict('Embedding property schema must contain text');
  const definition = model.functions.get(input.embeddingFunction);
  const binding = model.bindings.functions[input.embeddingFunction];
  if (!definition?.version || definition.edits || !binding)
    throw new Conflict('Register and publish a versioned read-only embedding Function first');
  const parameters = definition.parameters.properties as Record<string, { type?: string }> | undefined;
  if (parameters?.text?.type !== 'string' || definition.returns.type !== 'array'
    || (definition.returns.items as { type?: string } | undefined)?.type !== 'number')
    throw new Conflict('Embedding Function must accept text:string and return number[]');
  return { binding, modelVersion: definition.version };
}

/** Copy publication-owned storage; query-time permissions and freshness still govern every vector. */
export async function copySemanticIndexes(db: Database, from: string, target: PublishedOntology, client: Sql) {
  if (from === target.release) throw new Conflict('A replacement publication must differ from its source');
  const indexes = (await db.query(`SELECT * FROM ${db.schema}.semantic_indexes WHERE release=$1 ORDER BY name`, [from], client)).rows;
  if (!indexes.length) return;
  for (const index of indexes) {
    try {
      const contract = semanticIndexBinding(target, { name: index.name, type: index.type, property: index.property,
        embeddingFunction: index.embedding_function, dimensions: Number(index.dimensions) });
      if (contract.binding !== index.binding || contract.modelVersion !== index.embedding_version)
        throw new Conflict('Embedding model binding changed');
    } catch {
      throw new Conflict(`Semantic index ${index.name} requires a compatible stored property and embedding Function before publication`);
    }
  }
  await db.query(`DELETE FROM ${db.schema}.semantic_vectors WHERE release=$1`, [target.release], client);
  await db.query(`DELETE FROM ${db.schema}.semantic_indexes WHERE release=$1`, [target.release], client);
  await db.query(`INSERT INTO ${db.schema}.semantic_indexes(ontology,release,name,type,property,embedding_function,embedding_version,binding,dimensions)
    SELECT ontology,$2,name,type,property,embedding_function,embedding_version,binding,dimensions
    FROM ${db.schema}.semantic_indexes WHERE release=$1`, [from, target.release], client);
  // Explicit columns also work with the optional generated pgvector column.
  await db.query(`INSERT INTO ${db.schema}.semantic_vectors(ontology,release,name,owner,type,id,revision,text_digest,binding,dimensions,vector,indexed_at)
    SELECT ontology,$2,name,owner,type,id,revision,text_digest,binding,dimensions,vector,indexed_at
    FROM ${db.schema}.semantic_vectors WHERE release=$1`, [from, target.release], client);
}

export async function semanticFingerprint(db: Database, projection: string, client: Sql) {
  return (await db.query(`SELECT
    (SELECT md5(coalesce(string_agg(md5(row(i.ontology,i.name,i.type,i.property,i.embedding_function,i.embedding_version,i.binding,i.dimensions)::text),'' ORDER BY i.ontology,i.name),''))
      FROM ${db.schema}.semantic_indexes i JOIN ${db.schema}.releases r ON r.digest=i.release WHERE r.projection=$1) AS indexes,
    (SELECT md5(coalesce(string_agg(md5(row(v.ontology,v.name,v.owner,v.type,v.id,v.revision,v.text_digest,v.binding,v.dimensions,v.vector)::text),'' ORDER BY v.ontology,v.name,v.owner,v.type,v.id),''))
      FROM ${db.schema}.semantic_vectors v JOIN ${db.schema}.releases r ON r.digest=v.release WHERE r.projection=$1) AS vectors`, [projection], client)).rows[0];
}
