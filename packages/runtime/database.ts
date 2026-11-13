import pg, { type PoolClient, type QueryResultRow } from 'pg';

export type Sql = Pick<pg.Pool, 'query'> | Pick<PoolClient, 'query'>;
export class Database {
  readonly pool: pg.Pool;
  readonly schema: string;
  queries = 0;
  constructor(connectionString: string, schema = 'eigos') {
    if (!/^eigos(?:_[a-z0-9]+)*$/.test(schema)) throw new Error('Invalid schema');
    this.schema = `"${schema}"`;
    this.pool = new pg.Pool({ connectionString, max: 8, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
    this.pool.on('error', error => process.stderr.write(`PostgreSQL connection error: ${error.name}\n`));
  }
  async query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = [], client: Sql = this.pool) {
    this.queries++;
    return client.query<T>(text, values);
  }
  async transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await this.query('BEGIN', [], client);
      await this.query("SET LOCAL lock_timeout='2s'", [], client);
      const result = await action(client);
      await this.query('COMMIT', [], client);
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  close() { return this.pool.end(); }
  async initialize() {
    const s = this.schema;
    await this.query(`CREATE SCHEMA IF NOT EXISTS ${s};
      CREATE TABLE IF NOT EXISTS ${s}.releases (digest text PRIMARY KEY, body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS ${s}.ontology (id text PRIMARY KEY, release text NOT NULL REFERENCES ${s}.releases(digest));
      CREATE TABLE IF NOT EXISTS ${s}.objects (owner text NOT NULL, type text NOT NULL, id text NOT NULL, revision bigint NOT NULL DEFAULT 1, properties jsonb NOT NULL, PRIMARY KEY(owner,type,id));
      CREATE INDEX IF NOT EXISTS objects_properties ON ${s}.objects USING gin(properties jsonb_path_ops);
      CREATE TABLE IF NOT EXISTS ${s}.links (owner text NOT NULL, type text NOT NULL, from_type text NOT NULL, from_id text NOT NULL, to_type text NOT NULL, to_id text NOT NULL,
        single_from boolean NOT NULL, single_to boolean NOT NULL,
        PRIMARY KEY(owner,type,from_type,from_id,to_type,to_id),
        FOREIGN KEY(owner,from_type,from_id) REFERENCES ${s}.objects(owner,type,id),
        FOREIGN KEY(owner,to_type,to_id) REFERENCES ${s}.objects(owner,type,id));
      CREATE INDEX IF NOT EXISTS links_reverse ON ${s}.links(owner,to_type,to_id,type);
      CREATE UNIQUE INDEX IF NOT EXISTS links_single_from ON ${s}.links(owner,type,from_type,from_id) WHERE single_from;
      CREATE UNIQUE INDEX IF NOT EXISTS links_single_to ON ${s}.links(owner,type,to_type,to_id) WHERE single_to;
      CREATE TABLE IF NOT EXISTS ${s}.actions (owner text NOT NULL, request_id text NOT NULL, digest text NOT NULL, action text NOT NULL, release text NOT NULL REFERENCES ${s}.releases(digest), result jsonb NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner,request_id));
      CREATE TABLE IF NOT EXISTS ${s}.tasks (id uuid PRIMARY KEY, owner text NOT NULL, request_id text NOT NULL, input_digest text NOT NULL, input jsonb NOT NULL, release text NOT NULL REFERENCES ${s}.releases(digest), scopes jsonb NOT NULL,
        state text NOT NULL DEFAULT 'submitted', token uuid, lease_until timestamptz, result jsonb, error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner,request_id));
      CREATE INDEX IF NOT EXISTS tasks_queue ON ${s}.tasks(state,created_at);
      CREATE TABLE IF NOT EXISTS ${s}.source_calls (task_id uuid NOT NULL REFERENCES ${s}.tasks(id), name text NOT NULL, state text NOT NULL, input_digest text NOT NULL, result jsonb, PRIMARY KEY(task_id,name));`);
  }
}
