import {resourceGroups} from '../ontology/resource-mapping.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Conflict, NotFound, digest } from '../core/identity.js';
import { Ontology } from '../ontology/model.js';
import { ontologySchema, type OntologyDocument } from '../ontology/schema.js';
import { Access, resource, type Permission } from './access.js';
import type { Database, Sql } from './database.js';
import { Metadata, type Bindings } from './metadata.js';

const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/).max(80);
export const projectSchema = z.strictObject({ ontology: identifier, id: identifier, name: z.string().min(1).max(200) });
export const assignProjectSchema = z.strictObject({ ontology: identifier, project: identifier, resources: z.array(z.string().min(1).max(300)).min(1).max(200) });
export const branchCreateSchema = z.strictObject({ ontology: identifier, project: identifier.optional(), name: z.string().min(1).max(200), body: ontologySchema.optional() });
export const branchRevisionSchema = z.strictObject({ id: z.uuid(), revision: z.number().int().positive() });
export const branchUpdateSchema = branchRevisionSchema.extend({ body: ontologySchema });
export const branchReviewSchema = branchRevisionSchema.extend({ release: z.string().regex(/^[a-f0-9]{64}$/) });

export async function initializeGovernance(db: Database) {
  await db.query(`CREATE TABLE IF NOT EXISTS ${db.schema}.ontology_projects (
    ontology text NOT NULL, id text NOT NULL, name text NOT NULL, PRIMARY KEY(ontology,id));
    CREATE TABLE IF NOT EXISTS ${db.schema}.ontology_resource_projects (
      ontology text NOT NULL, resource text NOT NULL, project text NOT NULL, PRIMARY KEY(ontology,resource),
      FOREIGN KEY(ontology,project) REFERENCES ${db.schema}.ontology_projects(ontology,id));
    CREATE TABLE IF NOT EXISTS ${db.schema}.ontology_branches (
      id uuid PRIMARY KEY, ontology text NOT NULL, project text, name text NOT NULL, author text NOT NULL,
      base_release text NOT NULL REFERENCES ${db.schema}.releases(digest), body jsonb NOT NULL,
      revision integer NOT NULL DEFAULT 1, state text NOT NULL DEFAULT 'draft', candidate text REFERENCES ${db.schema}.releases(digest),
      reviewer text, reviewed_digest text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());`);
}
interface Branch {
  id: string; ontology: string; project: string | null; name: string; author: string; base_release: string;
  body: OntologyDocument; revision: number; state: string; candidate: string | null; reviewer: string | null; reviewed_digest: string | null;
}
const resources = (document: OntologyDocument) => {
  const expanded=new Ontology(document).resourceDocument;
  const entries=Object.entries(resourceGroups).flatMap(([kind,field])=>(expanded[field]??[]).map(entry=>[resource(document.id,kind,entry.apiName+(kind==='valueType'&&'version'in entry?'@'+entry.version:'')),digest(entry)] as const));
  for(const imported of document.imports??[])entries.push([resource(document.id,'import',imported.namespace),digest(imported)]);
  return new Map(entries);
};
export class Governance {
  constructor(private readonly db: Database, private readonly metadata: Metadata, private readonly bindings: Bindings) {}
  private authorize(access: Access, branch: Pick<Branch, 'ontology' | 'project'>, permission: Permission) {
    access.require(branch.ontology, permission, branch.project ? resource(branch.ontology, 'project', branch.project) : branch.ontology);
  }
  private async row(id: string, client: Sql = this.db.pool, lock = false): Promise<Branch> {
    z.uuid().parse(id);
    const row = (await this.db.query(`SELECT * FROM ${this.db.schema}.ontology_branches WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id], client)).rows[0];
    if (!row) throw new NotFound('Ontology branch is unavailable');
    return row as Branch;
  }
  async project(access: Access, raw: unknown) {
    const input = projectSchema.parse(raw);
    access.require(input.ontology, 'manage_definition', input.ontology);
    await this.metadata.active(input.ontology);
    return this.db.transaction(async client => {
      await access.refresh(client);
      await this.db.query(`INSERT INTO ${this.db.schema}.ontology_projects(ontology,id,name) VALUES($1,$2,$3)
        ON CONFLICT(ontology,id) DO UPDATE SET name=excluded.name`, [input.ontology,input.id,input.name], client);
      return input;
    });
  }
  async assign(access: Access, raw: unknown) {
    const input = assignProjectSchema.parse(raw);
    access.require(input.ontology, 'manage_definition', input.ontology);
    const known = resources((await this.metadata.active(input.ontology)).document);
    if (input.resources.some(name => !known.has(name))) throw new Error('Project assignment requires published Ontology resources');
    return this.db.transaction(async client => {
      await access.refresh(client);
      for (const name of input.resources) await this.db.query(`INSERT INTO ${this.db.schema}.ontology_resource_projects(ontology,resource,project) VALUES($1,$2,$3)
        ON CONFLICT(ontology,resource) DO UPDATE SET project=excluded.project`, [input.ontology,name,input.project], client);
      return input;
    });
  }
  private async validateChanges(access: Access, branch: Pick<Branch, 'ontology' | 'project'>, base: OntologyDocument, body: OntologyDocument, client: Sql = this.db.pool) {
    new Ontology(body);
    if (body.id !== branch.ontology) throw new Conflict('A branch cannot change its Ontology identity');
    this.authorize(access, branch, 'edit_definition');
    if (!branch.project) return;
    const before = resources(base), after = resources(body);
    const assigned = new Set((await this.db.query(`SELECT resource FROM ${this.db.schema}.ontology_resource_projects WHERE ontology=$1 AND project=$2`, [branch.ontology,branch.project], client)).rows.map(row => row.resource));
    for (const name of new Set([...before.keys(),...after.keys()])) {
      if (before.get(name) !== after.get(name) && before.has(name) && !assigned.has(name)) throw new Conflict('Branch edits exceed the selected project');
    }
  }
  async create(access: Access, raw: unknown) {
    const input = branchCreateSchema.parse(raw), base = await this.metadata.active(input.ontology);
    access.require(input.ontology, 'view_definition', input.ontology);
    const branch = { ontology: input.ontology, project: input.project ?? null };
    const body = input.body ?? base.document;
    await this.validateChanges(access, branch, base.document, body);
    const id = randomUUID();
    await this.db.transaction(async client => {
      await access.refresh(client);
      if (branch.project && !(await this.db.query(`SELECT 1 FROM ${this.db.schema}.ontology_projects WHERE ontology=$1 AND id=$2`, [branch.ontology,branch.project], client)).rowCount) throw new NotFound('Ontology project is unavailable');
      await this.db.query(`INSERT INTO ${this.db.schema}.ontology_branches(id,ontology,project,name,author,base_release,body) VALUES($1,$2,$3,$4,$5,$6,$7)`, [id,input.ontology,branch.project,input.name,access.principal.owner,base.release,body], client);
    });
    return this.read(access,id);
  }
  async read(access: Access, id: string) {
    const row = await this.row(id);
    // Branch bodies include unchanged resources from the whole Ontology.
    access.require(row.ontology, 'view_definition', row.ontology);
    this.authorize(access,row,'view_definition'); await access.refresh(); return row;
  }
  async list(access: Access, ontology: string) {
    identifier.parse(ontology); access.require(ontology,'view_definition',ontology);
    const rows = (await this.db.query(`SELECT id,ontology,project,name,author,revision,state,candidate,updated_at FROM ${this.db.schema}.ontology_branches WHERE ontology=$1 ORDER BY updated_at DESC LIMIT 100`, [ontology])).rows;
    const visible = rows.filter(row => access.allows({ ontology, permission:'view_definition',resource:row.project ? resource(ontology,'project',row.project) : ontology }));
    await access.refresh(); return visible;
  }
  async update(access: Access, raw: unknown) {
    const input = branchUpdateSchema.parse(raw);
    return this.db.transaction(async client => {
      const row = await this.row(input.id,client,true);
      if (row.state === 'merged' || row.revision !== input.revision) throw new Conflict('Branch is merged or its revision changed');
      const base = await this.metadata.get(row.base_release,client);
      await this.validateChanges(access,row,base.document,input.body,client); await access.refresh(client);
      await this.db.query(`UPDATE ${this.db.schema}.ontology_branches SET body=$2,revision=revision+1,state='draft',candidate=NULL,reviewer=NULL,reviewed_digest=NULL,updated_at=now() WHERE id=$1`, [input.id,input.body], client);
      return { id:input.id, revision:input.revision+1, state:'draft' };
    });
  }
  async prepare(access: Access, raw: unknown) {
    const input = branchRevisionSchema.parse(raw), row = await this.read(access,input.id);
    if (row.state === 'merged' || row.revision !== input.revision) throw new Conflict('Branch is merged or its revision changed');
    const active = await this.metadata.active(row.ontology);
    if (active.release !== row.base_release) throw new Conflict('Ontology changed; rebase the branch before preparing');
    await this.validateChanges(access,row,active.document,row.body);
    const target = row.project ? resource(row.ontology,'project',row.project) : undefined;
    const candidate = await this.metadata.prepare(row.body,this.bindings,access,undefined,target);
    return this.db.transaction(async client => {
      const current = await this.row(row.id,client,true);
      if (current.revision !== row.revision || current.state === 'merged') throw new Conflict('Branch changed while preparing');
      await access.refresh(client);
      await this.db.query(`UPDATE ${this.db.schema}.ontology_branches SET candidate=$2,revision=revision+1,state='submitted',reviewer=NULL,reviewed_digest=NULL,updated_at=now() WHERE id=$1`, [row.id,candidate.release], client);
      return {id:row.id,revision:row.revision+1,state:'submitted',release:candidate.release};
    });
  }
  /** Catch-up retains the projection identity and invalidates the prior review. */
  async catchUp(access: Access, raw: unknown) {
    const input=branchRevisionSchema.parse(raw);
    return this.db.transaction(async client=>{
      const row=await this.row(input.id,client,true);
      if(row.state==='merged'||row.revision!==input.revision||!row.candidate)throw new Conflict('Catch-up requires the current prepared branch revision');
      const base=await this.metadata.get(row.base_release,client);
      await this.validateChanges(access,row,base.document,row.body,client);
      const progress=await this.metadata.catchUp(row.candidate,this.bindings,access,row.project?resource(row.ontology,'project',row.project):undefined,client);
      await this.db.query(`UPDATE ${this.db.schema}.ontology_branches SET state='submitted',reviewer=NULL,reviewed_digest=NULL,revision=revision+1,updated_at=now() WHERE id=$1`,[row.id],client);
      return {...progress,id:row.id,revision:row.revision+1,state:'submitted'};
    });
  }
  async rebase(access: Access, raw: unknown) {
    const input = branchRevisionSchema.parse(raw);
    return this.db.transaction(async client => {
      const row = await this.row(input.id,client,true);
      if (row.state === 'merged' || row.revision !== input.revision) throw new Conflict('Branch is merged or its revision changed');
      const old = await this.metadata.get(row.base_release,client), current = await this.metadata.active(row.ontology,client);
      const oldResources=resources(old.document), liveResources=resources(current.document), draftResources=resources(row.body);
      for(const name of new Set([...oldResources.keys(),...liveResources.keys(),...draftResources.keys()])) {
        if(oldResources.get(name)!==draftResources.get(name) && oldResources.get(name)!==liveResources.get(name) && draftResources.get(name)!==liveResources.get(name)) throw new Conflict(`Ontology rebase conflict: ${name}`);
      }
      const body=structuredClone(current.document);
      for(const field of Object.values(resourceGroups)) {
        const oldEntries=new Map((old.document[field]??[]).map(item=>[item.apiName+('version'in item?'@'+item.version:''),digest(item)]));
        const drafts=new Map((row.body[field]??[]).map(item=>[item.apiName+('version'in item?'@'+item.version:''),item]));
        const merged=new Map((body[field]??[]).map(item=>[item.apiName+('version'in item?'@'+item.version:''),item]));
        for(const name of new Set([...oldEntries.keys(),...drafts.keys()])) if(oldEntries.get(name)!==(drafts.has(name)?digest(drafts.get(name)):undefined)) {
          const draft=drafts.get(name); if(draft)merged.set(name,draft); else merged.delete(name);
        }
        (body[field] as unknown[])=[...merged.values()];
      }
      const imports=new Map((current.document.imports??[]).map(item=>[item.namespace,item]));
      const oldImports=new Map((old.document.imports??[]).map(item=>[item.namespace,item]));
      const draftImports=new Map((row.body.imports??[]).map(item=>[item.namespace,item]));
      for(const name of new Set([...oldImports.keys(),...draftImports.keys()]))if(digest(oldImports.get(name)??null)!==digest(draftImports.get(name)??null)){
        const value=draftImports.get(name);if(value)imports.set(name,value);else imports.delete(name);
      }
      if(imports.size||row.body.imports||current.document.imports)body.imports=[...imports.values()];
      body.version=row.body.version;
      await this.validateChanges(access,row,current.document,body,client);await access.refresh(client);
      await this.db.query(`UPDATE ${this.db.schema}.ontology_branches SET body=$2,base_release=$3,revision=revision+1,state='draft',candidate=NULL,reviewer=NULL,reviewed_digest=NULL,updated_at=now() WHERE id=$1`, [row.id,body,current.release], client);
      return {id:row.id,revision:row.revision+1,state:'draft',baseRelease:current.release};
    });
  }
  private async reviewDigest(row: Branch, client: Sql) {
    const candidate=(await this.db.query(`SELECT source_fingerprint,projection_fingerprint FROM ${this.db.schema}.releases WHERE digest=$1`,[row.candidate],client)).rows[0];
    return digest({body:row.body,release:row.candidate,base:row.base_release,projection:candidate});
  }
  async review(access: Access, raw: unknown) {
    const input=branchReviewSchema.parse(raw);
    return this.db.transaction(async client=>{
      const row=await this.row(input.id,client,true);this.authorize(access,row,'manage_definition');
      if(row.state!=='submitted'||row.revision!==input.revision||row.candidate!==input.release)throw new Conflict('Review requires the exact submitted candidate');
      const candidate=await this.metadata.get(input.release,client);
      if(candidate.digest!==new Ontology(row.body).digest)throw new Conflict('Candidate definition differs');
      await access.refresh(client);
      const reviewed=await this.reviewDigest(row,client);
      await this.db.query(`UPDATE ${this.db.schema}.ontology_branches SET state='approved',reviewer=$2,reviewed_digest=$3,revision=revision+1,updated_at=now() WHERE id=$1`,[row.id,access.principal.owner,reviewed],client);
      return {id:row.id,revision:row.revision+1,state:'approved',release:row.candidate};
    });
  }
  async merge(access: Access, raw: unknown) {
    const input=branchReviewSchema.parse(raw);
    return this.db.transaction(async client=>{
      const row=await this.row(input.id,client,true);
      this.authorize(access,row,'manage_definition');
      await this.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['publication:' + row.ontology], client);
      await this.validateChanges(access,row,(await this.metadata.get(row.base_release,client)).document,row.body,client);
      if(row.state!=='approved'||row.revision!==input.revision||row.candidate!==input.release||row.reviewed_digest!==await this.reviewDigest(row,client))throw new Conflict('Merge requires the exact approved candidate');
      await this.metadata.activate(input.release,this.bindings,access,client);
      if(row.project) {
        const base=resources((await this.metadata.get(row.base_release,client)).document);
        for(const name of resources(row.body).keys()) if(!base.has(name))await this.db.query(`INSERT INTO ${this.db.schema}.ontology_resource_projects(ontology,resource,project) VALUES($1,$2,$3)`,[row.ontology,name,row.project],client);
      }
      await access.refresh(client);
      await this.db.query(`UPDATE ${this.db.schema}.ontology_branches SET state='merged',revision=revision+1,updated_at=now() WHERE id=$1`,[row.id],client);
      return {id:row.id,revision:row.revision+1,state:'merged',release:input.release};
    });
  }
}
