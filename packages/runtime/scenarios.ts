import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Conflict, digest } from '../core/identity.js';
import type { LinkData, ObjectRef } from '../ontology/schema.js';
import { Access, type Requirement } from './access.js';
import { Database, type Sql } from './database.js';
import { PublishedOntology } from './metadata.js';
import { Objects } from './objects.js';
import { checkScenario, lockEdits, objectLinks } from './scenario-store.js';

export const createScenarioSchema = z.strictObject({ requestId: z.string().min(1).max(128), name: z.string().min(1).max(200) });
export class Scenarios {
  constructor(private readonly db: Database) {}
  async list(access: Access, model: PublishedOntology, cursor?: string) {
    if(cursor)z.uuid().parse(cursor);
    access.require(model.document.id, 'view_definition', model.document.id);
    const rows=(await this.db.query(`SELECT id,name,revision,state,expires_at FROM ${this.db.schema}.scenarios WHERE owner=$1 AND release=$2 AND state='open' AND expires_at>now() AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT 101`, [access.principal.owner, model.release,cursor??null])).rows;
    return {items:rows.slice(0,100),cursor:rows.length>100?String(rows[99]!.id):undefined};
  }
  async create(access: Access, model: PublishedOntology, raw: unknown, beforeCommit?: (client: Sql) => Promise<void>) {
    const input = createScenarioSchema.parse(raw), owner = access.principal.owner;
    access.require(model.document.id, 'view_definition', model.document.id);
    return this.db.transaction(async client => {
      await beforeCommit?.(client);
      await lockEdits(this.db, model, owner, client);
      await this.db.query(`INSERT INTO ${this.db.schema}.scenarios(id,owner,request_id,name,release) VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner,request_id) DO NOTHING`, [randomUUID(), owner, input.requestId, input.name, model.release], client);
      const row = (await this.db.query(`SELECT id,name,release,revision,state,expires_at FROM ${this.db.schema}.scenarios WHERE owner=$1 AND request_id=$2`, [owner, input.requestId], client)).rows[0]!;
      if (row.name !== input.name || row.release !== model.release) throw new Conflict('Scenario request ID already has different input');
      await access.refresh(client); await beforeCommit?.(client); return row;
    });
  }
  async view(access: Access, model: PublishedOntology, id: string, client: Sql = this.db.pool) {
    z.uuid().parse(id);
    const view = new PublishedOntology(model.document, model.release, model.projection, model.runtimeId, model.bindings, id);
    await checkScenario(this.db, view, access.principal.owner, client);
    if ((await this.db.query(`SELECT release FROM ${this.db.schema}.ontology WHERE id=$1`, [model.document.id], client)).rows[0]?.release !== model.release) throw new Conflict('Scenario publication changed; create a new scenario');
    return view;
  }
  private async changes(owner: string, id: string, client: Sql) {
    const objects = (await this.db.query(`SELECT * FROM ${this.db.schema}.scenario_objects WHERE owner=$1 AND scenario_id=$2 AND properties IS DISTINCT FROM base_properties ORDER BY type,id`, [owner, id], client)).rows;
    const links = (await this.db.query(`SELECT * FROM ${this.db.schema}.scenario_links WHERE owner=$1 AND scenario_id=$2 AND (NOT removed) IS DISTINCT FROM base_present ORDER BY type,from_id,to_id`, [owner, id], client)).rows;
    return { objects, links };
  }
  async inspect(access: Access, model: PublishedOntology, id: string) {
    const owner = access.principal.owner, view = await this.view(access, model, id);
    return this.db.transaction(async client => {
      await lockEdits(this.db, model, owner, client); await checkScenario(this.db, view, owner, client, true);
      const row = (await this.db.query(`SELECT id,name,revision,state,expires_at FROM ${this.db.schema}.scenarios WHERE owner=$1 AND id=$2`, [owner, id], client)).rows[0]!;
      const changes = await this.changes(owner, id, client), objects = [];
      for (const item of changes.objects) {
        access.read(model, item.type);
        const mask = (properties: Record<string, unknown> | null) => properties && Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, access.property(model, item.type, key) ? value : null]));
        const live = (await this.db.query(`SELECT revision FROM ${this.db.schema}.objects WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4`, [model.projection, owner, item.type, item.id], client)).rows[0];
        objects.push({ ref: { type: item.type, id: item.id }, before: mask(item.base_properties), after: mask(item.properties), conflict: String(live?.revision ?? '') !== String(item.base_revision ?? '') || item.properties===null && digest(await objectLinks(this.db,model,owner,{type:item.type,id:item.id},client))!==digest(item.base_links) });
      }
      const links = await Promise.all(changes.links.map(async item => {
        access.read(model, item.from_type); access.read(model, item.to_type); access.definition(model, 'link', item.type);
        const present=(await this.db.query(`SELECT 1 FROM ${this.db.schema}.links WHERE projection=$1 AND owner=$2 AND type=$3 AND from_type=$4 AND from_id=$5 AND to_type=$6 AND to_id=$7`,[model.projection,owner,item.type,item.from_type,item.from_id,item.to_type,item.to_id],client)).rowCount!>0;
        return { type: item.type, from: { type: item.from_type, id: item.from_id }, to: { type: item.to_type, id: item.to_id }, removed: item.removed,conflict:present!==item.base_present };
      }));
      await access.refresh(client); return { id:String(row.id),name:String(row.name),revision:Number(row.revision),state:String(row.state),expiresAt:row.expires_at as Date,objects,links };
    });
  }
  async discard(access: Access, model: PublishedOntology, id: string, revision: number, beforeCommit?: (client: Sql) => Promise<void>) {
    const view = await this.view(access, model, id), owner = access.principal.owner;
    return this.db.transaction(async client => {
      await beforeCommit?.(client);
      await lockEdits(this.db, model, owner, client); await checkScenario(this.db, view, owner, client, true);
      const result = await this.db.query(`UPDATE ${this.db.schema}.scenarios SET state='discarded',revision=revision+1 WHERE id=$1 AND owner=$2 AND revision=$3 RETURNING id,state,revision`, [id, owner, z.number().int().positive().parse(revision)], client);
      if (!result.rowCount) throw new Conflict('Scenario revision changed');
      await access.refresh(client); await beforeCommit?.(client); return result.rows[0];
    });
  }
  /** Called only from a published merge Action, inside its atomic edit transaction. */
  async mergeInto(graph: Objects, id: string, revision: number, scope: { objects: string[]; links: string[]; validate?: (view: Objects, touched: { ref: ObjectRef; deleted: boolean }[]) => Promise<void> }) {
    if (graph.client === this.db.pool || graph.model.scenario) throw new Conflict('Merge requires a live Action transaction');
    const { model, owner, access, client } = graph;
    await graph.lockWrites();
    const view = await this.view(access, model, id, client); await checkScenario(this.db, view, owner, client, true);
    const row = (await this.db.query(`SELECT revision FROM ${this.db.schema}.scenarios WHERE owner=$1 AND id=$2`, [owner, id], client)).rows[0]!;
    if (Number(row.revision) !== revision) throw new Conflict('Scenario changed after review');
    const changes = await this.changes(owner, id, client);
    if (changes.objects.some(item => !scope.objects.includes(item.type)) || changes.links.some(item => !scope.links.includes(item.type))) throw new Conflict('Scenario contains edits outside this merge Action scope');
    const actions = (await this.db.query(`SELECT requirements FROM ${this.db.schema}.scenario_actions WHERE owner=$1 AND scenario_id=$2`, [owner, id], client)).rows;
    for (const action of actions) for (const requirement of action.requirements as Requirement[]) access.require(requirement.ontology, requirement.permission, requirement.resource);
    for (const item of changes.objects) {
      const live = (await this.db.query(`SELECT revision FROM ${this.db.schema}.objects WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4`, [model.projection, owner, item.type, item.id], client)).rows[0];
      if (String(live?.revision ?? '') !== String(item.base_revision ?? '')) throw new Conflict('Scenario object conflicts with current data');
      if (item.properties === null && digest(await objectLinks(this.db,model,owner,{type:item.type,id:item.id},client)) !== digest(item.base_links)) throw new Conflict('Scenario deletion conflicts with current relationships');
    }
    const touched = new Map<string, { ref: ObjectRef; deleted: boolean }>();
    for (const item of changes.objects) { const ref={type:String(item.type),id:String(item.id)}; touched.set(digest(ref),{ref,deleted:item.properties===null}); }
    for (const item of changes.links) { const ref={type:String(item.from_type),id:String(item.from_id)}; if(!touched.has(digest(ref)))touched.set(digest(ref),{ref,deleted:false}); }
    await scope.validate?.(new Objects(this.db,view,access,client),[...touched.values()]);
    const edge = (item: Record<string, any>): LinkData => ({ type: item.type, from: { type: item.from_type, id: item.from_id }, to: { type: item.to_type, id: item.to_id } });
    for (const item of changes.links) {
      const current = (await this.db.query(`SELECT 1 FROM ${this.db.schema}.links WHERE projection=$1 AND owner=$2 AND type=$3 AND from_type=$4 AND from_id=$5 AND to_type=$6 AND to_id=$7`, [model.projection, owner, item.type, item.from_type, item.from_id, item.to_type, item.to_id], client)).rowCount! > 0;
      if (current !== item.base_present) throw new Conflict('Scenario link conflicts with current data');
      if (item.removed) await graph.unlink(edge(item));
    }
    for (const item of changes.objects) {
      const ref: ObjectRef = { type: item.type, id: item.id };
      if (item.properties === null) { if (item.base_revision !== null) await graph.remove(ref, Number(item.base_revision)); }
      else if (item.base_revision === null) await graph.create(ref, item.properties);
      else await graph.edit(ref, Number(item.base_revision), item.properties);
    }
    for (const item of changes.links) if (!item.removed) await graph.link(edge(item));
    await this.db.query(`UPDATE ${this.db.schema}.scenarios SET state='merged',revision=revision+1 WHERE owner=$1 AND id=$2`, [owner, id], client);
  }
}
