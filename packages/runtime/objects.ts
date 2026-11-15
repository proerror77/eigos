import { scenarioMetadataRead, scenarioMetadataQuery, scenarioMetadataType } from './scenario-metadata.js';
import { DerivedProperties } from './derived.js';
import { compareValues, matchesPredicate, nestedValue, orderSchema, predicateFields, predicateSchema, regexMatches, propertyPathSchema } from './query-filter.js';
import { recordObjectEdit, resolveSourceEdit } from './edit-history.js';
import { z } from 'zod';
import { Conflict, NotFound, digest, type ExecutionActor } from '../core/identity.js';
import { PublishedOntology } from './metadata.js';
import { Access } from './access.js';
import { objectRefSchema, type ObjectData, type ObjectRef, type LinkData } from '../ontology/schema.js';
import { processLogTarget } from '../ontology/process-definition.js';
import { Database, type Sql } from './database.js';
import { checkScenario, lockEdits, viewTables, stageObject, stageLink, type ScenarioMutation } from './scenario-store.js';
import { isNumeric, storedPredicate, supportsStoredOrder, supportsStoredPredicate, type Metric } from './stored-query.js';

export const querySchema = z.strictObject({
  type: z.string(), where: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  filter: predicateSchema.optional(), orderBy: orderSchema.optional(),
  select: z.array(propertyPathSchema).max(30).optional(), limit: z.number().int().min(1).max(100).default(50), cursor: z.string().optional(),
  from: z.strictObject({ object: objectRefSchema, link: z.string(), as: z.string().optional() }).optional(),
});
export type Query = z.input<typeof querySchema>;
export function queryFields(query: Pick<z.output<typeof querySchema>, 'where' | 'filter' | 'orderBy' | 'select'>) {
  return [...new Set([...Object.keys(query.where ?? {}), ...predicateFields(query.filter),
    ...(query.orderBy ?? []).map(item => item.property), ...(query.select ?? [])])];
}
export class Objects {
  constructor(readonly db: Database, readonly model: PublishedOntology, readonly access: Access, readonly client: Sql = db.pool,
    readonly change?: { action?: string; requestId?: string; taskId?: string; executor?: ExecutionActor; scenarioEdits?: ScenarioMutation[] }) {}
  get owner() { return this.access.principal.owner; }
  private writeReady?: Promise<void>;
  async lockWrites() { await this.prepareWrite(); }
  private prepareWrite() {
    return this.writeReady ??= (async () => {
      await lockEdits(this.db, this.model, this.owner, this.client);
      await checkScenario(this.db, this.model, this.owner, this.client, true);
    })();
  }
  private assertStoredFields(ref:ObjectRef,properties:Record<string,unknown>) {
    if(Object.keys(properties).some(field=>this.model.object(ref.type).properties[field]?.derived))throw new Conflict('Derived properties are read-only');
  }
  private writeType(type: string, endpoint=false) {
    if (processLogTarget(this.model,type)) throw new Conflict('Process logs and their relationships are read-only');
    if(type===scenarioMetadataType&&!endpoint)throw new Conflict('Edit Scenario metadata through its lifecycle API');
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
    return Object.fromEntries(Object.entries(properties).filter(([field])=>this.model.object(ref.type).properties[field]).map(([field,value])=>[field,this.access.cell(this.model,ref.type,field,properties)?value:null]));
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
    const values: unknown[] = [this.owner, ref.type, ref.id, this.model.projection];
    const policy = processLogTarget(this.model,ref.type) ? this.access.rowSql(this.model,ref.type,values,'o.properties') : 'TRUE';
    const tables = viewTables(this.db, this.model, this.owner, values,[ref.type]);
    const rows = await this.db.readQuery(`${tables.prefix}SELECT type,id,revision,properties FROM ${tables.objects} o WHERE owner=$1 AND type=$2 AND id=$3 AND projection=$4 AND ${policy}`, values, this.client);
    if (!rows.rows[0]) throw new NotFound('Object is unavailable');
    return this.row(rows.rows[0]);
  }
  async readStored(input: ObjectRef): Promise<ObjectData> {
    if(input.type===scenarioMetadataType)return scenarioMetadataRead(this,input);
    this.access.read(this.model, input.type);
    const object = await this.stored(input);
    await this.processLogReads([object]);
    return this.visible(object);
  }
  private async processLogReads(objects: ObjectData[]) {
    const seen = new Set<string>();
    for (const object of objects) {
      const target = processLogTarget(this.model,object.ref.type);
      if (!target) continue;
      const ref = { type: target.objectType, id: String(object.properties.processId) }, key = JSON.stringify([ref,target.property]);
      if (seen.has(key)) continue;
      seen.add(key);
      const parent = await this.stored(ref);
      this.access.readRow(this.model,ref.type,parent.properties,true);
      if (!this.access.cell(this.model,ref.type,target.property,parent.properties)) throw new NotFound('Process state is unavailable');
    }
  }
  /** Source fields must match their baseline; unrelated local notes may remain. */
  async matchesSource(ref:ObjectRef,sourceName:string):Promise<boolean>{
    const mapping=this.model.sources.get(sourceName),provider=mapping&&this.model.functions.get(mapping.function)?.source;
    if(!mapping||mapping.objectType!==ref.type||!provider)throw new Error('Source certification requires a matching datasource');
    this.access.source(this.model,provider);
    const object=await this.stored(ref);this.access.readRow(this.model,ref.type,object.properties);
    const baseline=(await this.db.readQuery(`SELECT properties FROM ${this.db.schema}.source_values WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4 AND source=$5`,[this.model.projection,this.owner,ref.type,ref.id,sourceName],this.client)).rows[0]?.properties as Record<string,unknown>|undefined;
    if(!baseline)return false;
    return Object.entries(baseline).every(([field,value])=>Object.hasOwn(object.properties,field)&&this.access.cell(this.model,ref.type,field,object.properties)&&digest(object.properties[field])===digest(value));
  }
  async propertyVisible(ref:ObjectRef,field:string):Promise<boolean> {
    const object=await this.stored(ref);
    this.access.readRow(this.model,ref.type,object.properties);
    return this.access.cell(this.model,ref.type,field,object.properties);
  }
  async read(input: ObjectRef): Promise<ObjectData> {
    if(this.client===this.db.pool&&Object.values(this.model.object(input.type).properties).some(property=>property.derived)) {
      const access=await Access.load(this.db,this.access.principal);
      const result=await this.db.transaction(async client=>{
        await this.db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',[],client);
        return new Objects(this.db,this.model,access,client).read(input);
      });
      if(!await access.canReturn(access.dataRequirements()))throw new Conflict('Derived result permissions changed');
      this.access.adoptReads(access);return result;
    }
    return new DerivedProperties(this).enrich(await this.readStored(input));
  }
  async query(input: Query):Promise<{items:ObjectData[];cursor?:string}> {
    const args=querySchema.parse(input);
    const fields = queryFields(args);
    this.access.definition(this.model, this.model.interfaces.has(args.type) ? 'interface' : 'object', args.type);
    const types = this.model.concreteTypes(args.type);
    for (const field of fields) this.model.propertyPath(args.type, field);
    const derived=types.some(type=>Object.values(this.model.object(type).properties).some(property=>property.derived));
    if(!args.filter&&!args.orderBy&&!derived&&!fields.some(field=>field.includes('.')))return this.queryStored(args);
    if(this.client===this.db.pool) {
      const access=await Access.load(this.db,this.access.principal);
      const result=await this.db.transaction(async client=>{
        await this.db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',[],client);
        return new Objects(this.db,this.model,access,client).query(args);
      });
      if(!await access.canReturn(access.dataRequirements()))throw new Conflict('Query permissions changed');
      this.access.adoptReads(access);return result;
    }
    const evaluator = new DerivedProperties(this);
    const definitions = this.model.interfaces.get(args.type)?.properties ?? this.model.object(args.type).properties;
    const project = async (raw: ObjectData) => {
      const enriched = await evaluator.enrich(raw);
      const properties = Object.fromEntries(Object.keys(definitions).map(field => {
        const local = this.model.propertyName(raw.ref.type, args.type, field);
        return [field, local ? enriched.properties[local] ?? null : null];
      }));
      return { ...enriched, properties };
    };
    const pushed = await this.scalarCandidates(args);
    let matching: ObjectData[];
    if (pushed) {
      matching = [];
      for (const item of pushed.objects) matching.push(await project(item));
    } else {
      const all: ObjectData[] = [];
      let cursor: string | undefined;
      do {
        const page = await this.queryStored({ type: args.type, from: args.from, limit: 100, cursor });
        for (const item of page.items) {
          all.push(await project(args.type === item.ref.type ? item : await this.readStored(item.ref)));
          if (all.length > 10000) throw new Conflict('Extended query exceeds 10000 complete candidate objects');
        }
        cursor = page.cursor;
      } while (cursor);
      const regex = await regexMatches(args.filter, all);
      matching = all.filter(object => Object.entries(args.where).every(([field, value]) =>
        digest(nestedValue(object.properties, field)) === digest(value)) &&
        (!args.filter || matchesPredicate(args.filter, object.properties, regex)));
    }
    if (!pushed?.ordered) matching.sort((left, right) => {
      for (const order of args.orderBy ?? []) {
        const a = nestedValue(left.properties, order.property);
        const b = nestedValue(right.properties, order.property);
        const comparison = compareValues(a, b);
        if (comparison) return a === null || b === null ? comparison : order.direction === 'desc' ? -comparison : comparison;
      }
      return Buffer.compare(Buffer.from(JSON.stringify(left.ref)), Buffer.from(JSON.stringify(right.ref)));
    });
    const identity=digest({owner:this.owner,release:this.model.release,scenario:this.model.scenario,args:{...args,cursor:undefined,limit:undefined},objects:matching});
    const offset=args.cursor?z.strictObject({query:z.literal(identity),offset:z.number().int().min(0).max(matching.length)}).parse(JSON.parse(Buffer.from(args.cursor,'base64url').toString())).offset:0;
    const end=offset+args.limit;
    const items=matching.slice(offset,end).map(object=>args.select?{...object,properties:Object.fromEntries(args.select.map(field=>[field,nestedValue(object.properties,field)]))}:object);
    return {items,cursor:end<matching.length?Buffer.from(JSON.stringify({query:identity,offset:end})).toString('base64url'):undefined};
  }
  private mayUseStoredFields(view: string, types: string[], fields: string[]) {
    return types.every(type => type !== scenarioMetadataType && !processLogTarget(this.model, type)
      && fields.every(field => {
        const [root, ...nested] = field.split('.');
        if (nested.some(part => /^0[0-9]+$|^[0-9]{10,}$/.test(part))) return false;
        const local = this.model.propertyName(type, view, root!);
        return !local || !this.model.object(type).properties[local]?.derived;
      }));
  }
  private async storedSelection(args: z.output<typeof querySchema>) {
    await checkScenario(this.db, this.model, this.owner, this.client);
    this.access.definition(this.model, this.model.interfaces.has(args.type) ? 'interface' : 'object', args.type);
    const navigation = args.from && this.model.navigation(args.from.object.type, args.from.link, args.from.as);
    if (args.from && navigation) {
      if (args.from.as) this.access.definition(this.model, 'interface', args.from.as);
      await this.readStored(args.from.object);
      this.access.read(this.model, navigation.target);
      this.access.definition(this.model, 'link', navigation.link);
    }
    const types = this.model.concreteTypes(args.type).filter(type => (!navigation || type === navigation.target) && this.access.canRead(this.model, type));
    if (!types.length) return undefined;
    const values: unknown[] = [this.owner, types, this.model.projection];
    const bind = (value: unknown) => { values.push(value); return '$' + values.length; };
    const tables = viewTables(this.db, this.model, this.owner, values, [...types, ...(args.from ? [args.from.object.type] : [])]);
    const policies = types.map(type => {
      this.access.read(this.model, type);
      return `(o.type=${bind(type)} AND ${this.access.rowSql(this.model, type, values, 'o.properties')})`;
    });
    const clauses = ['o.owner=$1', 'o.type=ANY($2::text[])', 'o.projection=$3', '(' + policies.join(' OR ') + ')'];
    if (args.from && navigation) {
      const source = navigation.forward ? 'from' : 'to', target = navigation.forward ? 'to' : 'from';
      clauses.push(`EXISTS(SELECT 1 FROM ${tables.links} l WHERE l.projection=o.projection AND l.owner=o.owner
        AND l.type=${bind(navigation.link)} AND l.${source}_type=${bind(args.from.object.type)} AND l.${source}_id=${bind(args.from.object.id)}
        AND l.${target}_type=o.type AND l.${target}_id=o.id)`);
    }
    const fields = new Map<string, string>();
    const property = (path: string, view = args.type) => {
      const key = JSON.stringify([view, path]), cached = fields.get(key);
      if (cached) return cached;
      const [root, ...nested] = path.split('.');
      const cases = types.flatMap(type => {
        const local = this.model.propertyName(type, view, root!);
        if (!local) return [];
        const kind = bind(type), allowed = this.access.cellSql(this.model, type, local, values, 'o.properties');
        return [`WHEN o.type=${kind} AND ${allowed} THEN o.properties#>${bind([local, ...nested])}::text[]`];
      });
      const expression = cases.length ? `COALESCE((CASE ${cases.join(' ')} END),'null'::jsonb)` : "'null'::jsonb";
      fields.set(key, expression);
      return expression;
    };
    for (const [field, value] of Object.entries(args.where)) clauses.push(`${property(field)}=${bind(JSON.stringify(value))}::jsonb`);
    return { values, bind, clauses, property, tables, types };
  }
  private async scalarCandidates(args: z.output<typeof querySchema>) {
    const types = this.model.concreteTypes(args.type);
    if (!supportsStoredPredicate(args.filter) ||
      !this.mayUseStoredFields(args.type, types, [...Object.keys(args.where), ...predicateFields(args.filter)])) return undefined;
    const selection = await this.storedSelection(args);
    if (!selection) return { objects: [], ordered: true };
    const { values, bind, clauses, property, tables } = selection;
    if (args.filter) clauses.push(storedPredicate(args.filter, property, bind));
    const ordered = !args.orderBy || this.mayUseStoredFields(args.type, types, args.orderBy.map(item => item.property))
      && args.orderBy.every(item => supportsStoredOrder(this.model.propertyPath(args.type, item.property)));
    const order = ordered ? (args.orderBy ?? []).map(item =>
      `NULLIF(${property(item.property)},'null'::jsonb) ${item.direction.toUpperCase()} NULLS LAST`) : [];
    order.push('to_json(o.type)::text COLLATE "C"', 'to_json(o.id)::text COLLATE "C"');
    const result = await this.db.readQuery(`${tables.prefix}SELECT o.type,o.id,o.revision,o.properties FROM ${tables.objects} o
      WHERE ${clauses.join(' AND ')} ORDER BY ${order.join(', ')} LIMIT 10001`, values, this.client);
    if (result.rows.length > 10000) throw new Conflict('Extended query exceeds 10000 matching objects');
    return { objects: result.rows.map(row => this.visible(this.row(row))), ordered };
  }
  async queryStored(input: Query):Promise<{items:ObjectData[];cursor?:string}> {
    if(input.type===scenarioMetadataType)return scenarioMetadataQuery(this,input);
    const args = querySchema.parse(input);
    const selection = await this.storedSelection(args);
    if (!selection) return { items: [], cursor: undefined };
    const { values, bind, clauses, tables, types } = selection;
    const queryDigest = digest({ ...args, cursor: undefined, owner: this.owner, release: this.model.release, scenario: this.model.scenario });
    if (args.cursor) {
      const cursor = z.strictObject({ query: z.literal(queryDigest), type: z.string(), id: z.string() }).parse(JSON.parse(Buffer.from(args.cursor, 'base64url').toString()));
      clauses.push(`(o.type COLLATE "C",o.id COLLATE "C")>(${bind(cursor.type)},${bind(cursor.id)})`);
    }
    const result = await this.db.readQuery(`${tables.prefix}SELECT o.type,o.id,o.revision,o.properties FROM ${tables.objects} o
      WHERE ${clauses.join(' AND ')} ORDER BY o.type COLLATE "C",o.id COLLATE "C" LIMIT ${bind(args.limit + 1)}`, values, this.client);
    const records = result.rows.slice(0, args.limit).map(row => this.row(row));
    await this.processLogReads(records);
    const fields = args.select ?? Object.keys(this.model.interfaces.get(args.type)?.properties ?? this.model.object(args.type).properties).filter(field=>types.some(type=>{const local=this.model.propertyName(type,args.type,field);return local&&!this.model.object(type).properties[local]?.derived;}));
    const items = records.map(object => { this.access.readRow(this.model,object.ref.type,object.properties); return { ...object, properties: Object.fromEntries(fields.flatMap(field => {
      const local = this.model.propertyName(object.ref.type, args.type, field);
      return local === undefined ? [] : [[field, this.access.cell(this.model, object.ref.type, local, object.properties) ? object.properties[local] : null]];
    })) }; });
    const last = records.at(-1)?.ref;
    return { items, cursor: result.rows.length > args.limit && last ? Buffer.from(JSON.stringify({ query: queryDigest, ...last })).toString('base64url') : undefined };
  }
  /** Aggregation can skip individual reads when visibility is independent of row values. */
  async aggregateStored(input: Query, view: string | undefined, groupBy: string[], metrics: Record<string, Metric>, groupLimit: number) {
    const args = querySchema.parse(input), type = args.type, projection = view ?? type;
    if (this.model.scenario || args.orderBy || !this.model.objects.has(type) || this.access.hasObjectPolicy(this.model, type)
      || !this.model.implements(type, projection) || !supportsStoredPredicate(args.filter)) return undefined;
    this.access.definition(this.model, 'object', type);
    const metricEntries = Object.entries(metrics);
    const groupFields = [...groupBy, ...metricEntries.flatMap(([, metric]) => metric.property ? [metric.property] : [])];
    if (!this.mayUseStoredFields(type, [type], queryFields(args)) || !this.mayUseStoredFields(projection, [type], groupFields)) return undefined;
    for (const field of queryFields(args)) this.model.propertyPath(type, field);
    for (const field of groupFields) this.model.propertyPath(projection, field);
    if (metricEntries.some(([, metric]) => metric.op !== 'count' && !isNumeric(this.model.propertyPath(projection, metric.property)))) return undefined;

    const selection = await this.storedSelection(args);
    if (!selection) return undefined;
    const { values, bind, clauses, property, tables } = selection;
    if (args.filter) clauses.push(storedPredicate(args.filter, property, bind));
    const groups = groupBy.map((field, index) => `NULLIF(${property(field, projection)},'null'::jsonb) AS g${index}`);
    const aggregates = metricEntries.map(([, metric], index) => {
      const field = metric.property ? `NULLIF(${property(metric.property, projection)},'null'::jsonb)` : '*';
      const operand = metric.op === 'count' ? field : `(${field})::double precision`;
      return `${metric.op.toUpperCase()}(${operand}) AS m${index}`;
    });
    const group = groups.length ? 'GROUP BY ' + groupBy.map((_, index) => 'g' + index).join(', ') : '';
    const rows = await this.db.readQuery(`${tables.prefix}SELECT COUNT(*) AS count,${[...groups, ...aggregates].join(', ')}
      FROM ${tables.objects} o WHERE ${clauses.join(' AND ')} ${group}
      ORDER BY MIN(to_json(o.id)::text COLLATE "C") LIMIT ${bind(groupLimit + 1)}`, values, this.client)
      .catch(error => {
        if (error?.code === '22003') throw new Conflict('Numeric aggregation overflow');
        throw error;
      });
    if (rows.rows.length > groupLimit) throw new Conflict('Object set exceeds the aggregate group limit');
    return {
      count: rows.rows.reduce((total, row) => total + Number(row.count), 0),
      items: rows.rows.map(row => ({
        group: Object.fromEntries(groupBy.map((field, index) => [field, row['g' + index]])),
        metrics: Object.fromEntries(metricEntries.map(([name], index) => {
          const value = row['m' + index] === null ? null : Number(row['m' + index]);
          if (value !== null && !Number.isFinite(value)) throw new Conflict('Numeric aggregation overflow');
          return [name, value];
        })),
      })),
    };
  }
  /** Object Set frontiers have already been read within this transaction. Recheck both endpoints in the join. */
  async followSet(sourceType: string, ids: string[], link: string, as: string | undefined, maximum: number) {
    const nav = this.model.navigation(sourceType, link, as);
    if ([sourceType, nav.target].some(type => type === scenarioMetadataType || processLogTarget(this.model, type))
      || Object.values(this.model.object(nav.target).properties).some(property => property.derived)) return undefined;
    if (as) this.access.definition(this.model, 'interface', as);
    this.access.read(this.model, sourceType);
    this.access.read(this.model, nav.target);
    this.access.definition(this.model, 'link', nav.link);
    await checkScenario(this.db, this.model, this.owner, this.client);
    const from = nav.forward ? 'from' : 'to', to = nav.forward ? 'to' : 'from';
    const values: unknown[] = [this.owner, this.model.projection, sourceType, ids, nav.link, nav.target, maximum + 1];
    const tables = viewTables(this.db, this.model, this.owner, values, [sourceType, nav.target]);
    const sourcePolicy = this.access.rowSql(this.model, sourceType, values, 's.properties');
    const targetPolicy = this.access.rowSql(this.model, nav.target, values, 'o.properties');
    const result = await this.db.readQuery(`${tables.prefix}SELECT o.type,o.id,o.revision,o.properties FROM ${tables.objects} o
      WHERE o.owner=$1 AND o.projection=$2 AND o.type=$6 AND ${targetPolicy}
      AND EXISTS (
        SELECT 1 FROM ${tables.links} l JOIN ${tables.objects} s
          ON s.projection=l.projection AND s.owner=l.owner AND (s.type,s.id)=(l.${from}_type,l.${from}_id)
        WHERE l.projection=o.projection AND l.owner=o.owner AND l.type=$5
          AND s.type=$3 AND s.id=ANY($4::text[]) AND ${sourcePolicy}
          AND (l.${to}_type,l.${to}_id)=(o.type,o.id)) LIMIT $7`, values, this.client);
    if (result.rows.length > maximum) throw new Conflict('Object set exceeds the complete evaluation limit');
    return result.rows.map(row => this.visible(this.row(row)));
  }
  async follow(ref: ObjectRef, link: string, view = ref.type): Promise<ObjectData[]> {
    if (view !== ref.type) this.access.definition(this.model, 'interface', view);
    const nav = this.model.navigation(ref.type, link, view);
    if(this.client===this.db.pool&&[ref.type,nav.target].some(type=>Object.values(this.model.object(type).properties).some(property=>property.derived))) {
      const access=await Access.load(this.db,this.access.principal);
      const result=await this.db.transaction(async client=>{
        await this.db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',[],client);
        return new Objects(this.db,this.model,access,client).follow(ref,link,view);
      });
      if(!await access.canReturn(access.dataRequirements()))throw new Conflict('Derived result permissions changed');
      this.access.adoptReads(access);return result;
    }
    await this.read(ref); this.access.read(this.model, nav.target); this.access.definition(this.model, 'link', nav.link);
    const from = nav.forward ? 'from' : 'to', to = nav.forward ? 'to' : 'from';
    await checkScenario(this.db, this.model, this.owner, this.client);
    const values: unknown[] = [this.owner, nav.link, ref.type, ref.id, this.model.projection];
    const policy = this.access.rowSql(this.model,nav.target,values,'o.properties');
    const tables = viewTables(this.db, this.model, this.owner, values,[ref.type,nav.target]);
    const result = await this.db.readQuery(`${tables.prefix}SELECT o.type,o.id,o.revision,o.properties FROM ${tables.links} l
      JOIN ${tables.objects} o ON o.projection=l.projection AND o.owner=l.owner AND o.type=l.${to}_type AND o.id=l.${to}_id
      WHERE l.owner=$1 AND l.type=$2 AND l.${from}_type=$3 AND l.${from}_id=$4 AND l.projection=$5 AND ${policy} ORDER BY o.id COLLATE "C" LIMIT 101`, values, this.client);
    if (result.rows.length > 100) throw new Error('Relationship exceeds the complete read limit');
    await this.processLogReads(result.rows.map(row=>this.row(row)));
    if(nav.target===scenarioMetadataType){
      const items:ObjectData[]=[];
      for(const row of result.rows)try{items.push(await scenarioMetadataRead(this,{type:scenarioMetadataType,id:String(row.id)}));}catch(error){if(!(error instanceof NotFound))throw error;}
      return items;
    }
    const evaluator=new DerivedProperties(this);
    return Promise.all(result.rows.map(row=>evaluator.enrich(this.visible(this.row(row)))));
  }
  async create(ref: ObjectRef, input: Record<string, unknown>): Promise<void> {
    if (this.client === this.db.pool) return this.db.transaction(client => new Objects(this.db, this.model, this.access, client,this.change).create(ref, input));
    this.writeType(ref.type); await this.prepareWrite();
    this.assertStoredFields(ref,input);
    const properties = this.model.parseObject(ref, input);
    this.access.writeRow(this.model,ref.type,properties);
    if (this.model.scenario) {
      const old = await this.stored(ref).catch(error => { if (error instanceof NotFound) return undefined; throw error; });
      if (old) { if (digest(old.properties) !== digest(properties)) throw new Conflict('Object identity already contains different data'); return; }
      await stageObject(this.db, this.model, this.owner, ref, 1, properties, this.client, Object.keys(input), { op: 'create', journal: this.change?.scenarioEdits }); return;
    }
    const result = await this.db.query(`INSERT INTO ${this.db.schema}.objects(owner,type,id,properties,projection) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id`, [this.owner, ref.type, ref.id, properties, this.model.projection], this.client);
    if (!result.rowCount) {
      if (digest((await this.stored(ref)).properties) !== digest(properties)) throw new Conflict('Object identity already contains different data');
    } else await recordObjectEdit(this,ref,null,properties,properties,'create');
  }
  async ingestBatch(input: readonly { ref: ObjectRef; properties: Record<string,unknown> | null }[], source = 'default', observedAt?: string): Promise<void> {
    if (this.client === this.db.pool) return this.db.transaction(client=>new Objects(this.db,this.model,this.access,client,this.change).ingestBatch(input,source,observedAt));
    await this.prepareWrite();
    if (this.model.scenario) throw new Conflict('Source ingestion is unavailable inside a scenario');
    const unique = new Map<string,{ref:ObjectRef;properties:Record<string,unknown>|null}>();
    for (const item of input) {
      this.writeType(item.ref.type);
      if(item.properties)this.assertStoredFields(item.ref,item.properties);
      const properties = item.properties === null ? null : this.model.parseObject(item.ref,item.properties);
      const key = JSON.stringify(item.ref), prior = unique.get(key);
      if (prior && digest(prior.properties)!==digest(properties)) throw new Conflict('Source rows disagree about one object');
      unique.set(key,{ref:item.ref,properties});
    }
    for (const {ref,properties} of unique.values()) {
      if (properties) this.access.sourceRow(this.model,ref.type,properties);
      const old = await this.stored(ref).catch(error=>{if(error instanceof NotFound)return undefined;throw error;});
      if (old) this.access.sourceRow(this.model,ref.type,old.properties);
      const resolved = await resolveSourceEdit(this,ref,properties,source,observedAt);
      const key=[this.model.projection,this.owner,ref.type,ref.id];
      if (resolved === null) {
        await this.db.query(`DELETE FROM ${this.db.schema}.links WHERE projection=$1 AND owner=$2 AND ((from_type=$3 AND from_id=$4) OR (to_type=$3 AND to_id=$4))`,key,this.client);
        await this.db.query(`DELETE FROM ${this.db.schema}.objects WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4`,key,this.client);
      } else {
        this.access.sourceRow(this.model,ref.type,resolved);
        await this.db.query(`INSERT INTO ${this.db.schema}.objects AS o(projection,owner,type,id,properties) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(projection,owner,type,id) DO UPDATE SET properties=excluded.properties,revision=o.revision+1
          WHERE o.properties IS DISTINCT FROM excluded.properties`,[...key,resolved],this.client);
      }
    }
  }
  async edit(ref: ObjectRef, revision: number, fields: Record<string, unknown>): Promise<void> {
    if (this.client === this.db.pool) return this.db.transaction(client => new Objects(this.db, this.model, this.access, client,this.change).edit(ref, revision, fields));
    this.writeType(ref.type); await this.prepareWrite();
    this.assertStoredFields(ref,fields);
    const old = await this.stored(ref), properties = this.model.parseObject(ref, { ...old.properties, ...fields });
    this.access.readRow(this.model,ref.type,old.properties);
    for (const field of Object.keys(fields)) if (!this.access.cell(this.model,ref.type,field,old.properties)) throw new Error('Cannot edit a hidden property');
    this.access.writeRow(this.model,ref.type,properties);
    if (old.revision !== revision) throw new Conflict('Object revision changed');
    if (this.model.scenario) {
      await stageObject(this.db, this.model, this.owner, ref, revision + 1, properties, this.client, Object.keys(fields), { op: 'edit', journal: this.change?.scenarioEdits }); return;
    }
    const result = await this.db.query(`UPDATE ${this.db.schema}.objects SET properties=$4,revision=revision+1 WHERE owner=$1 AND type=$2 AND id=$3 AND revision=$5 AND projection=$6`, [this.owner, ref.type, ref.id, properties, revision, this.model.projection], this.client);
    if (!result.rowCount) throw new Conflict('Object revision changed');
    await recordObjectEdit(this,ref,old.properties,properties,fields,'edit');
  }
  async link(edge: LinkData) {
    return this.linkBatch([edge]);
  }
  async linkBatch(edges: readonly LinkData[]): Promise<void> {
    if (this.client === this.db.pool) return this.db.transaction(client => new Objects(this.db, this.model, this.access, client,this.change).linkBatch(edges));
    await this.prepareWrite();
    if (!edges.length) return;
    for (const edge of edges) { await this.read(edge.from); await this.read(edge.to); }
    const rows = edges.map(edge => {
      this.access.definition(this.model, 'link', edge.type); this.writeType(edge.from.type,true); this.writeType(edge.to.type,true);
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
        await stageLink(this.db, this.model, this.owner, edge, false, this.client, this.change?.scenarioEdits);
      }
      return;
    }
    await this.db.query(`INSERT INTO ${this.db.schema}.links(owner,type,from_type,from_id,to_type,to_id,single_from,single_to,projection)
      SELECT $1,type,from_type,from_id,to_type,to_id,single_from,single_to,$3 FROM jsonb_to_recordset($2::jsonb)
      AS input(type text,from_type text,from_id text,to_type text,to_id text,single_from boolean,single_to boolean)
      ON CONFLICT(projection,owner,type,from_type,from_id,to_type,to_id) DO NOTHING`, [this.owner, JSON.stringify(rows), this.model.projection], this.client);
  }
  async unlink(edge: LinkData): Promise<void> {
    if (this.client === this.db.pool) return this.db.transaction(client => new Objects(this.db, this.model, this.access, client,this.change).unlink(edge));
    await this.prepareWrite(); this.access.definition(this.model, 'link', edge.type);
    await this.read(edge.from); await this.read(edge.to);
    this.writeType(edge.from.type,true); this.writeType(edge.to.type,true);
    const definition = this.model.links.get(edge.type);
    if (!definition || definition.from.type !== edge.from.type || definition.to.type !== edge.to.type) throw new Error('Invalid link endpoints');
    if (this.model.scenario) return stageLink(this.db, this.model, this.owner, edge, true, this.client, this.change?.scenarioEdits);
    await this.db.query(`DELETE FROM ${this.db.schema}.links WHERE projection=$1 AND owner=$2 AND type=$3 AND from_type=$4 AND from_id=$5 AND to_type=$6 AND to_id=$7`, [this.model.projection, this.owner, edge.type, edge.from.type, edge.from.id, edge.to.type, edge.to.id], this.client);
  }
  async remove(ref: ObjectRef, revision: number): Promise<void> {
    if (this.client === this.db.pool) return this.db.transaction(client => new Objects(this.db, this.model, this.access, client,this.change).remove(ref, revision));
    await this.prepareWrite(); this.writeType(ref.type);
    const old = await this.stored(ref);
    this.access.readRow(this.model,ref.type,old.properties);
    for (const field of Object.keys(old.properties)) if (!this.access.cell(this.model,ref.type,field,old.properties)) throw new Error('Cannot delete an object with hidden properties');
    if (old.revision !== revision) throw new Conflict('Object revision changed');
    for (const link of this.model.links.values()) {
      if (processLogTarget(this.model,link.from.type) || processLogTarget(this.model,link.to.type)) continue;
      for (const side of ['from', 'to'] as const) if (link[side].type === ref.type) {
        const others = await this.follow(ref, link[side].name);
        for (const other of others) await this.unlink({ type: link.apiName, from: side === 'from' ? ref : other.ref, to: side === 'to' ? ref : other.ref });
      }
    }
    if (this.model.scenario) return stageObject(this.db, this.model, this.owner, ref, revision + 1, null, this.client, [], { op: 'delete', journal: this.change?.scenarioEdits });
    await this.db.query(`DELETE FROM ${this.db.schema}.objects WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4 AND revision=$5`, [this.model.projection, this.owner, ref.type, ref.id, revision], this.client);
    await recordObjectEdit(this,ref,old.properties,null,undefined,'delete');
  }

}
