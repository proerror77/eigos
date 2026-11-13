import {initializeOntologyDataMigrations} from './ontology-migrations.js';
import {initializeEntityResolution} from './entity-resolution.js';
import {initializeSemantic} from './semantic.js';
import {initializeApplications} from './applications.js';
import {initializeAutomation} from './automation.js';
import {initializeScenarioLifecycle} from './scenarios.js';
import {initializeActionUndo} from './action-journal.js';
import { initializeObjectSets } from './object-sets.js';
import { initializeGovernance } from './governance.js';
import { initializeEffects } from './effects.js';
import { initializeIndexing } from './indexing.js';
import { initializeEditHistory } from './edit-history.js';
import { initializeMaterializations } from './materializations.js';
import pg, { type PoolClient, type QueryResultRow } from 'pg';
import { initializeSecurity } from './security.js';
import { implementationDigest } from './implementation.js';

export type Sql = Pick<pg.Pool, 'query'> | Pick<PoolClient, 'query'>;
export class Database {
  readonly pool: pg.Pool;
  readonly schema: string;
  readonly queryPool?: pg.Pool;
  queries = 0;
  constructor(connectionString: string, schema = 'eigos', readonly runtimeId = implementationDigest(), queryConnectionString?: string) {
    if (!/^eigos(?:_[a-z0-9]+)*$/.test(schema)) throw new Error('Invalid schema');
    this.schema = `"${schema}"`;
    this.pool = new pg.Pool({ connectionString, max: 8, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
    if (queryConnectionString) {
      this.queryPool = new pg.Pool({connectionString:queryConnectionString,max:8,connectionTimeoutMillis:1000,statement_timeout:10000,options:'-c default_transaction_read_only=on'});
      this.queryPool.on('error',()=>{});
    }
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
  private async readTransaction<T extends QueryResultRow>(pool: pg.Pool, text: string, values: unknown[], authority?: {id:string;position:string}) {
    const connection = await pool.connect();
    try {
      await connection.query('BEGIN READ ONLY');
      if (authority) {
        const replica=(await connection.query(`SELECT id,NOT pg_is_in_recovery() OR pg_last_wal_replay_lsn()>=$1::pg_lsn AS current FROM ${this.schema}.storage_identity`,[authority.position])).rows[0];
        if (replica?.id !== authority.id || !replica.current) {
          await connection.query('ROLLBACK');
          return undefined;
        }
      }
      const result=await this.query<T>(text,values,connection);
      await connection.query('COMMIT');
      return result;
    } catch(error) {
      await connection.query('ROLLBACK').catch(()=>{});
      throw error;
    } finally { connection.release(); }
  }
  async readQuery<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = [], client: Sql = this.pool) {
    if (!this.queryPool || client !== this.pool) return this.query<T>(text,values,client);
    const primary=(await this.query<{id:string;position:string}>(`SELECT id,pg_current_wal_lsn()::text AS position FROM ${this.schema}.storage_identity`)).rows[0];
    if (!primary) throw new Error('Storage identity is unavailable');
    try {
      const result=await this.readTransaction<T>(this.queryPool,text,values,primary);
      if(result)return result;
    } catch(error) {
      if ((error as {code?:string}).code==='25006') throw error;
      // A pooler may ignore startup options. Both paths use explicit read-only transactions.
    }
    return (await this.readTransaction<T>(this.pool,text,values))!;
  }
  async close() { await this.queryPool?.end(); await this.pool.end(); }
  async initialize() {
    const s = this.schema;
    await this.query(`CREATE SCHEMA IF NOT EXISTS ${s};
      CREATE TABLE IF NOT EXISTS ${s}.storage_identity(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),id uuid NOT NULL DEFAULT gen_random_uuid());
      INSERT INTO ${s}.storage_identity(singleton) VALUES(true) ON CONFLICT DO NOTHING;
      CREATE TABLE IF NOT EXISTS ${s}.releases (digest text PRIMARY KEY, body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS ${s}.ontology (id text PRIMARY KEY, release text NOT NULL REFERENCES ${s}.releases(digest));
      ALTER TABLE ${s}.releases ADD COLUMN IF NOT EXISTS definition_digest text;
      ALTER TABLE ${s}.releases ADD COLUMN IF NOT EXISTS transform_id uuid;
      ALTER TABLE ${s}.releases ADD COLUMN IF NOT EXISTS projection text;
      ALTER TABLE ${s}.releases ADD COLUMN IF NOT EXISTS runtime_id text;
      ALTER TABLE ${s}.releases ADD COLUMN IF NOT EXISTS bindings jsonb;
      ALTER TABLE ${s}.releases ADD COLUMN IF NOT EXISTS state text;
      ALTER TABLE ${s}.releases ADD COLUMN IF NOT EXISTS prepared_from text;
      ALTER TABLE ${s}.releases ADD COLUMN IF NOT EXISTS source_fingerprint text;
      ALTER TABLE ${s}.releases ADD COLUMN IF NOT EXISTS projection_fingerprint text;
      CREATE TABLE IF NOT EXISTS ${s}.resource_grants (subject text NOT NULL, resource text NOT NULL, permission text NOT NULL, PRIMARY KEY(subject,resource,permission));
      CREATE TABLE IF NOT EXISTS ${s}.property_security (ontology text NOT NULL, type text NOT NULL, property text NOT NULL, PRIMARY KEY(ontology,type,property));
      CREATE TABLE IF NOT EXISTS ${s}.objects (projection text NOT NULL, owner text NOT NULL, type text NOT NULL, id text NOT NULL, revision bigint NOT NULL DEFAULT 1, properties jsonb NOT NULL, PRIMARY KEY(projection,owner,type,id));
      CREATE INDEX IF NOT EXISTS objects_properties ON ${s}.objects USING gin(properties jsonb_path_ops);
      CREATE TABLE IF NOT EXISTS ${s}.links (projection text NOT NULL, owner text NOT NULL, type text NOT NULL, from_type text NOT NULL, from_id text NOT NULL, to_type text NOT NULL, to_id text NOT NULL,
        single_from boolean NOT NULL, single_to boolean NOT NULL,
        PRIMARY KEY(projection,owner,type,from_type,from_id,to_type,to_id),
        FOREIGN KEY(projection,owner,from_type,from_id) REFERENCES ${s}.objects(projection,owner,type,id),
        FOREIGN KEY(projection,owner,to_type,to_id) REFERENCES ${s}.objects(projection,owner,type,id));
      CREATE INDEX IF NOT EXISTS links_reverse ON ${s}.links(projection,owner,to_type,to_id,type);
      CREATE UNIQUE INDEX IF NOT EXISTS links_single_from ON ${s}.links(projection,owner,type,from_type,from_id) WHERE single_from;
      CREATE UNIQUE INDEX IF NOT EXISTS links_single_to ON ${s}.links(projection,owner,type,to_type,to_id) WHERE single_to;
      CREATE TABLE IF NOT EXISTS ${s}.actions (owner text NOT NULL, request_id text NOT NULL, digest text NOT NULL, action text NOT NULL, release text NOT NULL REFERENCES ${s}.releases(digest), result jsonb NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner,request_id));
      CREATE TABLE IF NOT EXISTS ${s}.tasks (id uuid PRIMARY KEY, owner text NOT NULL, request_id text NOT NULL, input_digest text NOT NULL, input jsonb NOT NULL, release text NOT NULL REFERENCES ${s}.releases(digest), scopes jsonb NOT NULL,
        state text NOT NULL DEFAULT 'submitted', token uuid, lease_until timestamptz, result jsonb, error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner,request_id));
      ALTER TABLE ${s}.tasks ADD COLUMN IF NOT EXISTS result_permissions jsonb;
      ALTER TABLE ${s}.tasks ADD COLUMN IF NOT EXISTS available_at timestamptz NOT NULL DEFAULT now();
      ALTER TABLE ${s}.tasks ADD COLUMN IF NOT EXISTS execution_step integer NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS tasks_queue ON ${s}.tasks(state,created_at);
      CREATE TABLE IF NOT EXISTS ${s}.source_calls (task_id uuid NOT NULL REFERENCES ${s}.tasks(id), name text NOT NULL, state text NOT NULL, input_digest text NOT NULL, result jsonb, PRIMARY KEY(task_id,name));`);
    await this.query(`
      CREATE TABLE IF NOT EXISTS ${s}.scenarios (id uuid PRIMARY KEY, owner text NOT NULL, request_id text NOT NULL, name text NOT NULL,
        release text NOT NULL REFERENCES ${s}.releases(digest), revision bigint NOT NULL DEFAULT 1, state text NOT NULL DEFAULT 'open',
        created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '31 days', UNIQUE(owner,request_id));
      CREATE TABLE IF NOT EXISTS ${s}.scenario_objects (scenario_id uuid NOT NULL REFERENCES ${s}.scenarios(id), owner text NOT NULL,
        type text NOT NULL, id text NOT NULL, base_revision bigint, base_properties jsonb, base_links jsonb NOT NULL, revision bigint NOT NULL, properties jsonb,
        PRIMARY KEY(scenario_id,owner,type,id));
      CREATE TABLE IF NOT EXISTS ${s}.scenario_links (scenario_id uuid NOT NULL REFERENCES ${s}.scenarios(id), owner text NOT NULL,
        type text NOT NULL, from_type text NOT NULL, from_id text NOT NULL, to_type text NOT NULL, to_id text NOT NULL,
        single_from boolean NOT NULL, single_to boolean NOT NULL, base_present boolean NOT NULL, removed boolean NOT NULL,
        PRIMARY KEY(scenario_id,owner,type,from_type,from_id,to_type,to_id));
      CREATE TABLE IF NOT EXISTS ${s}.scenario_actions (scenario_id uuid NOT NULL REFERENCES ${s}.scenarios(id), owner text NOT NULL,
        request_id text NOT NULL, digest text NOT NULL, action text NOT NULL, result jsonb NOT NULL, requirements jsonb NOT NULL,
        PRIMARY KEY(scenario_id,owner,request_id));
      CREATE TABLE IF NOT EXISTS ${s}.pa_requests (id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES ${s}.tasks(id), owner text NOT NULL,
        request_key text NOT NULL, request jsonb NOT NULL, response jsonb, response_digest text, created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(task_id,request_key));
      CREATE TABLE IF NOT EXISTS ${s}.external_operations (owner text NOT NULL,operation_key text NOT NULL,scope_digest text NOT NULL,state text NOT NULL,result jsonb,
        requirements jsonb NOT NULL DEFAULT '[]',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner,operation_key));
      CREATE TABLE IF NOT EXISTS ${s}.scheduled_actions (id text NOT NULL,owner text NOT NULL,body jsonb NOT NULL,scopes jsonb NOT NULL,run_at timestamptz NOT NULL,deadline timestamptz NOT NULL,
        state text NOT NULL DEFAULT 'scheduled',task_id uuid UNIQUE REFERENCES ${s}.tasks(id),error text,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner,id));
      CREATE INDEX IF NOT EXISTS scheduled_actions_due ON ${s}.scheduled_actions(run_at) WHERE state='scheduled';`);
    await this.query(`ALTER TABLE ${s}.scheduled_actions ADD COLUMN IF NOT EXISTS continue_at timestamptz`);
    await this.query(`ALTER TABLE ${s}.external_operations ADD COLUMN IF NOT EXISTS requirements jsonb NOT NULL DEFAULT '[]'`);

    await initializeOntologyDataMigrations(this);
    await initializeEntityResolution(this);
    await initializeSemantic(this);
    await initializeApplications(this);
    await initializeAutomation(this);
    await initializeScenarioLifecycle(this);
    await initializeActionUndo(this);
    await initializeSecurity(this);
    await initializeObjectSets(this);
    await initializeGovernance(this);
    await initializeEffects(this);
    await initializeEditHistory(this);
    await initializeIndexing(this);
    await initializeMaterializations(this);
  }
}
