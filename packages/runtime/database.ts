import {initializeObservationInterests} from './observation-interests.js';
import { developmentSandboxEnabled } from '../core/sandbox-mode.js';
import { initializeReleaseEvaluation } from './release-evaluation.js';
import {initializeOntologyDataMigrations} from './ontology-migrations.js';
import {initializeEntityResolution} from './entity-resolution.js';
import {initializeSemantic} from './semantic.js';
import {initializeApplications} from './applications.js';
import {initializeAutomation} from './automation.js';
import {initializeScenarioLifecycle} from './scenarios.js';
import { initializeMachineryStates } from './machinery-state.js';
import {initializeActionUndo} from './action-journal.js';
import { initializeObjectSets } from './object-sets.js';
import { initializeGovernance } from './governance.js';
import { initializeEffects } from './effects.js';
import { initializeIndexing } from './indexing.js';
import { initializeEditHistory } from './edit-history.js';
import { initializeMaterializations } from './materializations.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { activeProfiles, chargeProfiles, profileDatabase, type DatabaseProfile } from '../core/database-profile.js';
import { recordOperationEvent } from '../core/operation-timing.js';
import pg, { type PoolClient, type QueryResultRow } from 'pg';
import { initializeSecurity } from './security.js';
import { implementationDigest } from './implementation.js';
import { initializeScenarioEvaluations } from './scenario-evaluation.js';
import { initializeMachineryHistory } from './machinery-history.js';
import { initializeExecutionTrace } from './execution-trace.js';
import { initializeAccounts } from './accounts.js';

export type Sql = Pick<pg.Pool, 'query'> | Pick<PoolClient, 'query'>;
/** Thrown inside an object-scoped commit whose conflicts object locks cannot bound; the commit reruns exclusively. */
export class ExclusiveScopeRequired extends Error {
  constructor(readonly reason: string) { super(`Object-scoped commit needs the exclusive edit lock: ${reason}`); }
}
interface ObjectScope { held: Map<string, 'shared' | 'exclusive'>; escalated?: string }
/** Tables whose rows object locks protect; statements on them must come from code that took those locks. */
const ontologyData = /\.(?:objects|links|source_values|object_edits|edit_history|scenario_objects|scenario_links)\b/;

export class Database {
  readonly pool: pg.Pool;
  readonly schema: string;
  readonly queryPool?: pg.Pool;
  queries = 0;
  private readonly ownerContext = new AsyncLocalStorage<string>();
  private readonly transactionOwners = new WeakMap<Sql, string>();
  private readonly editLocks = new WeakMap<Sql, { since: number; profiles: readonly DatabaseProfile[] }>();
  private readonly sharedEditLocks = new WeakSet<Sql>();
  private readonly objectScopes = new WeakMap<Sql, ObjectScope>();
  private readonly objectAccess = new AsyncLocalStorage<true>();
  constructor(connectionString: string, schema = 'eigos', readonly runtimeId = implementationDigest(),
    queryConnectionString?: string, readonly ownerIsolation = process.env.EIGOS_ENFORCE_OWNER_RLS === 'true',
    readonly sandboxEnabled = developmentSandboxEnabled()) {
    if (!/^eigos(?:_[a-z0-9]+)*$/.test(schema)) throw new Error('Invalid schema');
    this.schema = `"${schema}"`;
    this.pool = new pg.Pool({ connectionString, max: 8, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
    if (queryConnectionString) {
      this.queryPool = new pg.Pool({connectionString:queryConnectionString,max:8,connectionTimeoutMillis:1000,statement_timeout:10000,options:'-c default_transaction_read_only=on'});
      this.queryPool.on('error',()=>{});
    }
    this.pool.on('error', error => process.stderr.write(`PostgreSQL connection error: ${error.name}\n`));
  }
  async query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = [], client: Sql = this.pool): Promise<pg.QueryResult<T>> {
    if (this.ownerIsolation && client === this.pool && this.ownerContext.getStore()) {
      return this.transaction(connection => this.query<T>(text, values, connection));
    }
    if (this.objectScopes.has(client) && !this.objectAccess.getStore() && ontologyData.test(text))
      this.requireExclusive(client, 'unlocked Ontology data statement');
    this.queries++;
    const profiles = activeProfiles(), started = performance.now();
    try { return await client.query<T>(text, values); }
    catch (error) {
      if ((error as { code?: unknown } | null)?.code === '55P03') chargeProfiles(profiles, 'lockTimeouts', 1);
      throw error;
    } finally {
      chargeProfiles(profiles, 'statements', 1);
      chargeProfiles(profiles, 'durationMs', performance.now() - started);
    }
  }
  /** Times acquiring the Ontology edit locks and how long the transaction then holds them. */
  async acquireEditLocks(client: Sql, acquire: () => Promise<void>) {
    const profiles = activeProfiles(), started = performance.now();
    try { await acquire(); }
    finally { chargeProfiles(profiles, 'editLockWaitMs', performance.now() - started); }
    if (client !== this.pool && client !== this.queryPool && !this.editLocks.has(client))
      this.editLocks.set(client, { since: performance.now(), profiles });
  }
  lockKey(namespace: string, ...parts: string[]): string {
    return JSON.stringify([this.schema, namespace, ...parts]);
  }
  withOwner<T>(owner: string, operation: () => T): T {
    return this.ownerIsolation ? this.ownerContext.run(owner, operation) : operation();
  }
  async setOwner(client: Sql, owner: string) {
    if (!this.ownerIsolation) return;
    if (client === this.pool || client === this.queryPool) throw new Error('Owner context requires a database transaction');
    await this.query(`SET LOCAL eigos.owner TO ${pg.escapeLiteral(owner)}`, [], client);
    this.transactionOwners.set(client, owner);
  }
  async withTransactionOwner<T>(client: Sql, owner: string, operation: () => Promise<T>): Promise<T> {
    if (!this.ownerIsolation) return operation();
    const prior = this.transactionOwners.get(client) ?? '';
    if (owner === prior) return operation();
    await this.setOwner(client, owner);
    let result: T;
    try { result = await operation(); }
    catch (error) {
      await this.setOwner(client, prior).catch(() => {});
      throw error;
    }
    await this.setOwner(client, prior);
    return result;
  }
  measureQueries<T>(operation: (count: () => number) => Promise<T>) {
    return profileDatabase(profile => operation(() => profile.statements));
  }
  /** Whether this transaction shares the owner's Ontology edit lock because it locks the objects it touches. */
  sharesEditLocks(client: Sql) { return this.sharedEditLocks.has(client); }
  /** Whether this transaction locks the objects it touches instead of the whole owner. */
  objectScoped(client: Sql) { return this.objectScopes.has(client); }
  /** Runs Ontology data statements that the caller has covered with object locks. */
  withObjectAccess<T>(run: () => T): T { return this.objectAccess.run(true, run); }
  /**
   * In an object-scoped transaction, abandons the attempt because an operation's conflicts cannot be bounded
   * by object locks; the transaction then reruns with the exclusive owner lock. Elsewhere it does nothing.
   */
  requireExclusive(client: Sql, reason: string) {
    const scope = this.objectScopes.get(client);
    if (!scope) return;
    scope.escalated ??= reason;
    throw new ExclusiveScopeRequired(reason);
  }
  /** Takes shared or exclusive locks on object keys for the rest of an object-scoped transaction, in key order. */
  async lockObjects(client: Sql, keys: readonly string[], mode: 'shared' | 'exclusive') {
    const scope = this.objectScopes.get(client);
    if (!scope) return;
    const needed = [...new Set(keys)].filter(key => {
      const held = scope.held.get(key);
      return !held || mode === 'exclusive' && held === 'shared';
    }).sort();
    if (!needed.length) return;
    const lock = mode === 'exclusive' ? 'pg_advisory_xact_lock' : 'pg_advisory_xact_lock_shared';
    await this.query(`SELECT ${lock}(hashtextextended(key,0)) FROM unnest($1::text[]) AS keys(key)`, [needed], client);
    for (const key of needed) scope.held.set(key, mode);
  }
  /**
   * Runs an Action commit that locks only what it touches: the owner's edit lock is shared, every object it reads
   * is locked shared and every object it writes, or whose relationships it changes, exclusively, until COMMIT.
   * Commits on unrelated objects therefore proceed in parallel without depending on predicate locks. A set query,
   * an unlocked Ontology data statement or a deadlock reruns the commit once with the exclusive owner lock, which
   * never overlaps shared holders; the escalation also applies when the commit code caught it.
   */
  async objectScopedTransaction<T>(action: (client: PoolClient) => Promise<T>, operation?: string): Promise<T> {
    const profiles = activeProfiles();
    try {
      return await this.transaction(async client => {
        const scope: ObjectScope = { held: new Map() };
        this.objectScopes.set(client, scope);
        this.sharedEditLocks.add(client);
        try {
          const result = await action(client);
          if (scope.escalated) throw new ExclusiveScopeRequired(scope.escalated);
          return result;
        } catch (error) {
          if (scope.escalated && !(error instanceof ExclusiveScopeRequired)) throw new ExclusiveScopeRequired(scope.escalated);
          throw error;
        } finally {
          this.objectScopes.delete(client);
          this.sharedEditLocks.delete(client);
        }
      });
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      const reason = error instanceof ExclusiveScopeRequired ? error.reason : code === '40P01' ? 'deadlock' : undefined;
      if (!reason) throw error;
      chargeProfiles(profiles, 'commitFallbacks', 1);
      recordOperationEvent('commit_fallback', { operation, reason, code: typeof code === 'string' ? code : undefined });
      await delay(Math.random() * 5);
      return this.transaction(action);
    }
  }
  /**
   * Reruns a write transaction that timed out waiting for a lock, after a growing backoff, until `signal` ends
   * or 30 seconds pass. Contention then queues the work instead of failing it at the 2-second lock_timeout; each
   * attempt still releases its connection while it backs off.
   */
  async waitForLocks<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    for (let attempt = 1; ; attempt++) {
      try { return await run(); }
      catch (error) {
        if ((error as { code?: unknown } | null)?.code !== '55P03' || deadline.aborted) throw error;
        await delay(Math.min(1000, 50 * 2 ** attempt) * (0.5 + Math.random() / 2), undefined, { signal: deadline }).catch(() => { throw error; });
      }
    }
  }
  async transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await this.query('BEGIN', [], client);
      await this.query("SET LOCAL lock_timeout='2s'", [], client);
      const owner = this.ownerContext.getStore();
      if (owner) await this.setOwner(client, owner);
      const result = await action(client);
      await this.query('COMMIT', [], client);
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      const held = this.editLocks.get(client);
      if (held) {
        chargeProfiles(held.profiles, 'editLockHoldMs', performance.now() - held.since);
        this.editLocks.delete(client);
      }
      this.transactionOwners.delete(client); client.release();
    }
  }
  private async readTransaction<T extends QueryResultRow>(pool: pg.Pool, text: string, values: unknown[], authority?: {id:string;position:string}) {
    const connection = await pool.connect();
    try {
      await connection.query('BEGIN READ ONLY');
      const owner = this.ownerContext.getStore();
      if (owner) await this.setOwner(connection, owner);
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
    } finally { this.transactionOwners.delete(connection); connection.release(); }
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
      CREATE INDEX IF NOT EXISTS links_forward ON ${s}.links(projection,owner,from_type,from_id,type);
      CREATE UNIQUE INDEX IF NOT EXISTS links_single_from ON ${s}.links(projection,owner,type,from_type,from_id) WHERE single_from;
      CREATE UNIQUE INDEX IF NOT EXISTS links_single_to ON ${s}.links(projection,owner,type,to_type,to_id) WHERE single_to;
      CREATE TABLE IF NOT EXISTS ${s}.actions (owner text NOT NULL, request_id text NOT NULL, digest text NOT NULL, action text NOT NULL, release text NOT NULL REFERENCES ${s}.releases(digest), result jsonb NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner,request_id));
      CREATE INDEX IF NOT EXISTS actions_log_order ON ${s}.actions(owner,release,applied_at DESC,request_id DESC);
      ALTER TABLE ${s}.actions ADD COLUMN IF NOT EXISTS executor_kind text;
      ALTER TABLE ${s}.actions ADD COLUMN IF NOT EXISTS executor_id text;
      ALTER TABLE ${s}.actions ADD COLUMN IF NOT EXISTS task_id uuid;
      CREATE TABLE IF NOT EXISTS ${s}.tasks (id uuid PRIMARY KEY, owner text NOT NULL, request_id text NOT NULL, input_digest text NOT NULL, input jsonb NOT NULL, release text NOT NULL REFERENCES ${s}.releases(digest), scopes jsonb NOT NULL,
        state text NOT NULL DEFAULT 'submitted', token uuid, lease_until timestamptz, result jsonb, error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner,request_id));
      ALTER TABLE ${s}.tasks ADD COLUMN IF NOT EXISTS result_permissions jsonb;
      ALTER TABLE ${s}.tasks ADD COLUMN IF NOT EXISTS available_at timestamptz NOT NULL DEFAULT now();
      ALTER TABLE ${s}.tasks ADD COLUMN IF NOT EXISTS execution_step integer NOT NULL DEFAULT 0;
      ALTER TABLE ${s}.tasks ADD COLUMN IF NOT EXISTS conversation_id text;
      ALTER TABLE ${s}.tasks ADD COLUMN IF NOT EXISTS conversation_batch bigint;
      ALTER TABLE ${s}.tasks ADD COLUMN IF NOT EXISTS message_count integer NOT NULL DEFAULT 1;
      CREATE INDEX IF NOT EXISTS tasks_queue ON ${s}.tasks(state,created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS tasks_conversation_batch ON ${s}.tasks(owner,conversation_id,conversation_batch) WHERE conversation_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS tasks_conversation_pending ON ${s}.tasks(owner,conversation_id,conversation_batch)
        WHERE conversation_id IS NOT NULL AND state IN('submitted','working','input-required');
      CREATE INDEX IF NOT EXISTS tasks_conversation_available ON ${s}.tasks(available_at) WHERE conversation_id IS NOT NULL AND state='submitted';
      CREATE TABLE IF NOT EXISTS ${s}.task_inbox_events (
        owner text NOT NULL, request_id text NOT NULL, input_digest text NOT NULL, message text NOT NULL,
        task_id uuid NOT NULL REFERENCES ${s}.tasks(id), position integer NOT NULL,
        received_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(owner,request_id), UNIQUE(task_id,position));
      CREATE TABLE IF NOT EXISTS ${s}.source_calls (task_id uuid NOT NULL REFERENCES ${s}.tasks(id), name text NOT NULL, state text NOT NULL, input_digest text NOT NULL, result jsonb, PRIMARY KEY(task_id,name));
      ALTER TABLE ${s}.source_calls ADD COLUMN IF NOT EXISTS lease_token uuid;`);
    await initializeAccounts(this);
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
    await this.query(`ALTER TABLE ${s}.tasks ADD COLUMN IF NOT EXISTS workflow_trace jsonb NOT NULL DEFAULT '[]'`);
    await this.query(`ALTER TABLE ${s}.scheduled_actions ADD COLUMN IF NOT EXISTS continue_at timestamptz`);
    await this.query(`ALTER TABLE ${s}.external_operations ADD COLUMN IF NOT EXISTS requirements jsonb NOT NULL DEFAULT '[]'`);

    await initializeOntologyDataMigrations(this);
    await initializeEntityResolution(this);
    await initializeSemantic(this);
    await initializeApplications(this);
    await initializeAutomation(this);
    await initializeObservationInterests(this);
    await initializeMachineryHistory(this);
    await initializeScenarioEvaluations(this);
    await initializeReleaseEvaluation(this);
    await initializeScenarioLifecycle(this);
    await initializeMachineryStates(this);
    await initializeActionUndo(this);
    await initializeSecurity(this);
    await initializeObjectSets(this);
    await initializeGovernance(this);
    await initializeEffects(this);
    await initializeEditHistory(this);
    await initializeExecutionTrace(this);
    await initializeIndexing(this);
    await initializeMaterializations(this);
  }
}
