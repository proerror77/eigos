import { z } from 'zod';
import { digest, type Principal } from '../core/identity.js';
import type { Ontology } from '../ontology/model.js';
import { processLogTarget } from '../ontology/process-definition.js';
import { Database, type Sql } from './database.js';
import { markingsOf, permits, policySql, type ObjectPolicy, type SecurityContext } from './security.js';

export const permissionSchema = z.enum(['view_definition', 'edit_definition', 'manage_definition', 'view_objects', 'view_property', 'apply_action', 'execute_function', 'read_source', 'ingest_source', 'migrate_objects']);
export type Permission = z.infer<typeof permissionSchema>;
export const grantSchema = z.strictObject({ resource: z.string().min(1).max(300), permission: permissionSchema });
export type Grant = z.infer<typeof grantSchema>;
export interface RowRequirement { projection: string; type: string; id: string; fields: string[]; scenario?: string }
export type Requirement = Grant & { ontology: string; security?: string; row?: RowRequirement };
export class TaskResult {
  constructor(readonly value: unknown, readonly permissions: Requirement[]) {}
}
export const resource = (ontology: string, kind: string, name: string) => `${ontology}/${kind}/${name}`;
export class PermissionDenied extends Error {}

/** Resource grants and object/property visibility, independent of OAuth transport scopes. */
export class Access {
  private policies = new Map<string, ObjectPolicy>();
  private security: SecurityContext = { subject: '', groups: [], markings: [] };
  private securityDigest = '';
  private readMarkings = new Set<string>();
  private grants = new Set<string>();
  private properties = new Set<string>();
  private required = new Map<string, Requirement>();
  private data = new Map<string, Requirement>();
  readonly principal: Principal;
  private constructor(private readonly db: Database, principal: Principal) { this.principal = Object.freeze({ owner: principal.owner, scopes: Object.freeze([...principal.scopes]) }); }
  get runtimeId() { return this.db.runtimeId; }
  static async load(db: Database, principal: Principal, client?: Sql) {
    if (!principal.owner) throw new PermissionDenied('Authenticated owner is required');
    const access = new Access(db, principal); await access.refresh(client); return access;
  }
  async refresh(client?: Sql) {
    const result = await this.db.query(`SELECT
      (SELECT coalesce(jsonb_agg(jsonb_build_object('resource',resource,'permission',permission)),'[]') FROM ${this.db.schema}.resource_grants WHERE subject=$1 OR subject IN (SELECT 'group:'||name FROM ${this.db.schema}.security_memberships WHERE subject=$1 AND kind='group')) AS grants,
      (SELECT coalesce(jsonb_agg(ontology||'/property/'||type||'/'||property),'[]') FROM ${this.db.schema}.property_security) AS properties,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('ontology',ontology,'type',type,'policy',policy)),'[]') FROM ${this.db.schema}.object_policies) AS policies,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('kind',kind,'name',name)),'[]') FROM ${this.db.schema}.security_memberships WHERE subject=$1) AS memberships,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('ontology',ontology,'resource',resource,'project',project)),'[]') FROM ${this.db.schema}.ontology_resource_projects) AS projects`, [this.principal.owner], client);
    this.grants = new Set((result.rows[0]!.grants as Grant[]).map(grant => `${grant.permission}:${grant.resource}`));
    for (const assignment of result.rows[0]!.projects as {ontology:string;resource:string;project:string}[]) {
      for (const permission of ['view_definition','edit_definition','manage_definition']) {
        if(this.grants.has(`${permission}:${assignment.ontology}/project/${assignment.project}`)) this.grants.add(`${permission}:${assignment.resource}`);
      }
    }
    this.properties = new Set(result.rows[0]!.properties as string[]);
    this.policies = new Map(result.rows[0]!.policies.map((p: {ontology:string;type:string;policy:ObjectPolicy}) => [p.ontology+'/'+p.type,p.policy]));
    const memberships = result.rows[0]!.memberships as {kind:string;name:string}[];
    this.security = { subject: this.principal.owner, groups: memberships.filter(m=>m.kind==='group').map(m=>m.name).sort(), markings: memberships.filter(m=>m.kind==='marking').map(m=>m.name).sort() };
    this.securityDigest = digest({ policies: [...this.policies].sort(), security: this.security });
    for (const requirement of this.required.values()) if (!this.allows(requirement)) throw new PermissionDenied('Permission changed during execution');
  }
  allows({ permission, resource: target, ontology, security }: Requirement): boolean {
    if (security && security !== this.securityDigest) return false;
    if (permission === 'view_property' && !this.properties.has(target)) return true;
    const permissions: Permission[] = permission === 'view_definition' ? ['view_definition', 'edit_definition', 'manage_definition']
      : permission === 'edit_definition' ? ['edit_definition', 'manage_definition'] : [permission];
    return permissions.some(p => this.grants.has(`${p}:${target}`) || permission.endsWith('_definition') && this.grants.has(`${p}:${ontology}`));
  }
  require(ontology: string, permission: Permission, target: string, data = false) {
    const requirement = { ontology, permission, resource: target };
    if (!this.allows(requirement)) throw new PermissionDenied(`Permission required: ${permission}`);
    const key = `${permission}:${target}`; this.required.set(key, requirement); if (data) this.data.set(key, requirement);
  }
  definition(model: Ontology, kind: string, name: string) { this.require(model.document.id, 'view_definition', resource(model.document.id, kind, name)); }
  canDefine(model: Ontology, kind: string, name: string) { return this.allows({ ontology: model.document.id, permission: 'view_definition', resource: resource(model.document.id, kind, name) }); }
  canRead(model: Ontology, type: string) { return this.canDefine(model, 'object', type) && this.allows({ ontology: model.document.id, permission: 'view_objects', resource: resource(model.document.id, 'object', type) }); }
  read(model: Ontology, type: string) {
    this.definition(model, 'object', type);
    this.require(model.document.id, 'view_objects', resource(model.document.id, 'object', type), true);
  }
  property(model: Ontology, type: string, property: string): boolean {
    const target = resource(model.document.id, 'property', `${type}/${property}`);
    if (!this.allows({ ontology: model.document.id, permission: 'view_property', resource: target })) return false;
    this.require(model.document.id, 'view_property', target, true); return true;
  }
  adoptReads(other: Access) {
    if(other.principal.owner!==this.principal.owner)throw new PermissionDenied('Read context owner differs');
    for(const [key,value] of other.data)this.data.set(key,structuredClone(value));
    for(const [key,value] of other.required)this.required.set(key,structuredClone(value));
    for(const marking of other.readMarkings)this.readMarkings.add(marking);
  }
  readMarkingsSnapshot(): string[] {
    return [...this.readMarkings].sort();
  }
  /** Restore the security context of persisted inputs without recomputing their frozen values. */
  async restoreReads(requirements: Requirement[], markings: string[], client?: Sql): Promise<void> {
    if (!(await this.canReturn(requirements, client))) {
      throw new PermissionDenied('Frozen input permissions changed');
    }
    if (markings.some(marking => !this.security.markings.includes(marking))) {
      throw new PermissionDenied('Frozen input markings are unavailable');
    }
    for (const requirement of requirements) {
      const key = 'restored:' + digest(requirement);
      const copy = structuredClone(requirement);
      this.data.set(key, copy);
      this.required.set(key, copy);
    }
    for (const marking of markings) this.readMarkings.add(marking);
  }
  private trackSecurity(model: Ontology, type: string) {
    const r: Requirement = { ontology: model.document.id, permission: 'view_objects', resource: resource(model.document.id,'object',type), security: this.securityDigest };
    this.required.set('security:'+r.resource,r); this.data.set('security:'+r.resource,r);
  }
  private trackRow(model: Ontology, type: string, properties: Record<string, unknown>, field?: string, force = false) {
    // Virtual, immutable log rows inherit a recorded dependency on their business object.
    if (processLogTarget(model,type)) return;
    const publication = model as Ontology & { projection?: string; scenario?: string };
    if (!force && !this.policies.has(model.document.id+'/'+type) && !publication.scenario && type!=='OntologyScenario') return;
    const id = properties[model.object(type).primaryKey];
    if (!publication.projection || typeof id !== 'string') throw new PermissionDenied('A published object identity is required for policy evaluation');
    const key = 'row:' + digest([model.document.id, publication.projection, publication.scenario, type, id]);
    const previous = this.data.get(key)?.row;
    const fields = [...new Set([...(previous?.fields ?? []), ...(field ? [field] : [])])];
    const row: RowRequirement = { projection: publication.projection, type, id, fields, ...(publication.scenario ? { scenario: publication.scenario } : {}) };
    const requirement: Requirement = { ontology: model.document.id, permission: 'view_objects', resource: resource(model.document.id, 'object', type), row };
    this.data.set(key, requirement);
  }
  private async rowsAllowed(requirements: Requirement[], client?: Sql): Promise<boolean> {
    const dependencies = requirements.filter((requirement): requirement is Requirement & { row: RowRequirement } => Boolean(requirement.row));
    if (!dependencies.length) return true;
    const rows = await this.db.query(`SELECT input.ordinal,CASE WHEN input.type='OntologyScenario' THEN jsonb_build_object('id',meta.id::text,'name',meta.name,'owner',meta.owner,'state',meta.state,'release',meta.release,'revision',meta.revision,'expiresAt',to_char(meta.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'kind',meta.kind,'description',meta.description) WHEN delta.scenario_id IS NULL THEN object.properties ELSE delta.properties END AS properties,
      CASE WHEN input.type='OntologyScenario' THEN meta.id IS NOT NULL AND meta.kind='persisted' AND meta.release=active.release AND meta.expires_at>now() AND (meta.owner=$1 OR meta.readers ? $1)
      ELSE input.scenario IS NULL OR (scenario.id IS NOT NULL AND scenario.state='open' AND scenario.release=active.release AND scenario.expires_at>now() AND (scenario.session_id IS NULL OR (session.id IS NOT NULL AND session.closed_at IS NULL AND session.expires_at>now()))) END AS current
      FROM jsonb_to_recordset($2::jsonb) AS input(ordinal integer,ontology text,projection text,type text,id text,scenario uuid)
      LEFT JOIN ${this.db.schema}.ontology active ON active.id=input.ontology
      LEFT JOIN ${this.db.schema}.releases current_release ON current_release.digest=active.release
      LEFT JOIN ${this.db.schema}.objects object ON object.projection=CASE WHEN input.scenario IS NULL THEN current_release.projection ELSE input.projection END AND object.owner=$1 AND object.type=input.type AND object.id=input.id
      LEFT JOIN ${this.db.schema}.scenarios scenario ON scenario.id=input.scenario AND scenario.owner=$1
      LEFT JOIN ${this.db.schema}.scenario_sessions session ON session.id=scenario.session_id
      LEFT JOIN ${this.db.schema}.scenarios meta ON input.type='OntologyScenario' AND meta.id::text=input.id
      LEFT JOIN ${this.db.schema}.scenario_objects delta ON delta.scenario_id=input.scenario AND delta.owner=$1 AND delta.type=input.type AND delta.id=input.id`,
      [this.principal.owner, JSON.stringify(dependencies.map((requirement, ordinal) => ({ ordinal, ontology:requirement.ontology, ...requirement.row })))], client);
    return rows.rows.length === dependencies.length && rows.rows.every(row => {
      const requirement = dependencies[Number(row.ordinal)]!;
      if (!row.current || !row.properties) return false;
      const policy = this.policies.get(requirement.ontology + '/' + requirement.row.type);
      if (!permits(policy?.read, row.properties, this.security)) return false;
      if (!markingsOf(policy, row.properties).every(marking => this.security.markings.includes(marking))) return false;
      return requirement.row.fields.every(field => {
        const target = resource(requirement.ontology, 'property', requirement.row.type + '/' + field);
        return this.allows({ ontology: requirement.ontology, permission: 'view_property', resource: target }) && permits(policy?.properties[field], row.properties, this.security);
      });
    });
  }
  rowAllowed(model: Ontology, type: string, properties: Record<string,unknown>): boolean {
    this.trackSecurity(model,type);
    const policy = this.policies.get(model.document.id+'/'+type);
    return permits(policy?.read,properties,this.security) && markingsOf(policy,properties).every(m=>this.security.markings.includes(m));
  }
  readRow(model: Ontology, type: string, properties: Record<string,unknown>, track = false) {
    this.read(model,type);
    if (!this.rowAllowed(model,type,properties)) throw new PermissionDenied('Object policy denied access');
    this.trackRow(model, type, properties, undefined, track);
    for (const marking of markingsOf(this.policies.get(model.document.id+'/'+type),properties)) this.readMarkings.add(marking);
  }
  sourceRow(model: Ontology, type: string, properties: Record<string,unknown>) {
    this.read(model,type);
    if (!this.rowAllowed(model,type,properties)) throw new PermissionDenied('Source object policy denied access');
    this.trackRow(model,type,properties);
  }
  cell(model: Ontology, type: string, field: string, properties: Record<string,unknown>) {
    const allowed = this.property(model,type,field) && permits(this.policies.get(model.document.id+'/'+type)?.properties[field],properties,this.security);
    if (allowed) this.trackRow(model, type, properties, field);
    return allowed;
  }
  rowSql(model: Ontology, type: string, values: unknown[], column = 'properties') {
    this.trackSecurity(model,type);
    const policy = this.policies.get(model.document.id+'/'+type);
    const clauses = [policySql(policy?.read,values,this.security,column)];
    if (policy?.markingsProperty) {
      values.push(policy.markingsProperty); const field = `${column}->$${values.length}::text`;
      values.push(JSON.stringify(this.security.markings));
      clauses.push(`COALESCE(NULLIF(${field},'null'::jsonb),'[]'::jsonb) <@ $${values.length}::jsonb`);
    }
    const log = processLogTarget(model,type);
    if (log) {
      if (!this.canRead(model,log.objectType)) return 'FALSE';
      this.read(model,log.objectType);
      const publication = model as Ontology & { projection: string; scenario?: string };
      const bind = (value: unknown) => { values.push(value); return '$'+values.length; };
      const parentType=bind(log.objectType), owner=bind(this.principal.owner), projection=bind(publication.projection);
      const allowed = (snapshot: string) => `(${this.rowSql(model,log.objectType,values,snapshot)} AND ${this.cellSql(model,log.objectType,log.property,values,snapshot)})`;
      clauses.push(`EXISTS(SELECT 1 FROM ${publication.scenario?'view_objects':this.db.schema+'.objects'} process
        JOIN ${this.db.schema}.edit_history history ON history.owner=process.owner AND history.type=process.type AND history.id=process.id
        WHERE process.owner=${owner} AND process.projection=${projection} AND process.type=${parentType}
          AND process.id=${column}->>'processId' AND history.sequence::text=${column}->>'sequence'
          AND history.release=${column}->>'release' AND ${allowed('process.properties')}
          AND (history.before_values IS NULL OR ${allowed('history.before_values')})
          AND (history.after_values IS NULL OR ${allowed('history.after_values')}))`);
    }
    return '('+clauses.join(' AND ')+')';
  }
  cellSql(model: Ontology, type: string, field: string, values: unknown[], column = 'properties') {
    if (!this.property(model,type,field)) return 'FALSE';
    return '('+policySql(this.policies.get(model.document.id+'/'+type)?.properties[field],values,this.security,column)+')';
  }
  writeRow(model: Ontology, type: string, properties: Record<string,unknown>) {
    this.readRow(model,type,properties);
    const markings = markingsOf(this.policies.get(model.document.id+'/'+type),properties);
    if ([...this.readMarkings].some(marking=>!markings.includes(marking))) throw new PermissionDenied('Output must retain input security markings');
  }
  action(model: Ontology, name: string) { this.definition(model, 'action', name); this.require(model.document.id, 'apply_action', resource(model.document.id, 'action', name)); }
  function(model: Ontology, name: string) { this.definition(model, 'function', name); this.require(model.document.id, 'execute_function', resource(model.document.id, 'function', name)); }
  source(model: Ontology, name: string) { this.require(model.document.id, 'read_source', resource(model.document.id, 'source', name), true); }
  dataRequirements(): Requirement[] { return structuredClone([...this.data.values()]); }
  requirements(): Requirement[] { return structuredClone([...new Map([...this.required.values(), ...this.data.values()].map(item => [digest(item), item])).values()]); }
  /** Return a copy of the dependencies, preserving deleted inputs and all permission evidence. */
  private async requirementsAfterMerges(requirements: Requirement[], client?: Sql): Promise<Requirement[]> {
    const pending=requirements.flatMap((requirement,ordinal)=>requirement.row?.scenario?[{ordinal,ontology:requirement.ontology,...requirement.row}]:[]);
    if(!pending.length)return requirements;
    const merged=await this.db.query(`SELECT input.ordinal,live.projection
      FROM jsonb_to_recordset($2::jsonb) AS input(ordinal integer,ontology text,projection text,type text,id text,scenario uuid)
      JOIN ${this.db.schema}.scenarios scenario ON scenario.id=input.scenario AND scenario.owner=$1 AND scenario.state='merged'
      JOIN ${this.db.schema}.releases original ON original.digest=scenario.release AND original.projection=input.projection AND original.body->>'id'=input.ontology
      JOIN ${this.db.schema}.ontology active ON active.id=input.ontology
      JOIN ${this.db.schema}.releases live ON live.digest=active.release
      JOIN ${this.db.schema}.objects object ON object.projection=live.projection AND object.owner=$1 AND object.type=input.type AND object.id=input.id
      LEFT JOIN ${this.db.schema}.scenario_objects delta ON delta.scenario_id=scenario.id AND delta.owner=$1 AND delta.type=input.type AND delta.id=input.id
      WHERE input.type<>'OntologyScenario' AND (delta.id IS NULL OR delta.properties IS NOT NULL)`,[this.principal.owner,JSON.stringify(pending)],client);
    for(const item of merged.rows){
      const requirement=requirements[Number(item.ordinal)]!;
      const {scenario:_scenario,...row}=requirement.row!;
      requirement.row={...row,projection:String(item.projection)};
    }
    return requirements;
  }
  /** Use after Action commit for final task results. Failed merges leave the original dependency intact. */
  finalDataRequirements(client?: Sql): Promise<Requirement[]> {
    return this.requirementsAfterMerges(this.dataRequirements(),client);
  }
  /** Queue effects with the same transaction that commits the scenario, so rollback also removes this copy. */
  finalRequirements(client?: Sql): Promise<Requirement[]> {
    return this.requirementsAfterMerges(this.requirements(),client);
  }
  async canReturn(requirements: Requirement[], client?: Sql): Promise<boolean> {
    try { await this.refresh(client); }
    catch (error) { if (error instanceof PermissionDenied) return false; throw error; }
    const evidencedResources = new Set(requirements.filter(requirement => requirement.security === this.securityDigest).map(requirement => requirement.resource));
    const grantsAllowed = requirements.every(requirement => {
      if (!this.allows(requirement)) return false;
      if (requirement.permission !== 'view_objects') return true;
      if (!this.allows({ ...requirement, permission: 'view_definition' })) return false;
      const prefix = requirement.ontology + '/object/';
      const type = requirement.resource.startsWith(prefix) ? requirement.resource.slice(prefix.length) : '';
      if (!this.policies.has(requirement.ontology + '/' + type)) return true;
      // Older cached results have no policy evidence. Require a recorded policy context before reusing them.
      return evidencedResources.has(requirement.resource);
    });
    return grantsAllowed && await this.rowsAllowed(requirements, client);
  }
  describe(model: Ontology, executable = false) {
    const document = structuredClone(model.resolvedDocument);
    document.objectTypes = document.objectTypes.filter(type => this.canDefine(model, 'object', type.apiName));
    document.interfaceTypes = document.interfaceTypes.filter(type => this.canDefine(model, 'interface', type.apiName));
    const objects = new Set(document.objectTypes.map(type => type.apiName)), interfaces = new Set(document.interfaceTypes.map(type => type.apiName));
    document.linkTypes = document.linkTypes.filter(link => this.canDefine(model, 'link', link.apiName) && objects.has(link.from.type) && objects.has(link.to.type));
    document.functionTypes = document.functionTypes.filter(fn => this.canDefine(model, 'function', fn.apiName) && (!executable || this.allows({ ontology: model.document.id, permission: 'execute_function', resource: resource(model.document.id, 'function', fn.apiName) })));
    const functions = new Set(document.functionTypes.map(fn => fn.apiName));
    document.actionTypes = document.actionTypes.filter(action => this.canDefine(model, 'action', action.apiName) && (!executable || this.allows({ ontology: model.document.id, permission: 'apply_action', resource: resource(model.document.id, 'action', action.apiName) })) && (!action.function || functions.has(action.function)) && Object.values(action.objectParameters).every(type => objects.has(type) || interfaces.has(type)));
    const actions = new Set(document.actionTypes.map(action => action.apiName));
    document.dataSources = document.dataSources.filter(source => this.canDefine(model, 'datasource', source.apiName) && objects.has(source.objectType) && functions.has(source.function));
    for (const type of document.objectTypes) {
      type.interfaces = Object.fromEntries(Object.entries(type.interfaces).filter(([name]) => interfaces.has(name)));
      for (const mapping of Object.values(type.interfaces)) mapping.actions = Object.fromEntries(Object.entries(mapping.actions).filter(([, action]) => actions.has(action.action)));
    }
    for (const type of document.interfaceTypes) {
      type.links = Object.fromEntries(Object.entries(type.links).filter(([, link]) => objects.has(link.target) || interfaces.has(link.target)));
      type.actions = Object.fromEntries(Object.entries(type.actions).filter(([name]) => document.objectTypes.some(object => object.interfaces[type.apiName]?.actions[name])));
    }
    document.sharedProperties=document.sharedProperties?.filter(item=>this.canDefine(model,'sharedProperty',item.apiName));
    document.valueTypes=document.valueTypes?.filter(item=>this.canDefine(model,'valueType',item.apiName+'@'+item.version));
    document.structTypes=document.structTypes?.filter(item=>this.canDefine(model,'struct',item.apiName));
    document.typeGroups=document.typeGroups?.filter(item=>this.canDefine(model,'group',item.apiName)).map(item=>({...item,objectTypes:item.objectTypes.filter(type=>objects.has(type))}));
    delete document.imports;
    return document;
  }
}

/** Administrative configuration, run using the existing database administration role. */
export async function setGrants(db: Database, subject: string, grants: Grant[], client?: Sql) {
  z.string().min(1).max(200).parse(subject); grants = z.array(grantSchema).parse(grants);
  const write = async (client: Sql) => {
    await db.query(`DELETE FROM ${db.schema}.resource_grants WHERE subject=$1`, [subject], client);
    await db.query(`INSERT INTO ${db.schema}.resource_grants(subject,resource,permission) SELECT $1,resource,permission FROM jsonb_to_recordset($2::jsonb) AS g(resource text,permission text) ON CONFLICT DO NOTHING`, [subject, JSON.stringify(grants)], client);
  };
  if (client) await write(client); else await db.transaction(write);
}
export function memberGrants(model: Ontology): Grant[] {
  return [{ resource: model.document.id, permission: 'view_definition' },
    ...model.resolvedDocument.objectTypes.map(type => ({ resource: resource(model.document.id, 'object', type.apiName), permission: 'view_objects' as const })),
    ...model.resolvedDocument.functionTypes.map(fn => ({ resource: resource(model.document.id, 'function', fn.apiName), permission: 'execute_function' as const })),
    ...model.resolvedDocument.actionTypes.map(action => ({ resource: resource(model.document.id, 'action', action.apiName), permission: 'apply_action' as const })),
    ...[...new Set(model.resolvedDocument.functionTypes.flatMap(fn => fn.source ? [fn.source] : []))].map(name => ({ resource: resource(model.document.id, 'source', name), permission: 'read_source' as const })),
  ];
}
