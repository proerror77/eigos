import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { digest } from './delegation.js';
import { JobStore } from './store.js';
import { businessTransaction } from './transaction.js';
import { installRuntimeAuthority, runtimeAuthoritySchema, runtimeAuthorityDigest, type RuntimeAuthority } from './runtime-authority.js';
import { DefinitionStore } from '../ontology/definition-store.js';
import { MemberStore } from '../members/store.js';

const sourceSchema = z.strictObject({ id: z.string().regex(/^[a-z][a-z0-9-]{0,59}$/), tasks: z.string().min(1), members: z.string().min(1) });
const inputSchema = z.strictObject({ sources: z.array(sourceSchema).min(1).max(8), foundationSource: z.string(), membershipSource: z.string(),
  expectedPolicyDigest: z.string().regex(/^[a-f0-9]{64}$/) });
export type ConsolidationInput = z.infer<typeof inputSchema>;
type Row = Record<string, SQLInputValue>;
type Table = { name: string; columns: string[]; sql: string; rows: Row[]; digest: string };
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const normalize = (value: unknown): unknown => value instanceof Uint8Array ? { bytes: Buffer.from(value).toString('base64') }
  : typeof value === 'bigint' ? { integer: String(value) } : Array.isArray(value) ? value.map(normalize)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k,v]) => [k,normalize(v)])) : value;
const hashFile = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const businessTables = new Set(['jobs','requests','action_intents','action_attempts','action_intent_versions','action_observations','plan_grants','budget_reservations',
  'aftersales_cases','outcome_feedback','capability_claims','capability_verifications','capability_change_proposals','preparation_contexts','member_model_usage',
  'ontology_objects','ontology_links','ontology_object_versions','ontology_scoped_objects','ontology_scoped_links','ontology_tombstones',
  'member_didi_source_admissions','personal_source_binding','member_source_credentials','member_source_fingerprints','member_source_requests']);
const memberOrder = ['members','member_connections','agent_registrations','agent_access_tokens','member_invitations'];

function snapshot(path: string): Table[] {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024 * 1024 || ['-wal','-journal'].some(s => existsSync(path+s) && lstatSync(path+s).size))
    throw new Error('Consolidation requires closed self-contained SQLite snapshots');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; BEGIN');
    if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new Error('Source snapshot is corrupt');
    return db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(table => {
      const name = String(table.name), columns = db.prepare(`PRAGMA table_info(${quote(name)})`).all().map(c => String(c.name));
      if (Number(db.prepare(`SELECT count(*) n FROM ${quote(name)}`).get()!.n) > 50000) throw new Error('Source table exceeds the consolidation limit');
      const rows = db.prepare(`SELECT * FROM ${quote(name)}`).all() as Row[];
      if (Buffer.byteLength(JSON.stringify(normalize(rows))) > 192 * 1024 * 1024) throw new Error('Source table exceeds the consolidation byte limit');
      return { name, columns, sql: String(table.sql), rows, digest: digest(rows.map(row => digest(normalize(row))).sort()) };
    });
  } finally { db.close(); }
}
function inspect(raw: ConsolidationInput) {
  const input = inputSchema.parse(raw), paths = input.sources.flatMap(s => [realpathSync(s.tasks),realpathSync(s.members)]);
  if (new Set(paths).size !== paths.length || new Set(input.sources.map(s => s.id)).size !== input.sources.length) throw new Error('Source identities and snapshot paths must be distinct');
  const sources = input.sources.map(source => ({ ...source, taskTables: snapshot(source.tasks), memberTables: snapshot(source.members), taskHash: hashFile(source.tasks), memberHash: hashFile(source.members) }));
  const base = sources.find(s => s.id === input.foundationSource), canonical = sources.find(s => s.id === input.membershipSource);
  if (!base || !canonical) throw new Error('Select existing foundation and membership sources');
  for (const source of sources) {
    const rows = (name: string) => source.taskTables.find(t => t.name === name)?.rows ?? [];
    for (const name of ['jobs','ontology_objects','ontology_links','ontology_definition_releases']) if (!source.taskTables.some(t => t.name === name)) throw new Error('A required source table is missing');
    if (rows('runtime_authority').length || rows('consolidation_receipt').length) throw new Error('An existing consolidated authority cannot be imported as a legacy source');
    if (rows('work_claims').length || rows('security_manager').some(r => Number(r.expires_at) > Date.now())) throw new Error('Stop source runtimes before capturing consolidation snapshots');
    if (rows('ontology_definition_drafts').some(r => r.status === 'open') || rows('security_fences').some(r => !['cleared','applied'].includes(String(r.state)))) throw new Error('Resolve in-flight source administration before consolidation');
    if (rows('security_policy_definitions')[0]?.digest !== input.expectedPolicyDigest) throw new Error('Source policy contract differs from the reviewed migration');
    if (source !== base && rows('security_settings')[0]?.mode !== 'legacy') throw new Error('Multiple permission authorities require a separate grant conflict review');
    // No old scheduling state is eligible for the new queue.
    if (rows('jobs').some(r => ['submitted','working'].includes(String(r.state)) && JSON.parse(String(r.body)).executionMode !== 'worker-security-archive')) throw new Error('Finish or explicitly pause source tasks before consolidation');
  }
  if (base.taskTables.find(t => t.name === 'security_settings')?.rows[0]?.mode !== 'foundation') throw new Error('The retained permission authority must use foundation security');
  const identities = new Map<string,Row>(), memberIds=new Map<string,string>(), aliases: { source: string; oldId: string; memberId: string; identityDigest: string }[] = [];
  for (const source of [canonical,...sources.filter(s => s !== canonical)]) for (const row of source.memberTables.find(t => t.name === 'members')?.rows ?? []) {
    const key = digest([row.issuer,row.tenant,row.subject]), current = identities.get(key);
    if(memberIds.has(String(row.id)) && memberIds.get(String(row.id))!==key)throw new Error('A member ID identifies different principals across sources');
    memberIds.set(String(row.id),key);
    if (current && (current.status !== row.status || !!current.accepted_at !== !!row.accepted_at)) throw new Error('Member consent or suspension differs across sources');
    if (!current) identities.set(key,row);
    aliases.push({ source: source.id, oldId: String(row.id), memberId: String((current ?? row).id), identityDigest: key });
  }
  const summary = sources.map(s => ({ id:s.id, taskHash:s.taskHash, memberHash:s.memberHash,
    tasks:s.taskTables.map(t => ({name:t.name,rows:t.rows.length,digest:t.digest,schema:digest(t.sql)})),
    members:s.memberTables.map(t => ({name:t.name,rows:t.rows.length,digest:t.digest,schema:digest(t.sql)})) }));
  return { input, sources, base, canonical, aliases, summary, sourceDigest: digest({ summary, aliases, foundationSource:input.foundationSource, membershipSource:input.membershipSource, policy:input.expectedPolicyDigest }) };
}
export function planConsolidation(input: ConsolidationInput) {
  const v = inspect(input);
  return { version:1, sourceDigest:v.sourceDigest, sources:v.summary, members:v.aliases, taskCount:v.sources.reduce((n,s) => n+s.taskTables.find(t=>t.name==='jobs')!.rows.length,0),
    activePermissionAuthority:input.foundationSource, newBusinessPermissions:0, replayedOperations:0 };
}
function insert(db: DatabaseSync, table: Table, row: Row) {
  const columns = db.prepare(`PRAGMA table_info(${quote(table.name)})`).all().map(c => String(c.name));
  if (table.columns.some(c => !columns.includes(c))) throw new Error('Destination schema cannot represent a source row');
  const names = table.columns;
  // Any PK or business uniqueness collision aborts the whole output copy.
  db.prepare(`INSERT INTO ${quote(table.name)} (${names.map(quote).join(',')}) VALUES (${names.map(()=>'?').join(',')})`).run(...names.map(c=>row[c]!));
}
/** Offline, copy-only consolidation. It does not accept raw live paths, issue
 * permissions, replay work, modify source facts or activate a source release. */
export function consolidateSnapshots(input: ConsolidationInput & { outputDirectory:string; expectedSourceDigest:string; authority:RuntimeAuthority }) {
  const {outputDirectory,expectedSourceDigest,authority:rawAuthority,...raw}=input, v=inspect(raw), authority=runtimeAuthoritySchema.parse(rawAuthority), target=resolve(outputDirectory);
  if (v.sourceDigest !== expectedSourceDigest) throw new Error('Source snapshots changed after the consolidation plan');
  if (authority.databasePath !== join(target,'tasks.sqlite') || authority.membershipDatabasePath !== join(target,'members.sqlite')) throw new Error('Authority must name the exact destination stores');
  if (existsSync(target) || !existsSync(dirname(target))) throw new Error('Use a new output directory with an existing private parent');
  const partial=target+'.partial-'+randomUUID(); mkdirSync(partial,{mode:0o700});
  const tasks=join(partial,'tasks.sqlite'),members=join(partial,'members.sqlite');
  const mapping=(source:string,id:string)=>v.aliases.find(a=>a.source===source && a.oldId===id)?.memberId ?? id;
  try {
    copyFileSync(v.base.tasks,tasks);copyFileSync(v.canonical.members,members);chmodSync(tasks,0o600);chmodSync(members,0o600);
    if(hashFile(tasks)!==v.base.taskHash || hashFile(members)!==v.canonical.memberHash)throw new Error('Source copy changed during consolidation');
    // Derive the destination contract from a fresh store; the reviewed source
    // digest above is mandatory, and both contracts enter the immutable receipt.
    const fresh=new JobStore(':memory:',{securityMode:'foundation'}), policy=fresh.security.policies.definitionDigest;fresh.close();
    const pre=new DatabaseSync(tasks);pre.prepare('UPDATE security_policy_definitions SET digest=? WHERE slot=1').run(policy);pre.exec('DELETE FROM security_manager; DELETE FROM work_claims; DELETE FROM security_cursors;');pre.close();
    const initialized=new JobStore(tasks,{securityMode:'foundation'});initialized.close();
    const memberStore=new MemberStore(members);memberStore.close();
    const md=new DatabaseSync(members);md.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    try {
      md.exec('DELETE FROM member_sessions');
      for(const source of v.sources.filter(s=>s!==v.canonical)) for(const name of memberOrder) {
        const table=source.memberTables.find(t=>t.name===name);if(!table)continue;
        for(const original of table.rows) {
          const row={...original};
          if(name==='members') {row.id=mapping(source.id,String(row.id));if(md.prepare('SELECT 1 FROM members WHERE id=?').get(row.id))continue;}
          if(row.member_id!==undefined && row.member_id!==null)row.member_id=mapping(source.id,String(row.member_id));
          insert(md,table,row);
        }
      }
      if(md.prepare('PRAGMA foreign_key_check').get())throw new Error('Merged membership references are invalid');
      md.exec('COMMIT');
    }catch(error){md.exec('ROLLBACK');throw error;}finally{md.close();}
    const db=new DatabaseSync(tasks);
    try {
      businessTransaction(db,()=>{
        db.exec('CREATE TABLE consolidation_archive(source_id TEXT NOT NULL,store_kind TEXT NOT NULL,table_name TEXT NOT NULL,ordinal INTEGER NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(source_id,store_kind,table_name,ordinal)); CREATE TABLE consolidation_receipt(slot INTEGER PRIMARY KEY CHECK(slot=1),body TEXT NOT NULL);');
        const archive=db.prepare('INSERT INTO consolidation_archive VALUES(?,?,?,?,?)');
        for(const source of v.sources)for(const [kind,tables] of [['tasks',source.taskTables],['members',source.memberTables]] as const)
          for(const table of tables)table.rows.forEach((row,i)=>archive.run(source.id,kind,table.name,i,JSON.stringify(normalize(row))));
        const definitions=new DefinitionStore(db);
        for(const source of v.sources.filter(s=>s!==v.base)) {
          for(const row of source.taskTables.find(t=>t.name==='ontology_definition_releases')!.rows)
            definitions.importHistoricalRelease({sourceAuthority:source.id,ref:{ontologyId:String(row.ontology_id),releaseId:String(row.id),digest:String(row.digest)},document:JSON.parse(String(row.body)),modelDigest:String(row.model_digest)});
          for(const table of source.taskTables) if(businessTables.has(table.name))for(const original of table.rows) {
            const row={...original};if(row.member_id!==undefined)row.member_id=mapping(source.id,String(row.member_id));
            insert(db,table,row);
          }
          for(const name of ['ontology_revisions','ontology_scoped_revisions'])for(const row of source.taskTables.find(t=>t.name===name)?.rows??[]) {
            const columns=Object.keys(row),keys=columns.filter(c=>c!=='revision'),where=keys.map(k=>quote(k)+'=?').join(' AND ');
            const old=db.prepare(`SELECT revision FROM ${quote(name)} WHERE ${where}`).get(...keys.map(k=>row[k]!));
            if(old)db.prepare(`UPDATE ${quote(name)} SET revision=? WHERE ${where}`).run(Math.max(Number(old.revision),Number(row.revision))+1,...keys.map(k=>row[k]!));
            else insert(db,{name,columns,rows:[],sql:'',digest:''},row);
          }
        }
        // Only identity references in permission records are translated. Task
        // bodies, source receipts, operation keys and immutable evidence remain exact.
        const aliases=v.aliases.filter(a=>a.source===v.base.id && a.oldId!==a.memberId);
        for(const table of v.base.taskTables.filter(t=>t.name.startsWith('security_'))) {
          if(table.columns.includes('member_id'))for(const a of aliases)db.prepare(`UPDATE ${quote(table.name)} SET member_id=? WHERE member_id=?`).run(a.memberId,a.oldId);
          if(!['security_grants','security_task_authorities','security_roles'].includes(table.name))continue;
          for(const row of db.prepare(`SELECT rowid,body FROM ${quote(table.name)}`).all()) {
            const body=JSON.parse(String(row.body));let changed=false;
            for(const key of ['memberId','approvedByMemberId',...(body.subjectKind==='member'?['subjectId']:[])])for(const a of aliases)if(body[key]===a.oldId){body[key]=a.memberId;changed=true;}
            if(changed && table.name==='security_roles')db.prepare('UPDATE security_roles SET id=?,subject_id=?,body=? WHERE rowid=?').run(digest([body.subjectKind,body.subjectId,body.resource]),body.subjectId,JSON.stringify(body),row.rowid!);
            else if(changed)db.prepare(`UPDATE ${quote(table.name)} SET body=? WHERE rowid=?`).run(JSON.stringify(body),row.rowid!);
          }
        }
        for(const a of aliases)db.prepare("UPDATE security_fences SET target_id=? WHERE kind='member' AND target_id=?").run(a.memberId,a.oldId);
        db.exec('UPDATE security_subjects SET valid_until=0; UPDATE security_policy SET revision=revision+1;');
        const expectedJobs=v.sources.flatMap(s=>s.taskTables.find(t=>t.name==='jobs')!.rows);
        for(const row of expectedJobs)if(db.prepare('SELECT body FROM jobs WHERE owner=? AND id=?').get(row.owner!,row.id!)?.body!==row.body)throw new Error('Task body changed during consolidation');
        const receipt={version:1,sourceDigest:v.sourceDigest,sources:v.summary,memberAliases:v.aliases,sourcePolicy:raw.expectedPolicyDigest,destinationPolicy:policy,authorityDigest:runtimeAuthorityDigest(authority),taskCount:expectedJobs.length,activeRelease:definitions.active().ref,newBusinessPermissions:0,replayedOperations:0,at:new Date().toISOString()};
        db.prepare('INSERT INTO consolidation_receipt VALUES(1,?)').run(JSON.stringify(receipt));
        for(const table of ['consolidation_archive','consolidation_receipt'])for(const op of ['UPDATE','DELETE'])db.exec(`CREATE TRIGGER ${table}_${op.toLowerCase()} BEFORE ${op} ON ${table} BEGIN SELECT RAISE(ABORT,'Consolidation history is immutable'); END;`);
      });
      installRuntimeAuthority(db,authority);
      if(db.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok')throw new Error('Merged task database integrity failed');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE');
    }finally{db.close();}
    const descriptor=join(partial,'authority.json');writeFileSync(descriptor,JSON.stringify(authority,null,2)+'\n',{mode:0o600,flag:'wx'});
    renameSync(partial,target);
    const check=new JobStore(authority.databasePath,{securityMode:'foundation',authority});check.close();
    return {outputDirectory:target,authorityId:authority.id,sourceDigest:v.sourceDigest,taskCount:planConsolidation(raw).taskCount};
  }catch(error){if(existsSync(partial))rmSync(partial,{recursive:true,force:true});throw error;}
}
