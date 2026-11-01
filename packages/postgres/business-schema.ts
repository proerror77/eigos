import type { DatabaseSync } from 'node:sqlite';

/** PostgreSQL DDL is generated only for reviewed SQLite constructs. The
 * compiler never executes source SQL or copies source data. Unknown objects
 * fail closed until their semantics are explicitly mapped and tested. */
const q = (name: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name)) throw new Error('Unsupported SQLite identifier');
  return `"${name}"`;
};
const canonical = (sql: string) => sql.replace(/\s+/g, '');
const integerKeys = new Set(['security_settings', 'security_manager', 'security_policy', 'security_policy_definitions',
  'security_migration_receipt', 'resident_contract_upgrade_receipt', 'ontology_definition_bootstrap',
  'consolidation_receipt', 'runtime_authority', 'runtime_authority_events', 'network_lease']);
const slotChecks = new Set(['security_settings', 'security_manager', 'security_policy', 'security_policy_definitions',
  'security_migration_receipt', 'resident_contract_upgrade_receipt', 'consolidation_receipt', 'runtime_authority']);
const jsonIndexes: Record<string, { table: string; source: string; target: string }> = {
  jobs_worker_ready: { table: 'jobs', source: "CREATE INDEX jobs_worker_ready ON jobs(json_extract(body,'$.service'),json_extract(body,'$.delegation.backendVersion'),COALESCE(json_extract(body,'$.executionMode'),'worker'),COALESCE(json_extract(body,'$.delegation.nextAt'),0),created_at,id) WHERE state IN ('working','submitted') OR (state IN ('canceled','failed','rejected','completed','auth-required') AND json_extract(body,'$.delegation.recoveryPending')=1)", target: `CREATE INDEX "jobs_worker_ready" ON "jobs" ((eigos_try_jsonb("body") #>> '{service}'), (eigos_try_jsonb("body") #>> '{delegation,backendVersion}'), (COALESCE(eigos_try_jsonb("body") #>> '{executionMode}','worker')), (COALESCE((eigos_try_jsonb("body") #>> '{delegation,nextAt}')::numeric,0)), "created_at", "id") WHERE "state" IN ('working','submitted') OR ("state" IN ('canceled','failed','rejected','completed','auth-required') AND (eigos_try_jsonb("body") #> '{delegation,recoveryPending}') IN ('true'::jsonb,'1'::jsonb))` },
  ontology_objects_body_validity: { table: 'ontology_objects', source: 'CREATE INDEX ontology_objects_body_validity ON ontology_objects(owner,json_valid(body))', target: 'CREATE INDEX "ontology_objects_body_validity" ON "ontology_objects" ("owner", (eigos_try_jsonb("body") IS NOT NULL))' },
  ontology_objects_task_source: { table: 'ontology_objects', source: "CREATE INDEX ontology_objects_task_source ON ontology_objects(owner,CASE WHEN json_valid(body) THEN json_extract(body,'$.source.id') END,type,id)", target: `CREATE INDEX "ontology_objects_task_source" ON "ontology_objects" ("owner", (eigos_try_jsonb("body") #>> '{source,id}'), "type", "id")` },
  pipeline_verification_task: { table: 'ontology_pipeline_verifications', source: "CREATE INDEX pipeline_verification_task ON ontology_pipeline_verifications(owner,json_extract(body,'$.taskId'))", target: `CREATE INDEX "pipeline_verification_task" ON "ontology_pipeline_verifications" ("owner", (eigos_try_jsonb("body") #>> '{taskId}'))` },
  security_job_request_revision: { table: 'jobs', source: "CREATE INDEX security_job_request_revision ON jobs(id,owner,CASE WHEN json_valid(body) THEN json_extract(body,'$.delegation.request.revision') END)", target: `CREATE INDEX "security_job_request_revision" ON "jobs" ("id", "owner", ((eigos_try_jsonb("body") #>> '{delegation,request,revision}')::numeric))` },
};
type NetworkIndexPart = { column: 'owner' | 'id' } | { path: string[] };
const networkIndexes: Record<string, { table: string; unique: boolean; parts: NetworkIndexPart[] }> = {
  network_evidence_task: { table: 'network_evidence_cards', unique: true, parts: [{ column: 'owner' }, { path: ['taskId'] }] },
  network_inquiry_post: { table: 'network_inquiries', unique: true, parts: [{ column: 'owner' }, { path: ['postId'] }] },
  network_inquiry_task: { table: 'network_inquiries', unique: true, parts: [{ column: 'owner' }, { path: ['taskId'] }] },
  network_follow_identity: { table: 'network_follows', unique: true, parts: [{ path: ['profileId'] }, { path: ['targetProfileId'] }] },
  network_membership_identity: { table: 'network_memberships', unique: true, parts: [{ path: ['spaceId'] }, { path: ['memberId'] }] },
  network_member_spaces: { table: 'network_memberships', unique: false, parts: [{ path: ['memberId'] }, { path: ['state'] }, { column: 'id' }] },
  network_publication_kind_state: { table: 'network_publications', unique: false, parts: [{ path: ['content','kind'] }, { path: ['state'] }, { column: 'id' }] },
  network_publication_profile: { table: 'network_publications', unique: false, parts: [{ path: ['profileId'] }, { path: ['content','kind'] }, { path: ['state'] }, { column: 'id' }] },
  network_publication_listing: { table: 'network_publications', unique: false, parts: [{ path: ['content','listingId'] }, { path: ['state'] }, { column: 'id' }] },
  network_message_post: { table: 'network_publications', unique: false, parts: [{ path: ['content','body','postId'] }, { column: 'id' }] },
};
const partialUnique: Record<string, { table: string; columns: string[]; source: string; predicate: string }> = {
  security_active_agent_grant: { table: 'security_grants', columns: ['installation_id'], source: "CREATE UNIQUE INDEX security_active_agent_grant ON security_grants(installation_id) WHERE kind='agent_access' AND state='active'", predicate: `"kind"='agent_access' AND "state"='active'` },
  security_active_recovery: { table: 'security_recoveries', columns: ['intent_id'], source: "CREATE UNIQUE INDEX security_active_recovery ON security_recoveries(intent_id) WHERE state IN ('pending','running')", predicate: `"state" IN ('pending','running')` },
  security_active_task_authority: { table: 'security_task_authorities', columns: ['task_id'], source: "CREATE UNIQUE INDEX security_active_task_authority ON security_task_authorities(task_id) WHERE state='active'", predicate: `"state"='active'` },
};
const jsonFunction = `CREATE FUNCTION eigos_try_jsonb(value TEXT) RETURNS JSONB LANGUAGE plpgsql IMMUTABLE STRICT SECURITY INVOKER AS $$ BEGIN RETURN value::jsonb; EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR untranslatable_character THEN RETURN NULL; END; $$`;
const immutableFunction = `CREATE FUNCTION eigos_immutable_history() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$ BEGIN RAISE EXCEPTION 'Immutable history cannot be modified' USING ERRCODE='55000'; END; $$`;
const rowidFunction = `CREATE FUNCTION eigos_preserve_rowid() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$ BEGIN IF NEW.__eigos_rowid IS DISTINCT FROM OLD.__eigos_rowid THEN RAISE EXCEPTION 'Preserved row identity cannot be modified' USING ERRCODE='55000'; END IF; RETURN NEW; END; $$`;
const networkEvidenceFunction = `CREATE FUNCTION eigos_network_evidence_invalidate() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
DECLARE affected_owner TEXT; affected_task TEXT;
BEGIN
  IF TG_OP='DELETE' THEN
    affected_owner := OLD.owner;
    IF TG_TABLE_NAME='jobs' THEN affected_task := OLD.id;
    ELSIF TG_TABLE_NAME IN ('outcome_feedback','action_intents') THEN affected_task := OLD.job_id; END IF;
  ELSE
    affected_owner := NEW.owner;
    IF TG_TABLE_NAME='jobs' THEN affected_task := NEW.id;
    ELSIF TG_TABLE_NAME IN ('outcome_feedback','action_intents') THEN affected_task := NEW.job_id; END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM network_evidence_cards e WHERE e.owner=affected_owner AND
    (TG_TABLE_NAME IN ('ontology_objects','ontology_links') OR eigos_try_jsonb(e.body) #>> '{taskId}' = affected_task)) THEN
    UPDATE network_state SET value=(value::BIGINT+1)::TEXT WHERE key='activity_epoch';
  END IF;
  RETURN NULL;
END; $$`;


type Column = { name: string; type: string; notNull: boolean; pk: number; defaultValue: unknown; hidden: number };
export interface BusinessSchemaMapping { tables: number; indexes: number; triggers: number; statements: string[]; schemaStatements: string[]; triggerStatements: string[]; identities: { table: string; column: string; usesSqliteSequence: boolean }[]; requiresDataValidation: true; requiresRuntimePort: true }

export function compileBusinessSchema(db: DatabaseSync): BusinessSchemaMapping {
  const objects = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  if (objects.some(row => !['table','index','trigger'].includes(String(row.type)))) throw new Error('Unsupported schema object');
  if (objects.some(row => ['eigos_try_jsonb', 'eigos_immutable_history', 'eigos_network_evidence_invalidate', 'eigos_preserve_rowid'].includes(String(row.name)))) throw new Error('Source collides with a PostgreSQL migration helper');
  const tableRows = objects.filter(row => row.type === 'table');
  const flags = db.prepare('PRAGMA table_list').all();
  const statements: string[] = [jsonFunction, immutableFunction, rowidFunction], triggerStatements: string[] = [];
  const identities: BusinessSchemaMapping['identities'] = [];
  if (objects.some(row => row.type === 'trigger' && String(row.name).startsWith('network_evidence_'))) statements.push(networkEvidenceFunction);
  for (const table of tableRows) {
    const name = String(table.name), source = String(table.sql), nameQuoted = q(name);
    const state = flags.find(row => row.schema === 'main' && row.name === name);
    if (!state || Number(state.wr) !== 0 || Number(state.strict) !== 0 || /^CREATE VIRTUAL TABLE/i.test(source)) throw new Error(`Unsupported table form: ${name}`);
    if (/\b(COLLATE|ON\s+CONFLICT|DEFERRABLE)\b/i.test(source)) throw new Error(`Unreviewed table semantics: ${name}`);
    const cols: Column[] = db.prepare(`PRAGMA table_xinfo(${nameQuoted})`).all().map(row => ({ name: String(row.name), type: String(row.type).toUpperCase(), notNull: Number(row.notnull) === 1, pk: Number(row.pk), defaultValue: row.dflt_value, hidden: Number(row.hidden) }));
    if (!cols.length || cols.some(c => c.hidden !== 0 || c.defaultValue !== null || !['TEXT','INTEGER','BLOB'].includes(c.type))) throw new Error(`Unsupported column definition: ${name}`);
    const sourceNames = new Set(cols.map(c=>c.name.toLowerCase()));
    if (sourceNames.has('__eigos_rowid') || ['rowid','_rowid_','oid'].every(alias=>sourceNames.has(alias))) throw new Error(`Hidden row identity cannot be mapped: ${name}`);
    const pk = cols.filter(c => c.pk > 0).sort((a,b) => a.pk-b.pk);
    if (!pk.length) throw new Error(`Table lacks a primary key: ${name}`);
    const autoincrement = /\bAUTOINCREMENT\b/i.test(source);
    const networkIdentity = name === 'network_events' && pk.length === 1 && pk[0]?.name === 'seq' && pk[0]?.type === 'INTEGER';
    if (autoincrement && (pk.length !== 1 || pk[0]?.type !== 'INTEGER')) throw new Error(`Unsupported identity: ${name}`);
    if (!autoincrement && !networkIdentity && pk.length === 1 && pk[0]?.type === 'INTEGER' && !integerKeys.has(name)) throw new Error(`Unreviewed integer primary key semantics: ${name}`);
    if (autoincrement || networkIdentity) identities.push({ table: name, column: pk[0]!.name, usesSqliteSequence: autoincrement });
    const definitions = cols.map(c => `${q(c.name)} ${c.type === 'INTEGER' ? 'BIGINT' : c.type === 'BLOB' ? 'BYTEA' : 'TEXT COLLATE "C"'}${(autoincrement || networkIdentity) && c.pk ? ' GENERATED BY DEFAULT AS IDENTITY' : ''}${c.notNull ? ' NOT NULL' : ''}`);
    definitions.push('"__eigos_rowid" BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL UNIQUE');
    definitions.push(`PRIMARY KEY (${pk.map(c => q(c.name)).join(',')})`);
    const checks = (source.match(/\bCHECK\s*\(/gi) ?? []).length;
    if (slotChecks.has(name)) {
      if (checks !== 1 || !/\bCHECK\s*\(\s*slot\s*=\s*1\s*\)/i.test(source)) throw new Error(`Unreviewed check constraint: ${name}`);
      definitions.push('CHECK ("slot"=1)');
    } else if (name === 'ontology_definition_bootstrap' || name === 'network_lease') {
      if (checks !== 1 || !/\bCHECK\s*\(\s*id\s*=\s*1\s*\)/i.test(source)) throw new Error(`Unreviewed check constraint: ${name}`);
      definitions.push('CHECK ("id"=1)');
    } else if (name === 'member_didi_source_admissions') {
      if (checks !== 1 || !/\bCHECK\s*\(\s*state\s+IN\s*\(\s*'active'\s*,\s*'revoked'\s*\)\s*\)/i.test(source)) throw new Error(`Unreviewed check constraint: ${name}`);
      definitions.push(`CHECK ("state" IN ('active','revoked'))`);
    } else if (checks) throw new Error(`Unreviewed check constraint: ${name}`);
    // SQLite evaluates unguarded json_extract in these indexes while writing.
    // Preserve its rejection of malformed JSON, rather than silently indexing
    // a NULL expression and accepting rows the source would reject.
    if (name === 'jobs') definitions.push(`CHECK ("state" NOT IN ('working','submitted','canceled','failed','rejected','completed','auth-required') OR eigos_try_jsonb("body") IS NOT NULL)`);
    if (name === 'ontology_pipeline_verifications') definitions.push('CHECK (eigos_try_jsonb("body") IS NOT NULL)');
    if (Object.entries(networkIndexes).some(([indexName, index]) => index.table === name && objects.some(object => object.type === 'index' && object.name === indexName))) definitions.push('CHECK (eigos_try_jsonb("body") IS NOT NULL)');
    // Network identity keys are validated string IDs. Reject any historical or
    // future value whose SQLite dynamic type would change uniqueness in PG.
    for (const [indexName, index] of Object.entries(networkIndexes)) {
      if (index.table !== name || !index.unique || !objects.some(object => object.type === 'index' && object.name === indexName)) continue;
      for (const part of index.parts) if ('path' in part) {
        const value = `(eigos_try_jsonb("body") #> '{${part.path.join(',')}}')`;
        definitions.push(`CHECK (${value} IS NULL OR jsonb_typeof(${value}) IN ('string','null'))`);
      }
    }
    if (db.prepare(`PRAGMA foreign_key_list(${nameQuoted})`).all().length) throw new Error(`Unreviewed foreign key: ${name}`);
    for (const index of db.prepare(`PRAGMA index_list(${nameQuoted})`).all()) {
      if (index.origin !== 'u') continue;
      const indexName = q(String(index.name));
      const indexInfo = db.prepare(`PRAGMA index_xinfo(${indexName})`).all().filter(row => Number(row.key) === 1);
      if (!indexInfo.length || indexInfo.some(row => Number(row.cid) < 0 || Number(row.desc) !== 0 || row.coll !== 'BINARY')) throw new Error(`Unsupported unique key: ${name}`);
      definitions.push(`UNIQUE (${indexInfo.map(row => q(String(row.name))).join(',')})`);
    }
    statements.push(`CREATE TABLE ${nameQuoted} (${definitions.join(', ')})`);
  }
  const indexRows = objects.filter(row => row.type === 'index' && row.sql !== null);
  for (const index of indexRows) {
    const name = String(index.name), table = String(index.tbl_name), source = String(index.sql);
    const indexName = q(name), tableName = q(table);
    if (!tableRows.some(row => row.name === table)) throw new Error(`Index names an unknown table: ${name}`);
    const meta = db.prepare(`PRAGMA index_list(${tableName})`).all().find(row => row.name === name);
    if (!meta || meta.origin !== 'c') throw new Error(`Unsupported explicit index: ${name}`);
    const fields = db.prepare(`PRAGMA index_xinfo(${indexName})`).all().filter(row => Number(row.key) === 1);
    if (!fields.length || fields.some(row => Number(row.desc) !== 0 || row.coll !== 'BINARY')) throw new Error(`Unsupported index ordering: ${name}`);
    const expression = fields.some(row => Number(row.cid) < 0);
    const network = networkIndexes[name];
    if (network) {
      const sourceParts = network.parts.map(part => 'column' in part ? part.column : `json_extract(body,'$.${part.path.join('.')}')`);
      const expected = `CREATE ${network.unique ? 'UNIQUE ' : ''}INDEX ${name} ON ${network.table}(${sourceParts.join(',')})`;
      if (table !== network.table || Number(meta.unique) !== Number(network.unique) || Number(meta.partial) !== 0 || canonical(source) !== canonical(expected)) throw new Error(`Unreviewed network index: ${name}`);
      const targetParts = network.parts.map(part => 'column' in part ? q(part.column) : `((eigos_try_jsonb("body") #>> '{${part.path.join(',')}}') COLLATE "C")`);
      statements.push(`CREATE ${network.unique ? 'UNIQUE ' : ''}INDEX ${indexName} ON ${tableName} (${targetParts.join(',')})`); continue;
    }
    const special = jsonIndexes[name];
    if (special) {
      if (table !== special.table || Number(meta.unique) !== 0 || canonical(source) !== canonical(special.source)) throw new Error(`Unreviewed JSON index: ${name}`);
      statements.push(special.target); continue;
    }
    const partial = partialUnique[name];
    if (partial) {
      if (table !== partial.table || Number(meta.unique) !== 1 || Number(meta.partial) !== 1 || expression || canonical(source) !== canonical(partial.source) || JSON.stringify(fields.map(row => String(row.name))) !== JSON.stringify(partial.columns)) throw new Error(`Unreviewed partial unique index: ${name}`);
      statements.push(`CREATE UNIQUE INDEX ${indexName} ON ${tableName} (${partial.columns.map(q).join(',')}) WHERE ${partial.predicate}`); continue;
    }
    if (expression || Number(meta.partial) !== 0 || /\bWHERE\b/i.test(source)) throw new Error(`Unreviewed expression or partial index: ${name}`);
    const columns = fields.map(row => q(String(row.name))).join(',');
    statements.push(`CREATE ${Number(meta.unique) === 1 ? 'UNIQUE ' : ''}INDEX ${indexName} ON ${tableName} (${columns})`);
  }
  const triggers = objects.filter(row => row.type === 'trigger');
  for (const trigger of triggers) {
    const name = String(trigger.name), table = String(trigger.tbl_name), sql = String(trigger.sql).replace(/\s+/g, ' ').trim();
    const networkMatch = /^network_evidence_(jobs|outcome_feedback|action_intents|ontology_objects|ontology_links)_(insert|update|delete)$/.exec(name);
    if (networkMatch) {
      const networkTable = networkMatch[1]!, action = networkMatch[2]!.toUpperCase(), record = action === 'DELETE' ? 'OLD' : 'NEW';
      const taskMatch = networkTable === 'jobs' ? `AND json_extract(e.body,'$.taskId')=${record}.id` : ['outcome_feedback','action_intents'].includes(networkTable) ? `AND json_extract(e.body,'$.taskId')=${record}.job_id` : '';
      const expected = `CREATE TRIGGER ${name} AFTER ${action} ON ${networkTable} WHEN EXISTS(SELECT 1 FROM network_evidence_cards e WHERE e.owner=${record}.owner ${taskMatch}) BEGIN UPDATE network_state SET value=CAST(value AS INTEGER)+1 WHERE key='activity_epoch'; END`;
      if (table !== networkTable || !tableRows.some(row => row.name === 'network_evidence_cards') || !tableRows.some(row => row.name === 'network_state') || canonical(sql) !== canonical(expected)) throw new Error(`Unreviewed network trigger: ${name}`);
      triggerStatements.push(`CREATE TRIGGER ${q(name)} AFTER ${action} ON ${q(table)} FOR EACH ROW EXECUTE FUNCTION eigos_network_evidence_invalidate()`); continue;
    }
    const match = /^CREATE TRIGGER ([A-Za-z_][A-Za-z0-9_]*) BEFORE (UPDATE|DELETE) ON ([A-Za-z_][A-Za-z0-9_]*) BEGIN SELECT RAISE\(ABORT,\s*'[^']*'\); END$/i.exec(sql);
    if (!match || match[1] !== name || match[3] !== table || !tableRows.some(row => row.name === table)) throw new Error(`Unreviewed trigger: ${name}`);
    triggerStatements.push(`CREATE TRIGGER ${q(name)} BEFORE ${match[2]!.toUpperCase()} ON ${q(table)} FOR EACH ROW EXECUTE FUNCTION eigos_immutable_history()`);
  }
  for (const table of tableRows) triggerStatements.push(`CREATE TRIGGER eigos_preserve_rowid BEFORE UPDATE ON ${q(String(table.name))} FOR EACH ROW EXECUTE FUNCTION eigos_preserve_rowid()`);
  return { tables: tableRows.length, indexes: indexRows.length, triggers: triggers.length, statements: [...statements, ...triggerStatements], schemaStatements: statements, triggerStatements, identities, requiresDataValidation: true, requiresRuntimePort: true };
}
