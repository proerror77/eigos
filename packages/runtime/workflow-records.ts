import type { Database, Sql } from './database.js';

interface WorkflowIdentity {
  id: string;
  owner: string;
  ontology: string;
}

export async function readWorkflowRecord(db: Database, identity: WorkflowIdentity, client?: Sql,
  kind: string | null = null, lock = false) {
  const { rows } = await db.query<{ body: unknown; revision: string }>(
    `SELECT body,revision FROM ${db.schema}.workflows
     WHERE id=$1 AND owner=$2 AND ontology=$3 AND body->>'kind' IS NOT DISTINCT FROM $4::text
     ${lock ? 'FOR SHARE' : ''}`,
    [identity.id, identity.owner, identity.ontology, kind], client,
  );
  return rows[0];
}

export function insertWorkflowRecord(db: Database, client: Sql, record: WorkflowIdentity & { name: string; body: unknown }) {
  return db.query<{ revision: string }>(
    `INSERT INTO ${db.schema}.workflows(id,owner,ontology,name,body,revision) VALUES($1,$2,$3,$4,$5,1)
     RETURNING revision`,
    [record.id, record.owner, record.ontology, record.name, record.body], client,
  );
}
