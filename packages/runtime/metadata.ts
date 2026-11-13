import { randomUUID } from 'node:crypto';
import { digest, Conflict } from '../core/identity.js';
import { Ontology } from '../ontology/model.js';
import type { ObjectRef } from '../ontology/schema.js';
import { Database, type Sql } from './database.js';
import { Access } from './access.js';

export interface BindingManifest { functions: Record<string, string>; sources: Record<string, string> }
export interface Bindings { describe(model: Ontology): BindingManifest }
export class PublishedOntology extends Ontology {
  constructor(body: unknown, readonly release: string, readonly projection: string, readonly runtimeId: string, readonly bindings: BindingManifest, readonly scenario?: string) { super(body); }
}
export type ProjectionTransform = (ref: ObjectRef, properties: Record<string, unknown>) => Record<string, unknown>;

export class Metadata {
  private readonly models = new Map<string, PublishedOntology>();
  constructor(private readonly db: Database) {}
  async fingerprint(projection: string, client: Sql = this.db.pool): Promise<string> {
    const row = (await this.db.query(`SELECT
      (SELECT md5(coalesce(string_agg(md5(row(owner,type,id,revision,properties)::text),'' ORDER BY owner,type,id),'')) FROM ${this.db.schema}.objects WHERE projection=$1) AS objects,
      (SELECT md5(coalesce(string_agg(md5(row(owner,type,from_type,from_id,to_type,to_id,single_from,single_to)::text),'' ORDER BY owner,type,from_type,from_id,to_type,to_id),'')) FROM ${this.db.schema}.links WHERE projection=$1) AS links`, [projection], client)).rows[0]!;
    return digest(row);
  }
  async prepare(input: unknown, bindings: Bindings, access: Access, transform?: ProjectionTransform): Promise<PublishedOntology> {
    const model = new Ontology(input);
    await access.refresh(); access.require(model.document.id, 'manage_definition', model.document.id);
    const manifest = bindings.describe(model), projection = randomUUID();
    const release = digest({ definition: model.digest, runtime: this.db.runtimeId, manifest, projection });
    await this.db.transaction(async client => {
      await this.db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', [], client);
      const current = (await this.db.query(`SELECT r.digest,r.projection FROM ${this.db.schema}.ontology o JOIN ${this.db.schema}.releases r ON r.digest=o.release WHERE o.id=$1`, [model.document.id], client)).rows[0];
      if (current && !current.projection) throw new Conflict('Upgrade the existing data before preparing a release');
      const fingerprint = current ? await this.fingerprint(current.projection, client) : null;
      if (current) {
        const rows = await this.db.query(`SELECT owner,type,id,revision,properties FROM ${this.db.schema}.objects WHERE projection=$1 ORDER BY owner,type,id`, [current.projection], client);
        const projected = rows.rows.filter(row => model.objects.has(row.type)).map(row => {
          const fields = Object.fromEntries(Object.entries(row.properties).filter(([name]) => model.object(row.type).properties[name]));
          return { ...row, properties: model.parseObject({ type: row.type, id: row.id }, transform ? transform({ type: row.type, id: row.id }, structuredClone(row.properties)) : fields) };
        });
        for (let offset = 0; offset < projected.length; offset += 500) await this.db.query(`INSERT INTO ${this.db.schema}.objects(projection,owner,type,id,revision,properties)
          SELECT $1,owner,type,id,revision,properties FROM jsonb_to_recordset($2::jsonb) AS r(owner text,type text,id text,revision bigint,properties jsonb)`, [projection, JSON.stringify(projected.slice(offset, offset + 500))], client);
        const links = (await this.db.query(`SELECT owner,type,from_type,from_id,to_type,to_id FROM ${this.db.schema}.links WHERE projection=$1`, [current.projection], client)).rows.filter(row => model.links.has(row.type));
        const mapped = links.map(row => {
          const link = model.links.get(row.type)!;
          if (link.from.type !== row.from_type || link.to.type !== row.to_type) throw new Conflict('Link endpoints need a compatible source projection');
          return { ...row, single_from: link.from.cardinality === 'one', single_to: link.to.cardinality === 'one' };
        });
        for (let offset = 0; offset < mapped.length; offset += 500) await this.db.query(`INSERT INTO ${this.db.schema}.links(projection,owner,type,from_type,from_id,to_type,to_id,single_from,single_to)
          SELECT $1,owner,type,from_type,from_id,to_type,to_id,single_from,single_to FROM jsonb_to_recordset($2::jsonb) AS r(owner text,type text,from_type text,from_id text,to_type text,to_id text,single_from boolean,single_to boolean)`, [projection, JSON.stringify(mapped.slice(offset, offset + 500))], client);
      }
      await access.refresh(client);
      await this.db.query(`INSERT INTO ${this.db.schema}.releases(digest,body,definition_digest,projection,runtime_id,bindings,state,prepared_from,source_fingerprint,projection_fingerprint)
        VALUES($1,$2,$3,$4,$5,$6,'prepared',$7,$8,$9)`, [release, model.document, model.digest, projection, this.db.runtimeId, manifest, current?.digest ?? null, fingerprint, await this.fingerprint(projection, client)], client);
    });
    return this.get(release);
  }
  async activate(release: string, bindings: Bindings, access: Access) {
    const model = await this.get(release);
    await access.refresh(); access.require(model.document.id, 'manage_definition', model.document.id);
    this.checkBindings(model, bindings);
    await this.db.transaction(async client => {
      await this.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['publication:' + model.document.id], client);
      const current = (await this.db.query(`SELECT release FROM ${this.db.schema}.ontology WHERE id=$1 FOR UPDATE`, [model.document.id], client)).rows[0]?.release;
      const prepared = (await this.db.query(`SELECT * FROM ${this.db.schema}.releases WHERE digest=$1`, [release], client)).rows[0]!;
      if (current === release) return;
      if (prepared.state !== 'prepared' || (prepared.prepared_from ?? null) !== (current ?? null)) throw new Conflict('Prepare against the current live release before activation');
      const running = await this.db.query(`SELECT 1 FROM ${this.db.schema}.tasks t JOIN ${this.db.schema}.releases r ON r.digest=t.release WHERE r.body->>'id'=$1 AND t.state IN('submitted','working','input-required') LIMIT 1`, [model.document.id], client);
      if (running.rowCount) throw new Conflict('Complete or cancel unfinished tasks before changing their publication');
      if (current && await this.fingerprint((await this.get(current)).projection, client) !== prepared.source_fingerprint) throw new Conflict('Source data changed; rebuild the candidate projection');
      if (await this.fingerprint(model.projection, client) !== prepared.projection_fingerprint) throw new Conflict('Prepared projection changed');
      await access.refresh(client);
      if (current) await this.db.query(`UPDATE ${this.db.schema}.releases SET state='retired' WHERE digest=$1`, [current], client);
      await this.db.query(`INSERT INTO ${this.db.schema}.ontology(id,release) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET release=excluded.release`, [model.document.id, release], client);
      await this.db.query(`UPDATE ${this.db.schema}.releases SET state='active' WHERE digest=$1`, [release], client);
    });
    return model;
  }
  async publish(input: unknown, bindings: Bindings, access: Access, transform?: ProjectionTransform) { return this.activate((await this.prepare(input, bindings, access, transform)).release, bindings, access); }
  checkBindings(model: PublishedOntology, bindings: Bindings) {
    if (model.runtimeId !== this.db.runtimeId || digest(model.bindings) !== digest(bindings.describe(model))) throw new Conflict('The publication does not match this runtime implementation');
  }
  async active(id = 'Eigos', client?: Sql, lock = false): Promise<PublishedOntology> {
    if (lock) await this.db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', ['publication:' + id], client);
    const result = await this.db.query(`SELECT release FROM ${this.db.schema}.ontology WHERE id=$1`, [id], client);
    if (!result.rows[0]) throw new Error('Publish the ontology before starting the runtime');
    return this.get(String(result.rows[0].release), client);
  }
  async get(release: string, client?: Sql): Promise<PublishedOntology> {
    const cached = this.models.get(release); if (cached) return cached;
    const row = (await this.db.query(`SELECT * FROM ${this.db.schema}.releases WHERE digest=$1`, [release], client)).rows[0];
    if (!row?.projection) throw new Error('Published projection is unavailable');
    const model = new PublishedOntology(row.body, release, row.projection, row.runtime_id, row.bindings);
    if (model.digest !== row.definition_digest) throw new Error('Ontology release content differs');
    if (this.models.size >= 16) this.models.delete(this.models.keys().next().value!);
    this.models.set(release, model); return model;
  }
}
