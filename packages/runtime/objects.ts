import { z } from 'zod';
import { Conflict, NotFound, digest } from '../core/identity.js';
import { PublishedOntology } from './metadata.js';
import { Access } from './access.js';
import { objectRefSchema, type ObjectData, type ObjectRef, type LinkData } from '../ontology/schema.js';
import { Database, type Sql } from './database.js';

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
  private prepareWrite() {
    return this.writeReady ??= (async () => {
      await this.db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', ['publication:' + this.model.document.id], this.client);
      const current = await this.db.query(`SELECT release FROM ${this.db.schema}.ontology WHERE id=$1`, [this.model.document.id], this.client);
      if (current.rows[0]?.release !== this.model.release) throw new Conflict('Historical and prepared projections are read-only');
    })();
  }
  private writeType(type: string) {
    this.access.definition(this.model, 'object', type);
    for (const source of this.model.sources.values()) if (source.objectType === type) {
      const provider = this.model.functions.get(source.function)?.source;
      if (provider) this.access.source(this.model, provider);
    }
  }
  private visible(object: ObjectData): ObjectData {
    return { ...object, properties: Object.fromEntries(Object.entries(object.properties).map(([field, value]) => [field, this.access.property(this.model, object.ref.type, field) ? value : null])) };
  }
  private row(row: Record<string, unknown>): ObjectData {
    const ref = { type: String(row.type), id: String(row.id) };
    const properties = this.model.parseObject(ref, row.properties as Record<string, unknown>);
    return { ref, revision: Number(row.revision), properties };
  }
  private async stored(input: ObjectRef): Promise<ObjectData> {
    const ref = objectRefSchema.parse(input);
    const rows = await this.db.query(`SELECT type,id,revision,properties FROM ${this.db.schema}.objects WHERE owner=$1 AND type=$2 AND id=$3 AND projection=$4`, [this.owner, ref.type, ref.id, this.model.projection], this.client);
    if (!rows.rows[0]) throw new NotFound('Object is unavailable');
    return this.row(rows.rows[0]);
  }
  async read(input: ObjectRef): Promise<ObjectData> {
    this.access.read(this.model, input.type);
    return this.visible(await this.stored(input));
  }
  async query(input: Query) {
    const args = querySchema.parse(input);
    this.access.definition(this.model, this.model.interfaces.has(args.type) ? 'interface' : 'object', args.type);
    const navigation = args.from ? this.model.navigation(args.from.object.type, args.from.link, args.from.as) : undefined;
    if (args.from && navigation) {
      if (args.from.as) this.access.definition(this.model, 'interface', args.from.as);
      this.access.read(this.model, args.from.object.type); this.access.read(this.model, navigation.target);
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
      clauses.push(`EXISTS(SELECT 1 FROM ${this.db.schema}.links l WHERE l.projection=o.projection AND l.owner=o.owner AND l.type=$3 AND l.${source}_type=$4 AND l.${source}_id=$5 AND l.${target}_type=o.type AND l.${target}_id=o.id)`);
    }
    for (const [field, value] of Object.entries(args.where)) {
      const cases: string[] = [];
      for (const type of types) {
        const local = this.model.propertyName(type, args.type, field);
        values.push(type, local && this.access.property(this.model, type, local) ? local : null);
        cases.push(`WHEN type=$${values.length - 1} THEN properties->$${values.length}::text`);
      }
      values.push(JSON.stringify(value));
      clauses.push(`COALESCE((CASE ${cases.join(' ')} END),'null'::jsonb)=$${values.length}::jsonb`);
    }
    const queryDigest = digest({ ...args, cursor: undefined, owner: this.owner, release: this.model.release });
    if (args.cursor) {
      const cursor = z.strictObject({ query: z.literal(queryDigest), type: z.string(), id: z.string() }).parse(JSON.parse(Buffer.from(args.cursor, 'base64url').toString()));
      values.push(cursor.type, cursor.id);
      clauses.push(`(type COLLATE "C",id COLLATE "C")>($${values.length - 1},$${values.length})`);
    }
    values.push(this.model.projection); clauses.push(`projection=$${values.length}`);
    values.push(args.limit + 1);
    const result = await this.db.query(`SELECT type,id,revision,properties FROM ${this.db.schema}.objects o WHERE ${clauses.join(' AND ')} ORDER BY type COLLATE "C",id COLLATE "C" LIMIT $${values.length}`, values, this.client);
    const records = result.rows.slice(0, args.limit).map(row => this.row(row));
    const fields = args.select ?? Object.keys(this.model.interfaces.get(args.type)?.properties ?? this.model.object(args.type).properties);
    const items = records.map(object => ({ ...object, properties: Object.fromEntries(fields.flatMap(field => {
      const local = this.model.propertyName(object.ref.type, args.type, field);
      return local === undefined ? [] : [[field, this.access.property(this.model, object.ref.type, local) ? object.properties[local] : null]];
    })) }));
    const last = records.at(-1)?.ref;
    return { items, cursor: result.rows.length > args.limit && last ? Buffer.from(JSON.stringify({ query: queryDigest, ...last })).toString('base64url') : undefined };
  }
  async follow(ref: ObjectRef, link: string, view = ref.type): Promise<ObjectData[]> {
    if (view !== ref.type) this.access.definition(this.model, 'interface', view);
    const nav = this.model.navigation(ref.type, link, view);
    this.access.read(this.model, ref.type); this.access.read(this.model, nav.target); this.access.definition(this.model, 'link', nav.link);
    const from = nav.forward ? 'from' : 'to', to = nav.forward ? 'to' : 'from';
    const result = await this.db.query(`SELECT o.type,o.id,o.revision,o.properties FROM ${this.db.schema}.links l
      JOIN ${this.db.schema}.objects o ON o.projection=l.projection AND o.owner=l.owner AND o.type=l.${to}_type AND o.id=l.${to}_id
      WHERE l.owner=$1 AND l.type=$2 AND l.${from}_type=$3 AND l.${from}_id=$4 AND l.projection=$5 ORDER BY o.id COLLATE "C" LIMIT 101`, [this.owner, nav.link, ref.type, ref.id, this.model.projection], this.client);
    if (result.rows.length > 100) throw new Error('Relationship exceeds the complete read limit');
    return result.rows.map(row => this.visible(this.row(row)));
  }
  async create(ref: ObjectRef, input: Record<string, unknown>): Promise<void> {
    if (this.client === this.db.pool) return this.db.transaction(client => new Objects(this.db, this.model, this.access, client).create(ref, input));
    this.writeType(ref.type); await this.prepareWrite();
    const properties = this.model.parseObject(ref, input);
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
    const rows = edges.map(edge => {
      this.access.definition(this.model, 'link', edge.type); this.writeType(edge.from.type); this.writeType(edge.to.type);
      const definition = this.model.links.get(edge.type);
      if (!definition || edge.from.type !== definition.from.type || edge.to.type !== definition.to.type) throw new Error('Invalid link endpoints');
      return { type: edge.type, from_type: edge.from.type, from_id: edge.from.id, to_type: edge.to.type, to_id: edge.to.id, single_from: definition.from.cardinality === 'one', single_to: definition.to.cardinality === 'one' };
    });
    await this.db.query(`INSERT INTO ${this.db.schema}.links(owner,type,from_type,from_id,to_type,to_id,single_from,single_to,projection)
      SELECT $1,type,from_type,from_id,to_type,to_id,single_from,single_to,$3 FROM jsonb_to_recordset($2::jsonb)
      AS input(type text,from_type text,from_id text,to_type text,to_id text,single_from boolean,single_to boolean)
      ON CONFLICT(projection,owner,type,from_type,from_id,to_type,to_id) DO NOTHING`, [this.owner, JSON.stringify(rows), this.model.projection], this.client);
  }
}
