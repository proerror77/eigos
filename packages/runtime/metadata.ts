import { copyEditState } from './edit-history.js';
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
    const edits = (await this.db.query(`SELECT
      (SELECT md5(coalesce(string_agg(md5(row(owner,type,id,source,properties,observed_at)::text),'' ORDER BY owner,type,id,source),'')) FROM ${this.db.schema}.source_values WHERE projection=$1) AS sources,
      (SELECT md5(coalesce(string_agg(md5(row(owner,type,id,overrides,deleted,created)::text),'' ORDER BY owner,type,id),'')) FROM ${this.db.schema}.object_edits WHERE projection=$1) AS edits,
      (SELECT md5(coalesce(string_agg(row(ontology,type,policy)::text,'' ORDER BY ontology,type),'')) FROM ${this.db.schema}.edit_policies) AS policies`,[projection],client)).rows[0];
    return digest({row,edits});
  }
  async prepare(input: unknown, bindings: Bindings, access: Access, transform?: ProjectionTransform, permissionTarget?: string): Promise<PublishedOntology> {
    const model = new Ontology(input);
    await access.refresh(); access.require(model.document.id, 'edit_definition', permissionTarget ?? model.document.id);
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
      if (current) await copyEditState(this.db,current.projection,projection,client,[...model.objects.keys()]);
      await access.refresh(client);
      await this.db.query(`INSERT INTO ${this.db.schema}.releases(digest,body,definition_digest,projection,runtime_id,bindings,state,prepared_from,source_fingerprint,projection_fingerprint)
        VALUES($1,$2,$3,$4,$5,$6,'prepared',$7,$8,$9)`, [release, model.document, model.digest, projection, this.db.runtimeId, manifest, current?.digest ?? null, fingerprint, await this.fingerprint(projection, client)], client);
    });
    return this.get(release);
  }
  async activate(release: string, bindings: Bindings, access: Access, transaction?: Sql) {
    const model = await this.get(release);
    await access.refresh(); access.require(model.document.id, 'manage_definition', model.document.id);
    this.checkBindings(model, bindings);
    const activate = async (client: Sql) => {
      await this.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['publication:' + model.document.id], client);
      const current = (await this.db.query(`SELECT release FROM ${this.db.schema}.ontology WHERE id=$1 FOR UPDATE`, [model.document.id], client)).rows[0]?.release;
      const prepared = (await this.db.query(`SELECT * FROM ${this.db.schema}.releases WHERE digest=$1`, [release], client)).rows[0]!;
      if (current === release) return;
      if (prepared.state !== 'prepared' || (prepared.prepared_from ?? null) !== (current ?? null)) throw new Conflict('Prepare against the current live release before activation');
      const running = await this.db.query(`SELECT 1 FROM ${this.db.schema}.tasks t JOIN ${this.db.schema}.releases r ON r.digest=t.release WHERE r.body->>'id'=$1 AND t.state IN('submitted','working','input-required') LIMIT 1`, [model.document.id], client);
      if (running.rowCount) throw new Conflict('Complete or cancel unfinished tasks before changing their publication');
      const indexing = await this.db.query(`SELECT 1 FROM ${this.db.schema}.index_transactions WHERE ontology=$1 AND state IN ('pending','failed') LIMIT 1`,[model.document.id],client);
      if (indexing.rowCount) throw new Conflict('Resolve pending or failed source transactions before activation');
      if (current && await this.fingerprint((await this.get(current)).projection, client) !== prepared.source_fingerprint) throw new Conflict('Source data changed; rebuild the candidate projection');
      if (await this.fingerprint(model.projection, client) !== prepared.projection_fingerprint) throw new Conflict('Prepared projection changed');
      await access.refresh(client);
      if (current) await this.db.query(`UPDATE ${this.db.schema}.releases SET state='retired' WHERE digest=$1`, [current], client);
      await this.db.query(`INSERT INTO ${this.db.schema}.ontology(id,release) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET release=excluded.release`, [model.document.id, release], client);
      await this.db.query(`UPDATE ${this.db.schema}.releases SET state='active' WHERE digest=$1`, [release], client);
    };
    if (transaction) await activate(transaction); else await this.db.transaction(activate);
    return model;
  }
  async catchUp(release: string, bindings: Bindings, access: Access, permissionTarget?: string, transaction?: Sql) {
    const candidate = await this.get(release);
    this.checkBindings(candidate, bindings);
    await access.refresh(); access.require(candidate.document.id, 'edit_definition', permissionTarget ?? candidate.document.id);
    const synchronize = async (client: Sql) => {
      await this.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['publication:' + candidate.document.id], client);
      const stored = (await this.db.query(`SELECT * FROM ${this.db.schema}.releases WHERE digest=$1 FOR UPDATE`, [release], client)).rows[0]!;
      const live = await this.active(candidate.document.id, client);
      if (stored.state !== 'prepared' || stored.prepared_from !== live.release) throw new Conflict('Candidate base changed; rebase before catching up');
      if (await this.fingerprint(candidate.projection, client) !== stored.projection_fingerprint) throw new Conflict('Prepared projection changed');
      const types = [...candidate.objects.keys()], links = [...candidate.links.keys()];
      // Remove outdated edges before objects, preserving foreign-key validity throughout catch-up.
      await this.db.query(`DELETE FROM ${this.db.schema}.links target WHERE target.projection=$1 AND NOT EXISTS(
        SELECT 1 FROM ${this.db.schema}.links source WHERE source.projection=$2 AND source.owner=target.owner AND source.type=target.type
        AND source.from_type=target.from_type AND source.from_id=target.from_id AND source.to_type=target.to_type AND source.to_id=target.to_id)`, [candidate.projection,live.projection], client);
      await this.db.query(`DELETE FROM ${this.db.schema}.objects target WHERE target.projection=$1 AND NOT EXISTS(
        SELECT 1 FROM ${this.db.schema}.objects source WHERE source.projection=$2 AND source.owner=target.owner AND source.type=target.type AND source.id=target.id)`, [candidate.projection,live.projection], client);
      let cursor: string[] | null = null;
      let updated = 0;
      for (;;) {
        const rows: Record<string, any>[] = (await this.db.query(`SELECT source.owner,source.type,source.id,source.revision,source.properties FROM ${this.db.schema}.objects source
          LEFT JOIN ${this.db.schema}.objects target ON target.projection=$1 AND target.owner=source.owner AND target.type=source.type AND target.id=source.id
          WHERE source.projection=$2 AND source.type=ANY($3::text[]) AND (target.id IS NULL OR source.revision IS DISTINCT FROM target.revision OR source.properties IS DISTINCT FROM target.properties)
          AND ($4::text[] IS NULL OR (source.owner,source.type,source.id)>($4[1],$4[2],$4[3])) ORDER BY source.owner,source.type,source.id LIMIT 500`, [candidate.projection,live.projection,types,cursor], client)).rows;
        if (!rows.length) break;
        const projected = rows.map(row => ({ ...row, properties: candidate.parseObject({type:row.type,id:row.id}, Object.fromEntries(Object.entries(row.properties).filter(([name])=>candidate.object(row.type).properties[name]))) }));
        await this.db.query(`INSERT INTO ${this.db.schema}.objects(projection,owner,type,id,revision,properties)
          SELECT $1,owner,type,id,revision,properties FROM jsonb_to_recordset($2::jsonb) AS r(owner text,type text,id text,revision bigint,properties jsonb)
          ON CONFLICT(projection,owner,type,id) DO UPDATE SET revision=excluded.revision,properties=excluded.properties`, [candidate.projection,JSON.stringify(projected)], client);
        updated += rows.length;
        const last=rows.at(-1)!; cursor=[last.owner,last.type,last.id];
      }
      const edges=(await this.db.query(`SELECT source.* FROM ${this.db.schema}.links source WHERE source.projection=$1 AND source.type=ANY($2::text[]) AND NOT EXISTS(
        SELECT 1 FROM ${this.db.schema}.links target WHERE target.projection=$3 AND target.owner=source.owner AND target.type=source.type
        AND target.from_type=source.from_type AND target.from_id=source.from_id AND target.to_type=source.to_type AND target.to_id=source.to_id)`,[live.projection,links,candidate.projection],client)).rows;
      for(let offset=0;offset<edges.length;offset+=500) {
        const mapped=edges.slice(offset,offset+500).map(row=>{const link=candidate.links.get(row.type)!;
          if(link.from.type!==row.from_type||link.to.type!==row.to_type)throw new Conflict('Link endpoints need a compatible source projection');
          return {...row,single_from:link.from.cardinality==='one',single_to:link.to.cardinality==='one'};
        });
        await this.db.query(`INSERT INTO ${this.db.schema}.links(projection,owner,type,from_type,from_id,to_type,to_id,single_from,single_to)
          SELECT $1,owner,type,from_type,from_id,to_type,to_id,single_from,single_to FROM jsonb_to_recordset($2::jsonb)
          AS r(owner text,type text,from_type text,from_id text,to_type text,to_id text,single_from boolean,single_to boolean)`,[candidate.projection,JSON.stringify(mapped)],client);
      }
      await copyEditState(this.db,live.projection,candidate.projection,client,types);
      await access.refresh(client);
      await this.db.query(`UPDATE ${this.db.schema}.releases SET source_fingerprint=$2,projection_fingerprint=$3 WHERE digest=$1`,[release,await this.fingerprint(live.projection,client),await this.fingerprint(candidate.projection,client)],client);
      return {release,projection:candidate.projection,objectsUpdated:updated,linksAdded:edges.length};
    };
    return transaction ? synchronize(transaction) : this.db.transaction(synchronize);
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
