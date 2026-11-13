import { z } from 'zod';
import { Conflict, NotFound, digest } from '../core/identity.js';
import { PublishedOntology } from './metadata.js';
import { Access } from './access.js';
import { objectRefSchema, type ObjectData, type ObjectRef, type LinkData } from '../ontology/schema.js';
import { Database, type Sql } from './database.js';
import { checkScenario, lockEdits, viewTables, stageObject, stageLink } from './scenario-store.js';

export const querySchema = z.strictObject({
  type: z.string(), where: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  select: z.array(z.string()).max(30).optional(), limit: z.number().int().min(1).max(100).default(50), cursor: z.string().optional(),
  from: z.strictObject({ object: objectRefSchema, link: z.string(), as: z.string().optional() }).optional(),
});
export type Query = z.input<typeof querySchema>;
export class Objects {
  constructor(readonly db: Database, readonly model: PublishedOntology, readonly access: Access, readonly client: Sql = db.pool) {}
  get owner() { return this.access.principal.owner; }
  private writeReady?: Promise<void>;
  async lockWrites() { await this.prepareWrite(); }
  private prepareWrite() {
    return this.writeReady ??= (async () => {
      await lockEdits(this.db, this.model, this.owner, this.client);
      await checkScenario(this.db, this.model, this.owner, this.client, true);
    })();
  }
  private writeType(type: string) {
    this.access.definition(this.model, 'object', type);
    for (const source of this.model.sources.values()) if (source.objectType === type) {
      const provider = this.model.functions.get(source.function)?.source;
      if (provider) this.access.source(this.model, provider);
    }
  }
  maskSnapshot(ref: ObjectRef, properties: Record<string, unknown>): Record<string, unknown> | null {
    this.access.read(this.model,ref.type);
    if (!this.access.rowAllowed(this.model,ref.type,properties)) return null;
    this.access.readRow(this.model,ref.type,properties);
    return Object.fromEntries(Object.entries(properties).map(([field,value])=>[field,this.access.cell(this.model,ref.type,field,properties)?value:null]));
  }
  private visible(object: ObjectData): ObjectData {
    this.access.readRow(this.model,object.ref.type,object.properties);
    return { ...object, properties: this.maskSnapshot(object.ref,object.properties)! };
  }
  private row(row: Record<string, unknown>): ObjectData {
    const ref = { type: String(row.type), id: String(row.id) };
    const properties = this.model.parseObject(ref, row.properties as Record<string, unknown>);
    return { ref, revision: Number(row.revision), properties };
  }
  private async stored(input: ObjectRef): Promise<ObjectData> {
    const ref = objectRefSchema.parse(input);
    await checkScenario(this.db, this.model, this.owner, this.client);
    const values: unknown[] = [this.owner, ref.type, ref.id, this.model.projection], tables = viewTables(this.db, this.model, this.owner, values);
    const rows = await this.db.readQuery(`${tables.prefix}SELECT type,id,revision,properties FROM ${tables.objects} WHERE owner=$1 AND type=$2 AND id=$3 AND projection=$4`, values, this.client);
    if (!rows.rows[0]) throw new NotFound('Object is unavailable');
    return this.row(rows.rows[0]);
  }
  async read(input: ObjectRef): Promise<ObjectData> {
    this.access.read(this.model, input.type);
    return this.visible(await this.stored(input));
  }
  async query(input: Query) {
    await checkScenario(this.db, this.model, this.owner, this.client);
    const args = querySchema.parse(input);
    this.access.definition(this.model, this.model.interfaces.has(args.type) ? 'interface' : 'object', args.type);
    const navigation = args.from ? this.model.navigation(args.from.object.type, args.from.link, args.from.as) : undefined;
    if (args.from && navigation) {
      if (args.from.as) this.access.definition(this.model, 'interface', args.from.as);
      await this.read(args.from.object); this.access.read(this.model, navigation.target);
      this.access.definition(this.model, 'link', navigation.link);
    }
    const types = this.model.concreteTypes(args.type).filter(type => (!navigation || type === navigation.target) && this.access.canRead(this.model, type));
    types.forEach(type => this.access.read(this.model, type));
    if (!types.length) return { items: [], cursor: undefined };
    const values: unknown[] = [this.owner, types];
    const clauses = ['owner=$1', 'type=ANY($2::text[])'];
    if (args.from) {
      const nav = navigation!;
      const source = nav.forward ? 'from' : 'to', target = nav.forward ? 'to' : 'from';
      values.push(nav.link, args.from.object.type, args.from.object.id);
      clauses.push(`EXISTS(SELECT 1 FROM ${this.model.scenario ? 'view_links' : this.db.schema + '.links'} l WHERE l.projection=o.projection AND l.owner=o.owner AND l.type=$3 AND l.${source}_type=$4 AND l.${source}_id=$5 AND l.${target}_type=o.type AND l.${target}_id=o.id)`);
    }
    for (const [field, value] of Object.entries(args.where)) {
      const cases: string[] = [];
      for (const type of types) {
        const local = this.model.propertyName(type, args.type, field);
        values.push(type); const typeParameter = values.length;
        const allowed = local ? this.access.cellSql(this.model,type,local,values) : 'FALSE';
        values.push(local ?? null);
        cases.push(`WHEN type=$${typeParameter} AND ${allowed} THEN properties->$${values.length}::text`);
      }
      values.push(JSON.stringify(value));
      clauses.push(`COALESCE((CASE ${cases.join(' ')} END),'null'::jsonb)=$${values.length}::jsonb`);
    }
    const queryDigest = digest({ ...args, cursor: undefined, owner: this.owner, release: this.model.release, scenario: this.model.scenario });
    if (args.cursor) {
      const cursor = z.strictObject({ query: z.literal(queryDigest), type: z.string(), id: z.string() }).parse(JSON.parse(Buffer.from(args.cursor, 'base64url').toString()));
      values.push(cursor.type, cursor.id);
      clauses.push(`(type COLLATE "C",id COLLATE "C")>($${values.length - 1},$${values.length})`);
    }
    const policyCases = types.map(type => {
      values.push(type); const parameter = values.length;
      return `(type=$${parameter} AND ${this.access.rowSql(this.model,type,values)})`;
    });
    clauses.push('('+policyCases.join(' OR ')+')');
    values.push(this.model.projection); clauses.push(`projection=$${values.length}`);
    values.push(args.limit + 1);
    const limitParameter = values.length, tables = viewTables(this.db, this.model, this.owner, values);
    const result = await this.db.readQuery(`${tables.prefix}SELECT type,id,revision,properties FROM ${tables.objects} o WHERE ${clauses.join(' AND ')} ORDER BY type COLLATE "C",id COLLATE "C" LIMIT $${limitParameter}`, values, this.client);
    const records = result.rows.slice(0, args.limit).map(row => this.row(row));
    const fields = args.select ?? Object.keys(this.model.interfaces.get(args.type)?.properties ?? this.model.object(args.type).properties);
    const items = records.map(object => { this.access.readRow(this.model,object.ref.type,object.properties); return { ...object, properties: Object.fromEntries(fields.flatMap(field => {
      const local = this.model.propertyName(object.ref.type, args.type, field);
      return local === undefined ? [] : [[field, this.access.cell(this.model, object.ref.type, local, object.properties) ? object.properties[local] : null]];
    })) }; });
    const last = records.at(-1)?.ref;
    return { items, cursor: result.rows.length > args.limit && last ? Buffer.from(JSON.stringify({ query: queryDigest, ...last })).toString('base64url') : undefined };
  }
  async follow(ref: ObjectRef, link: string, view = ref.type): Promise<ObjectData[]> {
    if (view !== ref.type) this.access.definition(this.model, 'interface', view);
    const nav = this.model.navigation(ref.type, link, view);
    await this.read(ref); this.access.read(this.model, nav.target); this.access.definition(this.model, 'link', nav.link);
    const from = nav.forward ? 'from' : 'to', to = nav.forward ? 'to' : 'from';
    await checkScenario(this.db, this.model, this.owner, this.client);
    const values: unknown[] = [this.owner, nav.link, ref.type, ref.id, this.model.projection];
    const policy = this.access.rowSql(this.model,nav.target,values,'o.properties');
    const tables = viewTables(this.db, this.model, this.owner, values);
    const result = await this.db.readQuery(`${tables.prefix}SELECT o.type,o.id,o.revision,o.properties FROM ${tables.links} l
      JOIN ${tables.objects} o ON o.projection=l.projection AND o.owner=l.owner AND o.type=l.${to}_type AND o.id=l.${to}_id
      WHERE l.owner=$1 AND l.type=$2 AND l.${from}_type=$3 AND l.${from}_id=$4 AND l.projection=$5 AND ${policy} ORDER BY o.id COLLATE "C" LIMIT 101`, values, this.client);
    if (result.rows.length > 100) throw new Error('Relationship exceeds the complete read limit');
    return result.rows.map(row => this.visible(this.row(row)));
  }
  async create(ref: ObjectRef, input: Record<string, unknown>): Promise<void> {
    if (this.client === this.db.pool) return this.db.transaction(client => new Objects(this.db, this.model, this.access, client).create(ref, input));
    this.writeType(ref.type); await this.prepareWrite();
    const properties = this.model.parseObject(ref, input);
    this.access.writeRow(this.model,ref.type,properties);
    if (this.model.scenario) {
      const old = await this.stored(ref).catch(error => { if (error instanceof NotFound) return undefined; throw error; });
      if (old) { if (digest(old.properties) !== digest(properties)) throw new Conflict('Object identity already contains different data'); return; }
      await stageObject(this.db, this.model, this.owner, ref, 1, properties, this.client); return;
    }
    const result = await this.db.query(`INSERT INTO ${this.db.schema}.objects(owner,type,id,properties,projection) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id`, [this.owner, ref.type, ref.id, properties, this.model.projection], this.client);
    if (!result.rowCount) {
      if (digest((await this.stored(ref)).properties) !== digest(properties)) throw new Conflict('Object identity already contains different data');
    }
  }
  async ingestBatch(input: readonly { ref: ObjectRef; properties: Record<string, unknown> }[]): Promise<void> {
    if (this.client === this.db.pool) return this.db.transaction(client => new Objects(this.db, this.model, this.access, client).ingestBatch(input));
    for (const item of input) this.writeType(item.ref.type);
    await this.prepareWrite();
    if (!input.length) return;
    if (this.model.scenario) throw new Conflict('Source ingestion is unavailable inside a scenario');
    const unique = new Map<string, { type: string; id: string; properties: Record<string, unknown> }>();
    for (const item of input) {
      const row = { ...item.ref, properties: this.model.parseObject(item.ref, item.properties) }, key = JSON.stringify(item.ref);
      const previous = unique.get(key);
      if (previous && digest(previous) !== digest(row)) throw new Conflict('Source rows disagree about one object');
      unique.set(key, row);
    }
    await this.db.query(`INSERT INTO ${this.db.schema}.objects AS o(owner,type,id,properties,projection)
      SELECT $1,type,id,properties,$3 FROM jsonb_to_recordset($2::jsonb) AS input(type text,id text,properties jsonb)
      ON CONFLICT(projection,owner,type,id) DO UPDATE SET properties=excluded.properties,revision=o.revision+1
      WHERE o.properties IS DISTINCT FROM excluded.properties AND o.properties->>'observedAt' <= excluded.properties->>'observedAt'`, [this.owner, JSON.stringify([...unique.values()]), this.model.projection], this.client);
  }
  async edit(ref: ObjectRef, revision: number, fields: Record<string, unknown>): Promise<void> {
    if (this.client === this.db.pool) return this.db.transaction(client => new Objects(this.db, this.model, this.access, client).edit(ref, revision, fields));
    this.writeType(ref.type); await this.prepareWrite();
    const old = await this.stored(ref), properties = this.model.parseObject(ref, { ...old.properties, ...fields });
    this.access.readRow(this.model,ref.type,old.properties);
    for (const field of Object.keys(fields)) if (!this.access.cell(this.model,ref.type,field,old.properties)) throw new Error('Cannot edit a hidden property');
    this.access.writeRow(this.model,ref.type,properties);
    if (old.revision !== revision) throw new Conflict('Object revision changed');
    if (this.model.scenario) { await stageObject(this.db, this.model, this.owner, ref, revision + 1, properties, this.client); return; }
    const result = await this.db.query(`UPDATE ${this.db.schema}.objects SET properties=$4,revision=revision+1 WHERE owner=$1 AND type=$2 AND id=$3 AND revision=$5 AND projection=$6`, [this.owner, ref.type, ref.id, properties, revision, this.model.projection], this.client);
    if (!result.rowCount) throw new Conflict('Object revision changed');
  }
  async link(edge: LinkData) {
    return this.linkBatch([edge]);
  }
  async linkBatch(edges: readonly LinkData[]): Promise<void> {
    if (this.client === this.db.pool) return this.db.transaction(client => new Objects(this.db, this.model, this.access, client).linkBatch(edges));
    await this.prepareWrite();
    if (!edges.length) return;
    for (const edge of edges) { await this.read(edge.from); await this.read(edge.to); }
    const rows = edges.map(edge => {
      this.access.definition(this.model, 'link', edge.type); this.writeType(edge.from.type); this.writeType(edge.to.type);
      const definition = this.model.links.get(edge.type);
      if (!definition || edge.from.type !== definition.from.type || edge.to.type !== definition.to.type) throw new Error('Invalid link endpoints');
      return { type: edge.type, from_type: edge.from.type, from_id: edge.from.id, to_type: edge.to.type, to_id: edge.to.id, single_from: definition.from.cardinality === 'one', single_to: definition.to.cardinality === 'one' };
    });
    if (this.model.scenario) {
      for (const edge of edges) {
        await this.stored(edge.from); await this.stored(edge.to);
        const definition = this.model.links.get(edge.type)!;
        const from = await this.follow(edge.from, definition.from.name), to = await this.follow(edge.to, definition.to.name);
        if (definition.from.cardinality === 'one' && from.some(item => digest(item.ref) !== digest(edge.to)) || definition.to.cardinality === 'one' && to.some(item => digest(item.ref) !== digest(edge.from))) throw new Conflict('Link cardinality exceeded');
        await stageLink(this.db, this.model, this.owner, edge, false, this.client);
      }
      return;
    }
    await this.db.query(`INSERT INTO ${this.db.schema}.links(owner,type,from_type,from_id,to_type,to_id,single_from,single_to,projection)
      SELECT $1,type,from_type,from_id,to_type,to_id,single_from,single_to,$3 FROM jsonb_to_recordset($2::jsonb)
      AS input(type text,from_type text,from_id text,to_type text,to_id text,single_from boolean,single_to boolean)
      ON CONFLICT(projection,owner,type,from_type,from_id,to_type,to_id) DO NOTHING`, [this.owner, JSON.stringify(rows), this.model.projection], this.client);
  }
  async unlink(edge: LinkData): Promise<void> {
    if (this.client === this.db.pool) return this.db.transaction(client => new Objects(this.db, this.model, this.access, client).unlink(edge));
    await this.prepareWrite(); this.access.definition(this.model, 'link', edge.type);
    await this.read(edge.from); await this.read(edge.to);
    this.writeType(edge.from.type); this.writeType(edge.to.type);
    const definition = this.model.links.get(edge.type);
    if (!definition || definition.from.type !== edge.from.type || definition.to.type !== edge.to.type) throw new Error('Invalid link endpoints');
    if (this.model.scenario) return stageLink(this.db, this.model, this.owner, edge, true, this.client);
    await this.db.query(`DELETE FROM ${this.db.schema}.links WHERE projection=$1 AND owner=$2 AND type=$3 AND from_type=$4 AND from_id=$5 AND to_type=$6 AND to_id=$7`, [this.model.projection, this.owner, edge.type, edge.from.type, edge.from.id, edge.to.type, edge.to.id], this.client);
  }
  async remove(ref: ObjectRef, revision: number): Promise<void> {
    if (this.client === this.db.pool) return this.db.transaction(client => new Objects(this.db, this.model, this.access, client).remove(ref, revision));
    await this.prepareWrite(); this.writeType(ref.type);
    const old = await this.stored(ref);
    this.access.readRow(this.model,ref.type,old.properties);
    for (const field of Object.keys(old.properties)) if (!this.access.cell(this.model,ref.type,field,old.properties)) throw new Error('Cannot delete an object with hidden properties');
    if (old.revision !== revision) throw new Conflict('Object revision changed');
    for (const link of this.model.links.values()) {
      for (const side of ['from', 'to'] as const) if (link[side].type === ref.type) {
        const others = await this.follow(ref, link[side].name);
        for (const other of others) await this.unlink({ type: link.apiName, from: side === 'from' ? ref : other.ref, to: side === 'to' ? ref : other.ref });
      }
    }
    if (this.model.scenario) return stageObject(this.db, this.model, this.owner, ref, revision + 1, null, this.client);
    await this.db.query(`DELETE FROM ${this.db.schema}.objects WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4 AND revision=$5`, [this.model.projection, this.owner, ref.type, ref.id, revision], this.client);
  }

}
