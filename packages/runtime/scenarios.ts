import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Conflict, NotFound, digest } from '../core/identity.js';
import type { LinkData, ObjectRef } from '../ontology/schema.js';
import { Access, PermissionDenied, type Requirement } from './access.js';
import { Database, type Sql } from './database.js';
import { PublishedOntology } from './metadata.js';
import { Objects } from './objects.js';
import { checkScenario, lockEdits, objectLinks } from './scenario-store.js';
import { scenarioMetadataRead, syncScenarioMetadata, removeScenarioMetadata } from './scenario-metadata.js';

export const createScenarioSchema = z.strictObject({
  requestId: z.string().min(1).max(128), name: z.string().min(1).max(200),
  kind: z.enum(['persisted','temporary']).default('persisted'), sessionId: z.uuid().optional(),
  description: z.string().max(2000).default(''), ttlSeconds: z.number().int().min(1).max(31*86400).optional(),
}).refine(input=>input.kind==='temporary'?Boolean(input.sessionId):!input.sessionId,'Temporary scenarios require a session');
export async function initializeScenarioLifecycle(db: Database) {
  await db.query(`CREATE TABLE IF NOT EXISTS ${db.schema}.scenario_sessions(
    id uuid PRIMARY KEY,owner text NOT NULL,expires_at timestamptz NOT NULL,closed_at timestamptz);
    ALTER TABLE ${db.schema}.scenarios ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'persisted';
    ALTER TABLE ${db.schema}.scenarios ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
    ALTER TABLE ${db.schema}.scenarios ADD COLUMN IF NOT EXISTS readers jsonb NOT NULL DEFAULT '[]';
    ALTER TABLE ${db.schema}.scenarios ADD COLUMN IF NOT EXISTS session_id uuid REFERENCES ${db.schema}.scenario_sessions(id);
    ALTER TABLE ${db.schema}.scenarios ADD COLUMN IF NOT EXISTS creation_digest text;
    CREATE INDEX IF NOT EXISTS objects_scenario_metadata ON ${db.schema}.objects(id,projection,owner) WHERE type='OntologyScenario';`);
  const releases=(await db.query(`SELECT DISTINCT r.* FROM ${db.schema}.releases r JOIN ${db.schema}.scenarios s ON s.release=r.digest
    WHERE s.kind='persisted' AND s.expires_at>now() AND r.projection IS NOT NULL
    AND r.body->'objectTypes' @> '[{"apiName":"OntologyScenario"}]'::jsonb`)).rows;
  for(const release of releases){
    const model=new PublishedOntology(release.body,release.digest,release.projection,release.runtime_id,release.bindings);
    await db.transaction(async client=>{
      const ids=(await db.query(`SELECT id FROM ${db.schema}.scenarios WHERE release=$1 AND kind='persisted' AND expires_at>now() ORDER BY id FOR UPDATE`,[model.release],client)).rows;
      for(const row of ids)await syncScenarioMetadata(db,model,String(row.id),client);
    });
  }
}
export class Scenarios {
  constructor(private readonly db: Database) {}
  async openSession(access: Access, ttlSeconds=3600) {
    z.number().int().min(1).max(86400).parse(ttlSeconds);
    const id=randomUUID();
    const row=(await this.db.query(`INSERT INTO ${this.db.schema}.scenario_sessions(id,owner,expires_at) VALUES($1,$2,now()+$3*interval '1 second') RETURNING id,expires_at`,[id,access.principal.owner,ttlSeconds])).rows[0]!;
    return {id:String(row.id),expiresAt:row.expires_at as Date};
  }
  async closeSession(access: Access, sessionId: string) {
    z.uuid().parse(sessionId);
    await this.db.query(`UPDATE ${this.db.schema}.scenario_sessions SET closed_at=coalesce(closed_at,now()) WHERE id=$1 AND owner=$2`,[sessionId,access.principal.owner]);
    await this.cleanup(sessionId,access.principal.owner);
    return {sessionId,closed:true};
  }
  async cleanup(sessionId?: string, owner?: string) {
    return this.db.transaction(async client=>{
      const rows=(await this.db.query(`SELECT s.id FROM ${this.db.schema}.scenarios s
        LEFT JOIN ${this.db.schema}.scenario_sessions session ON session.id=s.session_id
        WHERE (s.expires_at<=now() OR session.closed_at IS NOT NULL OR session.expires_at<=now())
        AND ($1::uuid IS NULL OR s.session_id=$1) AND ($2::text IS NULL OR s.owner=$2)
        ORDER BY s.id FOR UPDATE OF s SKIP LOCKED LIMIT 500`,[sessionId??null,owner??null],client)).rows;
      const ids=rows.map(row=>row.id);
      await removeScenarioMetadata(this.db,ids,client);
      for(const table of ['scenario_actions','scenario_links','scenario_objects','scenarios']){
        await this.db.query(`DELETE FROM ${this.db.schema}.${table} WHERE ${table==='scenarios'?'id':'scenario_id'}=ANY($1::uuid[])`,[ids],client);
      }
      await this.db.query(`DELETE FROM ${this.db.schema}.scenario_sessions session WHERE (closed_at IS NOT NULL OR expires_at<=now())
        AND NOT EXISTS(SELECT 1 FROM ${this.db.schema}.scenarios s WHERE s.session_id=session.id)`,[],client);
      return {deleted:ids.length,more:ids.length===500};
    });
  }
  async share(access: Access, model: PublishedOntology, id: string, revision: number, readers: string[]) {
    z.uuid().parse(id);z.number().int().positive().parse(revision);
    const shared=z.array(z.string().min(1).max(200)).max(100).parse(readers);
    return this.db.transaction(async client=>{
      await access.refresh(client);await lockEdits(this.db,model,access.principal.owner,client);
      await scenarioMetadataRead(new Objects(this.db,model,access,client),{type:'OntologyScenario',id});
      const row=(await this.db.query(`UPDATE ${this.db.schema}.scenarios SET readers=$4,revision=revision+1
        WHERE id=$1 AND owner=$2 AND revision=$3 AND release=$5 AND kind='persisted' AND state='open' AND expires_at>now()
        RETURNING id,revision`,[id,access.principal.owner,revision,JSON.stringify([...new Set(shared)]),model.release],client)).rows[0];
      if(!row)throw new Conflict('Scenario is unavailable or its revision changed');
      await syncScenarioMetadata(this.db,model,id,client);
      await access.refresh(client);
      return {id:String(row.id),revision:Number(row.revision),readers:[...new Set(shared)]};
    });
  }
  async list(access: Access, model: PublishedOntology, cursor?: string) {
    if(cursor)z.uuid().parse(cursor);
    access.require(model.document.id, 'view_definition', model.document.id);
    const rows=(await this.db.query(`SELECT s.id,s.name,s.revision,s.state,s.expires_at FROM ${this.db.schema}.scenarios s
      LEFT JOIN ${this.db.schema}.scenario_sessions session ON session.id=s.session_id
      WHERE s.owner=$1 AND s.release=$2 AND s.state='open' AND s.expires_at>now()
      AND (s.session_id IS NULL OR (session.closed_at IS NULL AND session.expires_at>now()))
      AND ($3::uuid IS NULL OR s.id>$3) ORDER BY s.id LIMIT 101`, [access.principal.owner, model.release,cursor??null])).rows;
    return {items:rows.slice(0,100).map(row=>({id:String(row.id),name:String(row.name),revision:Number(row.revision),state:String(row.state),expiresAt:row.expires_at as Date,expires_at:row.expires_at as Date})),cursor:rows.length>100?String(rows[99]!.id):undefined};
  }
  async create(access: Access, model: PublishedOntology, raw: unknown, beforeCommit?: (client: Sql) => Promise<void>) {
    const input = createScenarioSchema.parse(raw), owner = access.principal.owner;
    access.require(model.document.id, 'view_definition', model.document.id);
    return this.db.transaction(async client => {
      await beforeCommit?.(client);
      await lockEdits(this.db, model, owner, client);
      let sessionExpires:Date|null=null;
      if(input.sessionId){
        const session=(await this.db.query(`SELECT expires_at FROM ${this.db.schema}.scenario_sessions WHERE id=$1 AND owner=$2 AND closed_at IS NULL AND expires_at>now() FOR UPDATE`,[input.sessionId,owner],client)).rows[0];
        if(!session)throw new Conflict('Scenario session is closed or unavailable');
        sessionExpires=session.expires_at;
      }
      const creation=digest({...input,release:model.release});
      await this.db.query(`INSERT INTO ${this.db.schema}.scenarios(id,owner,request_id,name,release,kind,description,session_id,expires_at,creation_digest)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,LEAST(now()+$9*interval '1 second',$10::timestamptz),$11) ON CONFLICT(owner,request_id) DO NOTHING`,
        [randomUUID(),owner,input.requestId,input.name,model.release,input.kind,input.description,input.sessionId??null,input.ttlSeconds??31*86400,sessionExpires,creation],client);
      const row = (await this.db.query(`SELECT id,name,release,revision,state,expires_at,kind,description,creation_digest FROM ${this.db.schema}.scenarios WHERE owner=$1 AND request_id=$2`, [owner, input.requestId], client)).rows[0]!;
      if (row.creation_digest?row.creation_digest!==creation:row.name !== input.name || row.release !== model.release) throw new Conflict('Scenario request ID already has different input');
      await syncScenarioMetadata(this.db,model,String(row.id),client);
      await access.refresh(client); await beforeCommit?.(client);
      return {id:String(row.id),name:String(row.name),release:String(row.release),revision:Number(row.revision),state:String(row.state),expiresAt:row.expires_at as Date,expires_at:row.expires_at as Date,kind:String(row.kind),description:String(row.description)};
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
        const mask = (properties: Record<string, unknown> | null) => {
          if (!properties) return null;
          access.readRow(model,item.type,properties);
          return new Objects(this.db,view,access,client).maskSnapshot({type:item.type,id:item.id},properties);
        };
        const live = (await this.db.query(`SELECT revision,properties FROM ${this.db.schema}.objects WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4`, [model.projection, owner, item.type, item.id], client)).rows[0];
        objects.push({ ref: { type: item.type, id: item.id }, before: mask(item.base_properties), after: mask(item.properties), conflict: (String(live?.revision ?? '') !== String(item.base_revision ?? '') || digest(live?.properties ?? null)!==digest(item.base_properties)) || item.properties===null && digest(await objectLinks(this.db,model,owner,{type:item.type,id:item.id},client))!==digest(item.base_links) });
      }
      const proposed = new Objects(this.db,view,access,client), live = new Objects(this.db,model,access,client);
      const requireEndpoint = async (ref: ObjectRef) => {
        try { await proposed.read(ref); }
        catch (error) {
          if (!(error instanceof NotFound)) throw error;
          // A removed endpoint is absent from the proposed view; its live instance still governs access.
          await live.read(ref);
        }
      };
      const links = await Promise.all(changes.links.map(async item => {
        await requireEndpoint({type:item.from_type,id:item.from_id});
        await requireEndpoint({type:item.to_type,id:item.to_id});
        access.definition(model, 'link', item.type);
        const present=(await this.db.query(`SELECT 1 FROM ${this.db.schema}.links WHERE projection=$1 AND owner=$2 AND type=$3 AND from_type=$4 AND from_id=$5 AND to_type=$6 AND to_id=$7`,[model.projection,owner,item.type,item.from_type,item.from_id,item.to_type,item.to_id],client)).rowCount!>0;
        return { type: item.type, from: { type: item.from_type, id: item.from_id }, to: { type: item.to_type, id: item.to_id }, removed: item.removed,conflict:present!==item.base_present || await this.cardinalityConflict(model,owner,item,client) };
      }));
      await access.refresh(client); return { id:String(row.id),name:String(row.name),revision:Number(row.revision),state:String(row.state),expiresAt:row.expires_at as Date,objects,links };
    });
  }
  private async cardinalityConflict(model: PublishedOntology, owner: string, item: Record<string,any>, client: Sql): Promise<boolean> {
    if (item.removed) return false;
    const definition = model.links.get(item.type)!;
    const directions = (['from','to'] as const).filter(side=>definition[side].cardinality==='one');
    for (const side of directions) {
      const other = side==='from'?'to':'from';
      const rows = await this.db.query(`SELECT 1 FROM ${this.db.schema}.links l WHERE projection=$1 AND owner=$2 AND type=$3
        AND ${side}_type=$4 AND ${side}_id=$5 AND (${other}_type,${other}_id)<>($6,$7)
        AND NOT EXISTS(SELECT 1 FROM ${this.db.schema}.scenario_links d WHERE d.scenario_id=$8 AND d.owner=l.owner AND d.type=l.type
          AND d.from_type=l.from_type AND d.from_id=l.from_id AND d.to_type=l.to_type AND d.to_id=l.to_id AND d.removed) LIMIT 1`,
        [model.projection,owner,item.type,item[side+'_type'],item[side+'_id'],item[other+'_type'],item[other+'_id'],item.scenario_id],client);
      if (rows.rowCount) return true;
    }
    return false;
  }
  async discard(access: Access, model: PublishedOntology, id: string, revision: number, beforeCommit?: (client: Sql) => Promise<void>) {
    const view = await this.view(access, model, id), owner = access.principal.owner;
    return this.db.transaction(async client => {
      await beforeCommit?.(client);
      await lockEdits(this.db, model, owner, client); await checkScenario(this.db, view, owner, client, true);
      const result = await this.db.query(`UPDATE ${this.db.schema}.scenarios SET state='discarded',revision=revision+1 WHERE id=$1 AND owner=$2 AND revision=$3 RETURNING id,state,revision`, [id, owner, z.number().int().positive().parse(revision)], client);
      if (!result.rowCount) throw new Conflict('Scenario revision changed');
      await syncScenarioMetadata(this.db,model,id,client);
      await access.refresh(client); await beforeCommit?.(client);
      const row=result.rows[0]!;return {id:String(row.id),state:String(row.state),revision:Number(row.revision)};
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
    const deleted = (await this.db.query(`SELECT type,id,base_revision FROM ${this.db.schema}.scenario_objects WHERE owner=$1 AND scenario_id=$2 AND properties IS NULL`, [owner,id],client)).rows;
    const deletions = new Map(deleted.map(item => [digest({type:item.type,id:item.id}),item]));
    for (const action of actions) {
      const requirements = (action.requirements as Requirement[]).map(requirement => {
        const dependency = requirement.row;
        const deletion = dependency?.scenario === id ? deletions.get(digest({type:dependency.type,id:dependency.id})) : undefined;
        if (!dependency || !deletion) return requirement;
        if (deletion.base_revision !== null) {
          // Authorize a staged deletion against the surviving live input, before its atomic removal.
          const { scenario: _scenario, ...row } = dependency;
          return { ...requirement, row };
        }
        // Created-then-deleted objects have no surviving input. Grants and the recorded policy context still apply.
        const { row: _row, ...permissions } = requirement;
        return permissions;
      });
      if (!await access.canReturn(requirements,client)) throw new PermissionDenied('Permission changed for scenario inputs');
      for (const requirement of action.requirements as Requirement[]) access.require(requirement.ontology, requirement.permission, requirement.resource);
    }
    for (const item of changes.objects) {
      const live = (await this.db.query(`SELECT revision,properties FROM ${this.db.schema}.objects WHERE projection=$1 AND owner=$2 AND type=$3 AND id=$4`, [model.projection, owner, item.type, item.id], client)).rows[0];
      if ((String(live?.revision ?? '') !== String(item.base_revision ?? '') || digest(live?.properties ?? null)!==digest(item.base_properties))) throw new Conflict('Scenario object conflicts with current data');
      if (item.properties === null && digest(await objectLinks(this.db,model,owner,{type:item.type,id:item.id},client)) !== digest(item.base_links)) throw new Conflict('Scenario deletion conflicts with current relationships');
    }
    const touched = new Map<string, { ref: ObjectRef; deleted: boolean }>();
    for (const item of changes.objects) { const ref={type:String(item.type),id:String(item.id)}; touched.set(digest(ref),{ref,deleted:item.properties===null}); }
    for (const item of changes.links) { const ref={type:String(item.from_type),id:String(item.from_id)}; if(!touched.has(digest(ref)))touched.set(digest(ref),{ref,deleted:false}); }
    await scope.validate?.(new Objects(this.db,view,access,client),[...touched.values()]);
    const edge = (item: Record<string, any>): LinkData => ({ type: item.type, from: { type: item.from_type, id: item.from_id }, to: { type: item.to_type, id: item.to_id } });
    for (const item of changes.links) {
      const current = (await this.db.query(`SELECT 1 FROM ${this.db.schema}.links WHERE projection=$1 AND owner=$2 AND type=$3 AND from_type=$4 AND from_id=$5 AND to_type=$6 AND to_id=$7`, [model.projection, owner, item.type, item.from_type, item.from_id, item.to_type, item.to_id], client)).rowCount! > 0;
      if (current !== item.base_present || await this.cardinalityConflict(model,owner,item,client)) throw new Conflict('Scenario link conflicts with current data or cardinality');
      if (item.removed) await graph.unlink(edge(item));
    }
    for (const item of changes.objects) {
      const ref: ObjectRef = { type: item.type, id: item.id };
      if (item.properties === null) { if (item.base_revision !== null) await graph.remove(ref, Number(item.base_revision)); }
      else if (item.base_revision === null) await graph.create(ref, item.properties);
      else {
        const fields=Object.fromEntries([...new Set([...Object.keys(item.base_properties),...Object.keys(item.properties)])].map(field=>[field,item.properties[field]]));
        await graph.edit(ref, Number(item.base_revision), fields);
      }
    }
    for (const item of changes.links) if (!item.removed) await graph.link(edge(item));
    await this.db.query(`UPDATE ${this.db.schema}.scenarios SET state='merged',revision=revision+1 WHERE owner=$1 AND id=$2`, [owner, id], client);
    await syncScenarioMetadata(this.db,model,id,client);
  }
}
