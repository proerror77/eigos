import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {copyFileSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,realpathSync,renameSync,writeFileSync,chmodSync} from 'node:fs';
import {dirname,join,resolve,relative,isAbsolute} from 'node:path';
import {z} from 'zod';
import {JobStore} from '../core/store.js';
import {digest} from '../core/delegation.js';
import {BACKEND_VERSION} from '../ontology/execution.js';
import {businessModel} from '../ontology/business-model.js';
import {OntologyObjectStore} from '../ontology/object-store.js';
import {sourceProof} from '../ontology/object-evidence.js';

const CONTRACT='eigos.security-migration.v1';
const ARCHIVE_MODE='worker-security-archive';
const businessTables=['jobs','requests','action_intents','action_attempts','action_intent_versions','action_observations','plan_grants','budget_reservations','aftersales_cases','outcome_feedback','capability_claims','capability_verifications','capability_change_proposals','preparation_contexts','ontology_objects','ontology_links','ontology_revisions'];
type Row=Record<string,SQLInputValue>;
type Table={name:string;columns:string[];rows:Row[];definition:string|null;fingerprint:string};
export interface MigrationInput {databaseSnapshot:string;membershipSnapshot:string;assetSnapshots?:{label:string;directory:string}[]}
const inputSchema=z.object({databaseSnapshot:z.string().min(1),membershipSnapshot:z.string().min(1),assetSnapshots:z.array(z.strictObject({label:z.string().regex(/^[a-z][a-z0-9-]{0,59}$/),directory:z.string().min(1)})).max(30).optional()});
const assetManifestSchema=z.array(z.strictObject({label:z.string().regex(/^[a-z][a-z0-9-]{0,59}$/),digest:z.string().regex(/^[a-f0-9]{64}$/),files:z.array(z.strictObject({path:z.string().min(1).max(2000).refine(p=>!isAbsolute(p) && p.split('/').every(v=>v && v!=='.' && v!=='..')),size:z.number().int().nonnegative(),sha256:z.string().regex(/^[a-f0-9]{64}$/)})).max(10000)})).max(30);
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
const fileHash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
const normalize=(value:unknown):unknown=>value instanceof Uint8Array?{bytes:Buffer.from(value).toString('base64')}:typeof value==='bigint'?{integer:String(value)}:Array.isArray(value)?value.map(normalize):value && typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,normalize(v)])):value;
const tableHash=(rows:Row[])=>digest(rows.map(row=>digest(normalize(row))).sort());
function snapshot(path:string) {
  const full=resolve(path),stat=lstatSync(full);
  if(!stat.isFile() || stat.isSymbolicLink() || stat.size>512*1024*1024 || ['-wal','-journal'].some(s=>existsSync(full+s) && lstatSync(full+s).size>0))throw new Error('Use a closed, self-contained regular SQLite snapshot');
  const db=new DatabaseSync(full,{readOnly:true});
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN');
    if(db.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok')throw new Error('Snapshot integrity check failed');
    return db;
  }catch(error){db.close();throw error;}
}
function tables(db:DatabaseSync):Table[] {
  return db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(table=>{
    const name=String(table.name),columns=db.prepare(`PRAGMA table_info(${quote(name)})`).all().map(c=>String(c.name));
    if(Number(db.prepare(`SELECT count(*) AS n FROM ${quote(name)}`).get()!.n)>50000)throw new Error('Snapshot table exceeds the migration row limit');
    const rows=db.prepare(`SELECT ${columns.map(quote).join(',')} FROM ${quote(name)}`).all() as Row[];
    const bytes=rows.reduce((n,row)=>n+Buffer.byteLength(JSON.stringify(normalize(row))),0);
    if(bytes>128*1024*1024)throw new Error('Snapshot table exceeds the migration byte limit');
    return {name,columns,rows,definition:table.sql===null?null:String(table.sql),fingerprint:tableHash(rows)};
  });
}
function assets(input:MigrationInput) {
  const names=new Set<string>();let bytes=0,count=0;
  return (input.assetSnapshots??[]).map(asset=>{
    z.string().regex(/^[a-z][a-z0-9-]{0,59}$/).parse(asset.label);
    if(names.has(asset.label))throw new Error('Duplicate asset label');names.add(asset.label);
    const root=realpathSync(asset.directory);if(lstatSync(asset.directory).isSymbolicLink() || !lstatSync(root).isDirectory())throw new Error('Asset snapshot must be a real directory');
    const files:{path:string;size:number;sha256:string}[]=[];
    const walk=(directory:string,prefix='')=>{
      for(const entry of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
        const path=join(directory,entry.name),relative=prefix+entry.name,stat=lstatSync(path);
        if(stat.isSymbolicLink())throw new Error('Asset snapshot cannot contain symlinks');
        if(stat.isDirectory())walk(path,relative+'/');
        else if(stat.isFile()) {
          bytes+=stat.size;count++;if(bytes>512*1024*1024 || count>10000)throw new Error('Asset snapshot exceeds the migration bound');
          files.push({path:relative,size:stat.size,sha256:fileHash(path)});
        } else throw new Error('Asset snapshot contains a non-regular entry');
      }
    };
    walk(root);return {label:asset.label,root,files,digest:digest(files)};
  });
}
function inspect(input:MigrationInput) {
  input=inputSchema.parse(input);
  if(realpathSync(input.databaseSnapshot)===realpathSync(input.membershipSnapshot))throw new Error('Task and member snapshots must be separate');
  const db=snapshot(input.databaseSnapshot),members=snapshot(input.membershipSnapshot);
  try {
    const records=tables(db),memberTables=tables(members),byName=new Map(records.map(t=>[t.name,t]));
    for(const name of ['jobs','requests','action_intents','ontology_objects','ontology_links'])if(!byName.has(name))throw new Error('Required task snapshot table is missing');
    for(const name of ['members','member_connections','agent_registrations'])if(!memberTables.some(t=>t.name===name))throw new Error('Required member snapshot table is missing');
    const header=byName.get('security_settings')?.rows;
    if(header && (header.length!==1 || ![1,2].includes(Number(header[0]!.version)) || !['legacy','foundation'].includes(String(header[0]!.mode))) || byName.has('security_migration_receipt'))throw new Error('Only unmarked legacy or earlier security snapshots need this migration');
    if(!header && records.some(t=>['security_grants','security_subjects','security_task_authorities'].includes(t.name)))throw new Error('Snapshot has orphaned security authority');
    if((byName.get('security_fences')?.rows??[]).some(r=>!['applied','cleared'].includes(String(r.state))))throw new Error('Resolve the pending authorization fence in the original authority before migration');
    if((byName.get('work_claims')?.rows??[]).some(r=>Number(r.expires_at)>Date.now()) || (byName.get('security_manager')?.rows??[]).some(r=>Number(r.expires_at)>Date.now()))throw new Error('Stop the source Gateway/Worker before capturing the offline snapshot');
    const source={taskDatabase:fileHash(input.databaseSnapshot),memberDatabase:fileHash(input.membershipSnapshot),tables:records.map(t=>({name:t.name,count:t.rows.length,digest:t.fingerprint,columns:t.columns,definitionDigest:digest(t.definition)})),memberTables:memberTables.map(t=>({name:t.name,count:t.rows.length,digest:t.fingerprint}))};
    const assetFiles=assets(input),assetSummary=assetFiles.map(({label,digest,files})=>({label,digest,files:files.length,bytes:files.reduce((n,f)=>n+f.size,0)}));
    return {records,memberTables,assetFiles,source,sourceDigest:digest({source,assets:assetSummary}),assetSummary,sourceMode:header?String(header[0]!.mode):'unmarked_legacy'};
  }finally{db.close();members.close();}
}
export function planSecurityMigration(input:MigrationInput) {
  const value=inspect(input);
  return {version:CONTRACT,mode:'offline_copy',sourceMode:value.sourceMode,sourceDigest:value.sourceDigest,
    counts:Object.fromEntries(value.records.map(t=>[t.name,t.rows.length])),assets:value.assetSummary,
    destinationSecurityVersion:2,permissionsGranted:0,legacyTasks:'quarantined_until_explicit_new_controller_grant',sourceChanged:false};
}
function migrationCandidates(db:DatabaseSync) {
  const graph=new OntologyObjectStore(db),roots=new Map<string,{revision:number}>();
  for(const row of db.prepare('SELECT owner,id,body FROM jobs').all()) {
    try {const job=JSON.parse(String(row.body)),request=job.delegation?.request;
      if(job.id===row.id && job.delegation.backendVersion===BACKEND_VERSION && request?.id===row.id && Number.isSafeInteger(request.revision) && request.revision>0)roots.set(JSON.stringify([row.owner,row.id]),{revision:request.revision});
    }catch{/* Historical/unrecognized jobs stay private and inactive. */}
  }
  let verified=0,unmapped=0;
  for(const row of db.prepare('SELECT owner,type,id,revision,definition_digest,body FROM ontology_objects').all()) {
    const ref={type:String(row.type),id:String(row.id)},owner=String(row.owner);
    try {
      if(row.definition_digest!==businessModel.fingerprint(ref.type))throw new Error('Historical definition');
      const properties=businessModel.parseProperties(ref.type,JSON.parse(String(row.body)).properties);
      const candidates=ref.type==='ServiceRequest'?[ref.id]:db.prepare("SELECT to_id FROM ontology_links WHERE owner=? AND from_type=? AND from_id=? AND to_type='ServiceRequest'").all(owner,ref.type,ref.id).map(r=>String(r.to_id));
      const valid=candidates.filter(taskId=>{
        const root=roots.get(JSON.stringify([owner,taskId]));
        return root && (ref.type==='ServiceRequest'?properties.revision===root.revision:properties.requestRevision===root.revision);
      });
      const proof=ref.type==='ServiceRequest'?{refs:[],levels:['accepted_submission']}:sourceProof(graph,owner,ref,{remaining:1000});
      if(!valid.length || !proof)throw new Error('Unproven historical binding');
      for(const taskId of new Set(valid))db.prepare('INSERT INTO security_migration_candidates VALUES(?,?,?,?,?,?,?)').run(owner,taskId,ref.type,ref.id,Number(row.revision),roots.get(JSON.stringify([owner,taskId]))!.revision,digest(proof));
      verified++;
    }catch{unmapped++;}
  }
  return {verifiedCandidates:verified,unmappedOrHistoricalObjects:unmapped,activeTaskBindings:0};
}
/** Creates a new private directory only. Source DBs, owner keys, object keys,
 * evidence bodies, operation keys and accounting rows are never rewritten. */
export function migrateSecuritySnapshots(input:MigrationInput & {outputDirectory:string;expectedSourceDigest:string}) {
  const value=inspect(input);
  if(value.sourceDigest!==input.expectedSourceDigest)throw new Error('Snapshot changed since review');
  const destination=resolve(input.outputDirectory);
  if(existsSync(destination))throw new Error('Migration destination must not exist');
  if(!existsSync(dirname(destination)))throw new Error('Create the private destination parent first');
  const actualDestination=join(realpathSync(dirname(destination)),destination.slice(destination.lastIndexOf('/')+1));
  if(value.assetFiles.some(asset=>{const rel=relative(asset.root,actualDestination);return !rel || !rel.startsWith('..') && !isAbsolute(rel);}))throw new Error('Migration output cannot modify an asset snapshot');
  const partial=destination+'.partial-'+randomUUID();mkdirSync(partial,{mode:0o700});
  const database=join(partial,'tasks.sqlite'),memberDatabase=join(partial,'members.sqlite');
  const store=new JobStore(database,{securityMode:'foundation'});store.close();
  const db=new DatabaseSync(database);db.exec('PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE');
  try {
    db.exec('CREATE TABLE security_migration_archive(table_name TEXT NOT NULL,ordinal INTEGER NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(table_name,ordinal)); CREATE TABLE security_migration_candidates(owner TEXT NOT NULL,task_id TEXT NOT NULL,type TEXT NOT NULL,object_id TEXT NOT NULL,object_revision INTEGER NOT NULL,request_revision INTEGER NOT NULL,evidence_digest TEXT NOT NULL,PRIMARY KEY(owner,task_id,type,object_id)); CREATE TABLE security_migration_receipt(slot INTEGER PRIMARY KEY CHECK(slot=1),body TEXT NOT NULL);');
    const archive=db.prepare('INSERT INTO security_migration_archive VALUES(?,?,?)');
    for(const table of value.records) {
      table.rows.forEach((row,index)=>archive.run(table.name,index,JSON.stringify(normalize(row))));
      if(!businessTables.includes(table.name))continue;
      const columns=db.prepare(`PRAGMA table_info(${quote(table.name)})`).all().map(c=>String(c.name));
      if(digest([...columns].sort())!==digest([...table.columns].sort()))throw new Error('Business table schema needs a reviewed migration');
      const insert=db.prepare(`INSERT INTO ${quote(table.name)} (${columns.map(quote).join(',')}) VALUES (${columns.map(()=>'?').join(',')})`);
      for(const original of table.rows) {
        const row={...original};
        if(table.name==='jobs') {
          const job=JSON.parse(String(row.body));if(!job || typeof job!=='object' || Array.isArray(job))throw new Error('Unrecognized task body requires explicit archive review');
          row.body=JSON.stringify({...job,executionMode:ARCHIVE_MODE});
        }
        insert.run(...columns.map(c=>row[c]!));
      }
    }
    const candidates=migrationCandidates(db);
    copyFileSync(input.membershipSnapshot,memberDatabase);chmodSync(memberDatabase,0o600);
    for(const asset of value.assetFiles){mkdirSync(join(partial,'assets',asset.label),{recursive:true,mode:0o700});for(const file of asset.files) {
      const target=join(partial,'assets',asset.label,file.path);mkdirSync(dirname(target),{recursive:true,mode:0o700});copyFileSync(join(asset.root,file.path),target);chmodSync(target,0o600);
      if(fileHash(target)!==file.sha256)throw new Error('Asset changed during copy');
    }}
    const copied=tables(db).filter(t=>businessTables.includes(t.name)).map(t=>({name:t.name,count:t.rows.length,digest:t.fingerprint}));
    if(fileHash(input.databaseSnapshot)!==value.source.taskDatabase || fileHash(input.membershipSnapshot)!==value.source.memberDatabase || fileHash(memberDatabase)!==value.source.memberDatabase || digest(assets(input))!==digest(value.assetFiles))throw new Error('Snapshot changed during migration');
    const receipt={version:CONTRACT,createdAt:new Date().toISOString(),sourceDigest:value.sourceDigest,source:value.source,sourceMode:value.sourceMode,targetSecurityVersion:2,targetTables:copied,
      assets:value.assetFiles.map(({label,files,digest})=>({label,files,digest})),candidates,permissionsGranted:0,executionMode:ARCHIVE_MODE,sourceChanged:false,
      archiveDigest:digest(value.records.flatMap(t=>t.rows.map((r,i)=>[t.name,i,normalize(r)])))};
    db.prepare('INSERT INTO security_migration_receipt VALUES(1,?)').run(JSON.stringify(receipt));db.exec('COMMIT');db.close();
    writeFileSync(join(partial,'migration.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600,flag:'wx'});
    verifySecurityMigration(partial);
    renameSync(partial,destination);
    return {version:CONTRACT,sourceDigest:value.sourceDigest,taskCount:copied.find(t=>t.name==='jobs')?.count??0,objectCount:copied.find(t=>t.name==='ontology_objects')?.count??0,candidates,permissionsGranted:0,verified:true};
  }catch(error){try{db.exec('ROLLBACK');}catch{}try{db.close();}catch{}throw error;}
}
export function verifySecurityMigration(directory:string) {
  const root=resolve(directory),db=snapshot(join(root,'tasks.sqlite'));
  try {
    const row=db.prepare('SELECT body FROM security_migration_receipt WHERE slot=1').get();if(!row)throw new Error('Migration receipt missing');
    const receipt=JSON.parse(String(row.body));
    if(receipt.version!==CONTRACT || digest(JSON.parse(readFileSync(join(root,'migration.json'),'utf8')))!==digest(receipt))throw new Error('Migration receipt changed');
    const current=tables(db).filter(t=>businessTables.includes(t.name)).map(t=>({name:t.name,count:t.rows.length,digest:t.fingerprint}));
    if(digest(current)!==digest(receipt.targetTables))throw new Error('Migrated business facts changed');
    const original=db.prepare('SELECT table_name,ordinal,record_json FROM security_migration_archive ORDER BY table_name,ordinal').all().map(r=>[r.table_name,r.ordinal,JSON.parse(String(r.record_json))]);
    if(digest(original)!==receipt.archiveDigest || fileHash(join(root,'members.sqlite'))!==receipt.source.memberDatabase)throw new Error('Archived facts or membership snapshot changed');
    const settings=db.prepare('SELECT mode,version FROM security_settings WHERE slot=1').get();
    const untouched=['security_grants','security_subjects','security_fences','security_events','security_roles','security_sources','security_recipients','security_model_channels','security_bindings','security_task_authorities','security_recoveries','security_object_origins','security_private_views','security_reads','security_outputs','security_artifacts','security_cursors'];
    if(settings?.mode!=='foundation' || settings.version!==2 || db.prepare('SELECT revision FROM security_policy WHERE slot=1').get()?.revision!==1 || untouched.some(table=>Number(db.prepare(`SELECT count(*) AS n FROM ${quote(table)}`).get()!.n)>0) || Number(db.prepare('SELECT count(*) AS n FROM work_claims').get()!.n) || Number(db.prepare("SELECT count(*) AS n FROM jobs WHERE json_extract(body,'$.executionMode')<>?").get(ARCHIVE_MODE)!.n))throw new Error('Migration target has new authority, policy or work activity');
    const manifest=assetManifestSchema.parse(receipt.assets);
    const actual=assets({databaseSnapshot:'',membershipSnapshot:'',assetSnapshots:manifest.map(a=>({label:a.label,directory:join(root,'assets',a.label)}))}).map(({label,files,digest})=>({label,files,digest}));
    if(digest(actual)!==digest(manifest))throw new Error('Migrated artifact changed');
    return {version:CONTRACT,verified:true,sourceDigest:receipt.sourceDigest,tables:current.map(({name,count})=>({name,count})),permissionsGranted:0};
  }finally{db.close();}
}
