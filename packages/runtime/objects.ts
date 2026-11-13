import { z } from 'zod';
import { Conflict, NotFound, digest } from '../core/identity.js';
import { Ontology } from '../ontology/model.js';
import { objectRefSchema, type ObjectData, type ObjectRef, type LinkData } from '../ontology/schema.js';
import { Database, type Sql } from './database.js';

export const querySchema = z.strictObject({
  type: z.string(), where: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  select: z.array(z.string()).max(30).optional(), limit: z.number().int().min(1).max(100).default(50), cursor: z.string().optional(),
  from: z.strictObject({ object: objectRefSchema, link: z.string(), as: z.string().optional() }).optional(),
});
export type Query = z.input<typeof querySchema>;
export class Objects {
  constructor(readonly db: Database, readonly model: Ontology, readonly owner: string, readonly client: Sql = db.pool) {
    if (!owner) throw new Error('Object access requires an authenticated owner');
  }
  private row(row: Record<string, unknown>): ObjectData {
    const ref = { type: String(row.type), id: String(row.id) };
    const properties = this.model.parseObject(ref, row.properties as Record<string, unknown>);
    return { ref, revision: Number(row.revision), properties };
  }
  async read(input: ObjectRef): Promise<ObjectData> {
    const ref = objectRefSchema.parse(input);
    const rows = await this.db.query(`SELECT type,id,revision,properties FROM ${this.db.schema}.objects WHERE owner=$1 AND type=$2 AND id=$3`, [this.owner, ref.type, ref.id], this.client);
    if (!rows.rows[0]) throw new NotFound('Object is unavailable');
    return this.row(rows.rows[0]);
  }
  async query(input: Query) {
    const args = querySchema.parse(input), types = this.model.concreteTypes(args.type);
    const values: unknown[] = [this.owner, types];
    const clauses = ['owner=$1', 'type=ANY($2::text[])'];
    if (args.from) {
      const nav = this.model.navigation(args.from.object.type, args.from.link, args.from.as);
      const source = nav.forward ? 'from' : 'to', target = nav.forward ? 'to' : 'from';
      values.push(nav.link, args.from.object.type, args.from.object.id);
      clauses.push(`EXISTS(SELECT 1 FROM ${this.db.schema}.links l WHERE l.owner=o.owner AND l.type=$3 AND l.${source}_type=$4 AND l.${source}_id=$5 AND l.${target}_type=o.type AND l.${target}_id=o.id)`);
    }
    for (const [field, value] of Object.entries(args.where)) {
      const cases: string[] = [];
      for (const type of types) {
        values.push(type, this.model.propertyName(type, args.type, field));
        cases.push(`WHEN type=$${values.length - 1} THEN properties->$${values.length}::text`);
      }
      values.push(JSON.stringify(value));
      clauses.push(`(CASE ${cases.join(' ')} END)=$${values.length}::jsonb`);
    }
    const queryDigest = digest({ ...args, cursor: undefined, owner: this.owner, release: this.model.digest });
    if (args.cursor) {
      const cursor = z.strictObject({ query: z.literal(queryDigest), type: z.string(), id: z.string() }).parse(JSON.parse(Buffer.from(args.cursor, 'base64url').toString()));
      values.push(cursor.type, cursor.id);
      clauses.push(`(type COLLATE "C",id COLLATE "C")>($${values.length - 1},$${values.length})`);
    }
    values.push(args.limit + 1);
    const result = await this.db.query(`SELECT type,id,revision,properties FROM ${this.db.schema}.objects o WHERE ${clauses.join(' AND ')} ORDER BY type COLLATE "C",id COLLATE "C" LIMIT $${values.length}`, values, this.client);
    const records = result.rows.slice(0, args.limit).map(row => this.row(row));
    const fields = args.select ?? Object.keys(this.model.interfaces.get(args.type)?.properties ?? this.model.object(args.type).properties);
    const items = records.map(object => ({ ...object, properties: Object.fromEntries(fields.flatMap(field => {
      const local = this.model.propertyName(object.ref.type, args.type, field);
      return local === undefined ? [] : [[field, object.properties[local]]];
    })) }));
    const last = records.at(-1)?.ref;
    return { items, cursor: result.rows.length > args.limit && last ? Buffer.from(JSON.stringify({ query: queryDigest, ...last })).toString('base64url') : undefined };
  }
  async follow(ref: ObjectRef, link: string, view = ref.type): Promise<ObjectData[]> {
    const nav = this.model.navigation(ref.type, link, view);
    const from = nav.forward ? 'from' : 'to', to = nav.forward ? 'to' : 'from';
    const result = await this.db.query(`SELECT o.type,o.id,o.revision,o.properties FROM ${this.db.schema}.links l
      JOIN ${this.db.schema}.objects o ON o.owner=l.owner AND o.type=l.${to}_type AND o.id=l.${to}_id
      WHERE l.owner=$1 AND l.type=$2 AND l.${from}_type=$3 AND l.${from}_id=$4 ORDER BY o.id COLLATE "C" LIMIT 101`, [this.owner, nav.link, ref.type, ref.id], this.client);
    if (result.rows.length > 100) throw new Error('Relationship exceeds the complete read limit');
    return result.rows.map(row => this.row(row));
  }
  async create(ref: ObjectRef, input: Record<string, unknown>) {
    const properties = this.model.parseObject(ref, input);
    const result = await this.db.query(`INSERT INTO ${this.db.schema}.objects(owner,type,id,properties) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`, [this.owner, ref.type, ref.id, properties], this.client);
    if (!result.rowCount) {
      if (digest((await this.read(ref)).properties) !== digest(properties)) throw new Conflict('Object identity already contains different data');
    }
  }
  async ingestBatch(input: readonly { ref: ObjectRef; properties: Record<string, unknown> }[]) {
    if (!input.length) return;
    const unique = new Map<string, { type: string; id: string; properties: Record<string, unknown> }>();
    for (const item of input) {
      const row = { ...item.ref, properties: this.model.parseObject(item.ref, item.properties) }, key = JSON.stringify(item.ref);
      const previous = unique.get(key);
      if (previous && digest(previous) !== digest(row)) throw new Conflict('Source rows disagree about one object');
      unique.set(key, row);
    }
    await this.db.query(`INSERT INTO ${this.db.schema}.objects AS o(owner,type,id,properties)
      SELECT $1,type,id,properties FROM jsonb_to_recordset($2::jsonb) AS input(type text,id text,properties jsonb)
      ON CONFLICT(owner,type,id) DO UPDATE SET properties=excluded.properties,revision=o.revision+1
      WHERE o.properties IS DISTINCT FROM excluded.properties AND o.properties->>'observedAt' <= excluded.properties->>'observedAt'`, [this.owner, JSON.stringify([...unique.values()])], this.client);
  }
  async edit(ref: ObjectRef, revision: number, fields: Record<string, unknown>) {
    const old = await this.read(ref), properties = this.model.parseObject(ref, { ...old.properties, ...fields });
    const result = await this.db.query(`UPDATE ${this.db.schema}.objects SET properties=$4,revision=revision+1 WHERE owner=$1 AND type=$2 AND id=$3 AND revision=$5`, [this.owner, ref.type, ref.id, properties, revision], this.client);
    if (!result.rowCount) throw new Conflict('Object revision changed');
  }
  async link(edge: LinkData) {
    return this.linkBatch([edge]);
  }
  async linkBatch(edges: readonly LinkData[]) {
    if (!edges.length) return;
    const rows = edges.map(edge => {
      const definition = this.model.links.get(edge.type);
      if (!definition || edge.from.type !== definition.from.type || edge.to.type !== definition.to.type) throw new Error('Invalid link endpoints');
      return { type: edge.type, from_type: edge.from.type, from_id: edge.from.id, to_type: edge.to.type, to_id: edge.to.id, single_from: definition.from.cardinality === 'one', single_to: definition.to.cardinality === 'one' };
    });
    await this.db.query(`INSERT INTO ${this.db.schema}.links(owner,type,from_type,from_id,to_type,to_id,single_from,single_to)
      SELECT $1,type,from_type,from_id,to_type,to_id,single_from,single_to FROM jsonb_to_recordset($2::jsonb)
      AS input(type text,from_type text,from_id text,to_type text,to_id text,single_from boolean,single_to boolean)
      ON CONFLICT(owner,type,from_type,from_id,to_type,to_id) DO NOTHING`, [this.owner, JSON.stringify(rows)], this.client);
  }
}
