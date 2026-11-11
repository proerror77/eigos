import type {Client} from 'pg';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {constants,openSync,closeSync,fstatSync,readSync,existsSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {z} from 'zod';
import {canonical,digest} from '../core/delegation.js';
import {planBusinessSnapshot,encodeBusinessRow,type BusinessColumn} from '../postgres/business-snapshot.js';
import {compileBusinessSchema} from '../postgres/business-schema.js';
import {verifyBusinessSnapshot,verifyTable,verifySequences} from '../postgres/business-verify.js';
import {auditImportedIdentities} from '../postgres/identity-audit.js';
import {assertPostgresMessagingStorageSchema} from '../postgres/messaging-schema.js';
import {assertReviewedPostgresActivation,checkActivationSchema,verifyPostgresPrimaryActivation} from '../postgres/host-runtime.js';
import {observePostgresClient} from '../postgres/client-errors.js';
import {postgresBindingSchema,postgresBindingIdentity,postgresHandoffSchema,postgresRuntimeSchemaReceiptSchema,postgresActivationSchema,POSTGRES_RUNTIME_SCHEMA_CONTRACT,readPinnedPostgresJson,readPostgresBinding,type PostgresBinding} from './postgres-binding.js';

const sha=z.string().regex(/^[a-f0-9]{64}$/),absolute=z.string().refine(isAbsolute),file=z.strictObject({path:absolute,sha256:sha});
const counts=z.number().int().min(0).safe(),instant=z.iso.datetime({offset:true}),authority=postgresBindingSchema.shape.sourceAuthority;
const verificationSchema=z.strictObject({version:z.literal(1),status:z.literal('verified-at-snapshot'),transactionStartedAt:instant,sourceFileDigest:sha,schemaDigest:sha,authorityDigest:sha,policyDigest:sha,
  tables:z.array(z.strictObject({name:z.string(),rows:counts,digest:sha})).max(10000),sequenceObservation:z.strictObject({checked:counts,atomicWithRows:z.literal(false)}),writerFenceVerified:z.literal(false),runtimeActivated:z.literal(false)});
const identitySchema=z.strictObject({version:z.literal(1),status:z.literal('audit-only'),checkedAt:counts,activeSubjects:counts,mismatchedSubjects:z.literal(0),runtimeActivated:z.literal(false)});
const sourceFenceSchema=z.strictObject({version:z.literal(1),kind:z.literal('eigos.source-authority-fence'),sourceAuthority:authority,businessSnapshotDigest:sha,membershipSnapshotDigest:sha,fencedAt:instant,
  gatewayStopReceiptDigest:sha,workerDrainReceiptDigest:sha,claimsObservationDigest:sha,authorityFenceReceiptDigest:sha});
export const postgresHandoffOperationSchema=z.strictObject({version:z.literal(1),kind:z.literal('eigos.postgres-handoff-operation'),phase:z.enum(['prepare-schema','activate']),
  adminIdentity:z.strictObject({user:z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}$/),role:z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}$/)}),
  binding:file,businessSnapshot:file,membershipSnapshot:file,sourceFence:file,businessVerification:file,identityAudit:file,
  fenceReceipts:z.strictObject({gatewayStop:file,workerDrain:file,claimsObservation:file,authorityFence:file})});
export type PostgresHandoffOperation=z.infer<typeof postgresHandoffOperationSchema>;
const q=(name:string)=>`"${name.replaceAll('"','""')}"`;
const equal=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const membershipTables=['members','member_sessions','member_connections','agent_registrations','agent_access_tokens','member_invitations'];
const protectedTables=new Set(['runtime_authority','security_policy_definitions','security_settings','security_recipient_policies']);
// Only mutations used by the installed PG ports. No authority/policy-definition
// DML, DDL, TRUNCATE, trigger privileges or arbitrary table grant list is input.
const mutations:Readonly<Record<string,readonly string[]>>=Object.freeze({
  jobs:['INSERT','UPDATE'],requests:['INSERT','UPDATE'],work_claims:['INSERT','UPDATE','DELETE'],runtime_work_claims:['INSERT','DELETE'],member_model_usage:['INSERT','UPDATE'],
  action_intents:['INSERT','UPDATE'],action_intent_versions:['INSERT'],action_attempts:['INSERT'],action_observations:['INSERT','UPDATE'],budget_reservations:['INSERT','UPDATE'],plan_grants:['INSERT','UPDATE'],
  ontology_objects:['INSERT','UPDATE'],ontology_links:['INSERT','DELETE'],ontology_revisions:['INSERT','UPDATE'],ontology_scoped_objects:['INSERT','UPDATE'],ontology_scoped_links:['INSERT','DELETE'],ontology_scoped_revisions:['INSERT','UPDATE'],ontology_object_versions:['INSERT'],ontology_tombstones:['INSERT'],
  ontology_projection_epochs:['INSERT','UPDATE'],
  ontology_namespaces:['INSERT','UPDATE'],ontology_definition_drafts:['INSERT','UPDATE'],ontology_definition_events:['INSERT'],ontology_definition_fingerprints:['INSERT'],ontology_definition_lineage:['INSERT'],ontology_definition_names:['INSERT'],ontology_definition_promotions:['INSERT'],ontology_definition_releases:['INSERT'],ontology_definition_revisions:['INSERT'],ontology_pipeline_events:['INSERT'],ontology_pipeline_intakes:['INSERT'],ontology_pipeline_verifications:['INSERT'],
  security_manager:['INSERT','UPDATE'],security_subjects:['INSERT','UPDATE'],security_grants:['INSERT','UPDATE'],security_sources:['INSERT','UPDATE'],security_task_authorities:['INSERT','UPDATE'],security_fences:['INSERT','UPDATE'],security_events:['INSERT'],security_policy:['UPDATE'],security_bindings:['INSERT','UPDATE'],security_outputs:['INSERT','UPDATE'],security_reads:['INSERT'],security_object_origins:['INSERT'],security_cursors:['INSERT','DELETE'],
  security_relay_identities:['INSERT','UPDATE'],security_relay_proofs:['INSERT','DELETE'],security_relay_reads:['INSERT','UPDATE'],security_relay_requests:['INSERT','UPDATE'],
  observation_contracts:['INSERT','UPDATE'],observation_contract_events:['INSERT'],
  messaging_grants:['INSERT','UPDATE'],messaging_messages:['INSERT','UPDATE'],messaging_requests:['INSERT'],messaging_node_leases:['INSERT','UPDATE'],network_state:['UPDATE'],
});
const nodeMutations:Readonly<Record<string,readonly string[]>>={eigos_relay_node_state:['INSERT'],eigos_relay_node_outbox:['INSERT','UPDATE'],eigos_relay_node_inbox:['INSERT','UPDATE'],eigos_relay_node_retained:['INSERT','DELETE']};
const memberMutations:Readonly<Record<string,readonly string[]>>={members:['INSERT','UPDATE'],member_sessions:['INSERT','DELETE'],member_connections:['INSERT','UPDATE'],agent_registrations:['INSERT','UPDATE'],agent_access_tokens:['INSERT','DELETE'],member_invitations:['INSERT','UPDATE']};

export function postgresRuntimeGrantPlan(binding:PostgresBinding,tables:readonly string[]){
  const b=postgresBindingSchema.parse(binding),contract=POSTGRES_RUNTIME_SCHEMA_CONTRACT;
  if(new Set(tables).size!==tables.length||tables.length>10000||tables.some(name=>!/^[_a-zA-Z][_a-zA-Z0-9]*$/.test(name)||name.startsWith('eigos_')))throw new Error('Invalid reviewed business table inventory');
  const business=Object.fromEntries(tables.map(name=>[name,name==='runtime_authority'?[]:['SELECT',...(protectedTables.has(name)?[]:mutations[name]??[])]]));
  business.eigos_migration_receipt=['SELECT'];business.eigos_business_mutex=['UPDATE'];business[contract.activationTable]=['SELECT'];business[contract.schemaReceiptTable]=['SELECT'];
  for(const table of contract.messagingNode.tables)business[table]=['SELECT',...nodeMutations[table]!];
  const membership=Object.fromEntries(membershipTables.map(name=>[name,['SELECT',...memberMutations[name]!]]));membership.eigos_membership_migration_receipt=['SELECT'];
  return {version:1 as const,role:b.connection.role,business:{schema:b.business.schema,tables:business,functions:['eigos_try_jsonb(text)','eigos_lock_runtime_authority()','eigos_current_runtime_authority()'],sequencePrivileges:['USAGE','SELECT']},membership:{schema:b.membership.schema,tables:membership,functions:[],sequencePrivileges:[]}};
}

function snapshotHash(path:string,maxBytes:number){
  if(!isAbsolute(path)||['-wal','-shm','-journal'].some(suffix=>existsSync(path+suffix)))throw new Error('A closed private source snapshot is required');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const before=fstatSync(fd);if(!before.isFile()||before.nlink!==1||before.mode&0o077||process.getuid&&before.uid!==process.getuid()||before.size<1||before.size>maxBytes)throw new Error('Invalid private source snapshot');
    const hash=createHash('sha256'),buffer=Buffer.alloc(1048576);let bytes=0;for(;;){const n=readSync(fd,buffer,0,buffer.length,null);if(!n)break;bytes+=n;if(bytes>before.size)throw new Error('Source snapshot changed');hash.update(buffer.subarray(0,n));}
    const after=fstatSync(fd);if(bytes!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw new Error('Source snapshot changed');return hash.digest('hex');
  }finally{closeSync(fd);}
}
function pinnedRaw(reference:z.infer<typeof file>,maxBytes=1048576){if(snapshotHash(reference.path,maxBytes)!==reference.sha256)throw new Error('Raw writer-fence receipt changed after review');}

/** Pure/local-file preparation only. Hash equality is not a claim that a
 * process stopped: the operator must obtain and review actual raw receipts.
 * This code creates no source fence, approval, inventory or activation fact. */
export function readPostgresHandoffOperation(input:unknown){
  const operation=postgresHandoffOperationSchema.parse(input);pinnedRaw(operation.binding,65536);
  const binding=readPostgresBinding(operation.binding.path).binding;
  if(!equal(binding.sourceAuthority,binding.authority))throw new Error('This handoff preserves the exact original authority; reviewed authority progression requires a separate tool');
  if(operation.businessSnapshot.sha256!==binding.business.sourceFileDigest||operation.membershipSnapshot.sha256!==binding.membership.sourceFileDigest)throw new Error('Source snapshots differ from the original binding');
  const plan=planBusinessSnapshot(operation.businessSnapshot.path,binding.sourceAuthority.digest,binding.business.importPolicyDigest);
  if(plan.fileDigest!==binding.business.sourceFileDigest||plan.schemaDigest!==binding.business.schemaDigest||!equal(plan.authority,binding.sourceAuthority)||snapshotHash(operation.membershipSnapshot.path,67108864)!==binding.membership.sourceFileDigest)throw new Error('Closed source snapshots differ from the reviewed source');
  const fence=sourceFenceSchema.parse(readPinnedPostgresJson(operation.sourceFence,65536));
  const verification=verificationSchema.parse(readPinnedPostgresJson(operation.businessVerification)),identity=identitySchema.parse(readPinnedPostgresJson(operation.identityAudit,65536));
  for(const [key,field] of [['gatewayStop','gatewayStopReceiptDigest'],['workerDrain','workerDrainReceiptDigest'],['claimsObservation','claimsObservationDigest'],['authorityFence','authorityFenceReceiptDigest']] as const){
    const reference=operation.fenceReceipts[key];if(reference.sha256!==fence[field])throw new Error('Raw writer-fence receipt does not match its original digest');pinnedRaw(reference);
  }
  if(!equal(fence.sourceAuthority,binding.sourceAuthority)||fence.businessSnapshotDigest!==plan.fileDigest||fence.membershipSnapshotDigest!==binding.membership.sourceFileDigest
    ||verification.sourceFileDigest!==plan.fileDigest||verification.schemaDigest!==plan.schemaDigest||verification.authorityDigest!==binding.sourceAuthority.digest||verification.policyDigest!==plan.policyDigest
    ||!equal(verification.tables,plan.tables.map(table=>({name:table.name,rows:table.rows,digest:table.digest})))||Date.parse(fence.fencedAt)>Date.parse(verification.transactionStartedAt)||identity.checkedAt<Date.parse(fence.fencedAt))throw new Error('Reviewed stop, independent verification or identity audit differs from the closed source');
  if(operation.phase==='prepare-schema'&&(binding.handoff||binding.activation))throw new Error('Schema preparation cannot predeclare an installation timestamp or activation receipt');
  if(operation.phase==='activate'){
    if(!binding.handoff||!binding.activation)throw new Error('Activation requires a separate reviewed final binding');
    const handoff=postgresHandoffSchema.parse(readPinnedPostgresJson(binding.handoff,65536));
    if(!equal(handoff.sourceFence,operation.sourceFence)||!equal(handoff.businessVerification,operation.businessVerification)||!equal(handoff.identityAudit,operation.identityAudit))throw new Error('Final handoff differs from the original reviewed evidence references');
  }
  return {operation,binding,plan,fence,verification,identity,grants:postgresRuntimeGrantPlan(binding,plan.tables.map(table=>table.name)),contractDigest:digest(POSTGRES_RUNTIME_SCHEMA_CONTRACT)};
}
export function previewPostgresHandoff(input:unknown){const checked=readPostgresHandoffOperation(input);return {version:1,status:'preview-only',phase:checked.operation.phase,adminIdentity:checked.operation.adminIdentity,bindingIdentity:postgresBindingIdentity(checked.binding),sourceAuthority:checked.binding.sourceAuthority,targetInspected:false,writerFenceVerified:false,
  sourceDigests:{business:checked.plan.fileDigest,membership:checked.binding.membership.sourceFileDigest},contractDigest:checked.contractDigest,grantPlan:checked.grants,grantPlanDigest:digest(checked.grants),tables:checked.plan.tables.length,writeScope:checked.operation.phase==='prepare-schema'?'exact-runtime-extension-and-acl-only':'one-immutable-activation-row-only',runtimeActivated:false};}

/** Requires an already opened serializable administrator transaction. It
 * verifies effective privileges, including column ACLs and inherited PUBLIC
 * grants; revoking a direct ACL cannot hide an inherited capability. */
export async function assertPostgresRuntimeRole(client:Client,binding:PostgresBinding,grants:ReturnType<typeof postgresRuntimeGrantPlan>,phase:'ungranted'|'granted'){
  if(client.getTransactionStatus()!=='T'||client.pipeline!==false)throw new Error('Runtime ACL verification requires the caller transaction snapshot');
  const role=binding.connection.role;
  const found=await client.query(`SELECT r.oid::text,r.rolcanlogin,r.rolsuper,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolinherit,
    (SELECT count(*)::int FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid) AS memberships,
    pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE') AS database_create
    FROM pg_catalog.pg_roles r WHERE r.rolname=$1`,[role]);
  const entry=found.rows[0];if(found.rowCount!==1||!entry?.rolcanlogin||entry.rolsuper||entry.rolbypassrls||entry.rolcreatedb||entry.rolcreaterole||entry.rolreplication||entry.rolinherit||entry.memberships!==0||entry.database_create)throw new Error('An existing isolated non-owner runtime login role is required');
  const ownership=await client.query(`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE pg_catalog.pg_has_role($1,n.nspowner,'MEMBER')) OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE pg_catalog.pg_has_role($1,c.relowner,'MEMBER')) OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE pg_catalog.pg_has_role($1,p.proowner,'MEMBER')) AS owns`,[role]);
  if(ownership.rows[0]?.owns!==false)throw new Error('Runtime role has DDL ownership capabilities');
  const external=await client.query(`SELECT n.nspname FROM pg_catalog.pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND n.nspname<>ALL($2::text[]) AND(
    pg_catalog.has_schema_privilege($1,n.oid,'CREATE') OR pg_catalog.has_schema_privilege($1,n.oid,'USAGE') AND(
      EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace=n.oid AND CASE WHEN c.relkind IN('r','p','v','m','f') THEN (pg_catalog.has_table_privilege($1,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR pg_catalog.has_any_column_privilege($1,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')) ELSE false END)
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace=n.oid AND CASE WHEN c.relkind='S' THEN pg_catalog.has_sequence_privilege($1,c.oid,'USAGE,SELECT,UPDATE') ELSE false END)
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace=n.oid AND pg_catalog.has_function_privilege($1,p.oid,'EXECUTE') AND NOT(n.nspname='public' AND p.proname='rls_auto_enable' AND p.prorettype='pg_catalog.event_trigger'::regtype AND p.pronargs=0)))) LIMIT 1`,[role,[binding.business.schema,binding.membership.schema]]);
  if(external.rowCount)throw new Error('Runtime role has effective capabilities outside the two reviewed schemas');
  for(const expected of [grants.business,grants.membership]){
    const schema=await client.query(`SELECT pg_catalog.has_schema_privilege($1,$2,'CREATE') AS create,pg_catalog.has_schema_privilege($1,$2,'USAGE') AS usage`,[role,expected.schema]);
    if(schema.rows[0]?.create!==false||schema.rows[0]?.usage!==(phase==='granted'))throw new Error('Runtime schema privileges differ');
    const columns=['SELECT','INSERT','UPDATE','REFERENCES'],all=['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'];
    const newTables=new Set<string>([...POSTGRES_RUNTIME_SCHEMA_CONTRACT.messagingNode.tables,POSTGRES_RUNTIME_SCHEMA_CONTRACT.activationTable,POSTGRES_RUNTIME_SCHEMA_CONTRACT.schemaReceiptTable]);
    const names=Object.keys(expected.tables).filter(name=>phase==='granted'||!newTables.has(name));
    for(const [privileges,fn] of [[all,'has_table_privilege'],[columns,'has_any_column_privilege']] as const){
      const rows=await client.query(`SELECT t.name AS table_name,p.name AS privilege,pg_catalog.${fn}($1,pg_catalog.format('%I.%I',$2::text,t.name),p.name) AS allowed FROM pg_catalog.unnest($3::text[]) t(name) CROSS JOIN pg_catalog.unnest($4::text[]) p(name)`,[role,expected.schema,names,privileges]);
      if(rows.rowCount!==names.length*privileges.length||rows.rows.some(row=>row.allowed!==(phase==='granted'&&(expected.tables[row.table_name]??[]).includes(row.privilege))))throw new Error('Runtime effective table or column privileges differ');
    }
    const sequences=await client.query(`SELECT c.relname,p.name AS privilege,CASE WHEN c.relkind='S' THEN pg_catalog.has_sequence_privilege($1,c.oid,p.name) ELSE false END AS allowed FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace CROSS JOIN pg_catalog.unnest(ARRAY['USAGE','SELECT','UPDATE']) p(name) WHERE n.nspname=$2 AND c.relkind='S'`,[role,expected.schema]);
    if(sequences.rows.some(row=>row.allowed!==(phase==='granted'&&expected.sequencePrivileges.includes(row.privilege))))throw new Error('Runtime sequence privileges differ');
    const functions=await client.query(`SELECT p.proname||'('||pg_catalog.oidvectortypes(p.proargtypes)||')' AS name,pg_catalog.has_function_privilege($1,p.oid,'EXECUTE') AS allowed FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$2`,[role,expected.schema]);
    if(phase==='granted'&&functions.rows.some(row=>row.allowed!==(expected.functions as readonly string[]).includes(row.name)))throw new Error('Runtime function privileges differ');
    if(phase==='ungranted'){
      // PostgreSQL's default PUBLIC EXECUTE is unreachable without schema
      // USAGE. Explicit pre-existing runtime ACLs still require review.
      const direct=await client.query(`SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a WHERE n.nspname=$2 AND a.grantee=$1::oid LIMIT 1`,[entry.oid,expected.schema]);
      if(direct.rowCount)throw new Error('Runtime function role was already granted');
    }
  }
}

/** Exact membership row equivalence, including revoked/expired records. This
 * separate read verifier never initializes MemberStore or authorizes a user. */
async function verifyMembershipRows(client:Client,binding:PostgresBinding,snapshot:string){
  const sqlite=new DatabaseSync(snapshot,{readOnly:true});
  try{
    sqlite.exec('PRAGMA query_only=ON; BEGIN');
    const objects=sqlite.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    if(createHash('sha256').update(JSON.stringify(objects)).digest('hex')!=='9e6c9641c27f0d403938ab746ccc5311a295823aeedb4c7a3943482df4b918ee'||sqlite.prepare('PRAGMA journal_mode').get()?.journal_mode!=='delete'||sqlite.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok'||sqlite.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Membership source schema or integrity differs');
    const actualNames=await client.query(`SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN('r','p','v','m','f') ORDER BY c.relname`,[binding.membership.schema]);
    if(!equal(actualNames.rows.map(row=>row.relname).sort(),[...membershipTables,'eigos_membership_migration_receipt'].sort()))throw new Error('Membership target inventory differs');
    const receipts=[];
    for(const [index,name] of membershipTables.entries()){
      const columns:BusinessColumn[]=sqlite.prepare(`PRAGMA table_info(${q(name)})`).all().map(row=>({name:String(row.name),type:String(row.type).toUpperCase(),notNull:Boolean(row.notnull),primaryKey:Number(row.pk)}));
      if(!columns.length||columns.some(column=>!['TEXT','INTEGER'].includes(column.type)))throw new Error('Unreviewed membership column');
      const target=await client.query(`SELECT a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,[binding.membership.schema,name]);
      if(!equal(target.rows.map(row=>[row.attname,row.type,row.attnotnull]),columns.map(column=>[column.name,column.type==='INTEGER'?'bigint':'text',column.notNull||column.primaryKey>0])))throw new Error('Membership target columns differ');
      const keys=columns.filter(column=>column.primaryKey).sort((a,b)=>a.primaryKey-b.primaryKey),order=keys.map(column=>q(column.name)+(column.type==='TEXT'?' COLLATE BINARY':'')).join(',');
      if(!keys.length)throw new Error('Membership source identity is missing');
      const source=sqlite.prepare(`SELECT ${columns.map(column=>q(column.name)).join(',')} FROM ${q(name)} ORDER BY ${order}`);source.setReadBigInts(true);
      const h=createHash('sha256');let n=0,maxRow=1;
      for(const row of source.iterate()){const body=encodeBusinessRow(row,columns,'sqlite'),bytes=Buffer.byteLength(body);if(bytes>8388608)throw new Error('Membership row exceeds the reviewed verification bound');h.update(`${bytes}:`).update(body);n++;maxRow=Math.max(maxRow,bytes);}
      const expected=h.digest('hex'),cursor=q(`eigos_handoff_members_${index}`),size=columns.map(column=>`coalesce(octet_length(${q(column.name)}${column.type==='INTEGER'?'::text':''}),0)`).join('+');
      await client.query(`DECLARE ${cursor} NO SCROLL CURSOR FOR SELECT ${columns.map(column=>`CASE WHEN (${size})<=${maxRow} THEN ${q(column.name)} END AS ${q(column.name)}`).join(',')},(${size})<=${maxRow} AS allowed FROM ${q(binding.membership.schema)}.${q(name)} ORDER BY ${keys.map(column=>q(column.name)+(column.type==='TEXT'?' COLLATE "C"':'')).join(',')}`);
      const readback=createHash('sha256');let seen=0;
      try{for(;;){const rows=await client.query(`FETCH FORWARD ${Math.max(1,Math.min(64,Math.floor(8388608/maxRow)))} FROM ${cursor}`);if(!rows.rowCount)break;for(const row of rows.rows){if(row.allowed!==true)throw new Error('Membership target row exceeds its source bound');const body=encodeBusinessRow(row,columns,'postgres');readback.update(`${Buffer.byteLength(body)}:`).update(body);if(++seen>n)throw new Error('Membership row readback differs');}}}
      finally{await client.query(`CLOSE ${cursor}`);}
      if(seen!==n||readback.digest('hex')!==expected)throw new Error('Membership row readback differs');receipts.push({table:name,rows:n,digest:expected});
    }
    const receipt=await client.query(`SELECT body FROM ${q(binding.membership.schema)}.eigos_membership_migration_receipt WHERE slot=1 LIMIT 2`);
    if(receipt.rowCount!==1||!equal(receipt.rows[0]?.body,{version:1,status:'imported-not-activated',sourceFileDigest:binding.membership.sourceFileDigest,tables:receipts})||digest(receipt.rows[0]?.body)!==binding.membership.receiptDigest)throw new Error('Membership row receipt differs from the closed source');
  }finally{sqlite.close();}
}

async function verifyOriginalRows(client:Client,checked:ReturnType<typeof readPostgresHandoffOperation>){
  const {binding,plan,operation}=checked,sqlite=new DatabaseSync(operation.businessSnapshot.path,{readOnly:true});let mapping:ReturnType<typeof compileBusinessSchema>;
  try{sqlite.exec('PRAGMA query_only=ON; BEGIN');mapping=compileBusinessSchema(sqlite);}finally{sqlite.close();}
  for(const [index,table] of plan.tables.entries())await verifyTable(client,binding.business.schema,table,index);
  await verifySequences(client,binding.business.schema,plan,mapping.identities);
  await verifyMembershipRows(client,binding,operation.membershipSnapshot.path);
  // Guard inventories and the actual functions are checked, rather than
  // trusting an immutable-table label or a receipt that merely names one.
  const triggers=await client.query(`SELECT c.relname,t.tgname,t.tgtype,t.tgenabled,t.tgattr::text AS attributes,t.tgqual IS NULL AS unconditional,t.tgnargs,p.proname,p.prosrc,p.prosecdef,pn.nspname
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND NOT t.tgisinternal`,[binding.business.schema,plan.tables.map(table=>table.name)]);
  const expected=mapping.triggerStatements.map(sql=>{
    const match=/CREATE TRIGGER "?([\w]+)"? (BEFORE|AFTER) (INSERT|UPDATE|DELETE) ON "([\w]+)" FOR EACH ROW EXECUTE FUNCTION ([\w]+)\(\)/.exec(sql);
    if(!match)throw new Error('Unreviewed original trigger mapping');return {table:match[4],name:match[1],fn:match[5],type:1+(match[2]==='BEFORE'?2:0)+({INSERT:4,UPDATE:16,DELETE:8}[match[3]!]??0)};
  });
  if(triggers.rowCount!==expected.length||triggers.rows.some(row=>!expected.some(value=>value.table===row.relname&&value.name===row.tgname&&value.fn===row.proname&&value.type===Number(row.tgtype))||row.tgenabled!=='O'||row.attributes!==''||row.unconditional!==true||Number(row.tgnargs)!==0||row.prosecdef!==false||row.nspname!==binding.business.schema))throw new Error('Original immutable/history trigger inventory differs');
  for(const sql of mapping.schemaStatements.filter(value=>value.startsWith('CREATE FUNCTION '))){
    const match=/CREATE FUNCTION (\w+)\(/.exec(sql),body=sql.split('$$')[1];if(!match||!body)throw new Error('Unreviewed original function mapping');
    const rows=await client.query(`SELECT p.prosrc,p.prosecdef,p.proconfig,p.pronargs,p.provolatile,p.prokind,l.lanname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE n.nspname=$1 AND p.proname=$2`,[binding.business.schema,match[1]]);
    if(rows.rowCount!==1||rows.rows[0]?.prosrc.trim()!==body.trim()||rows.rows[0]?.prosecdef!==false)throw new Error('Original immutable/history function differs');
    if(match[1]==='eigos_projection_epoch_invalidate'){
      const fn=rows.rows[0],paths=[`search_path=${q(binding.business.schema)}, pg_catalog, pg_temp`,`search_path=${binding.business.schema}, pg_catalog, pg_temp`];
      if(fn.pronargs!==0||fn.provolatile!=='v'||fn.prokind!=='f'||fn.lanname!=='plpgsql'||!Array.isArray(fn.proconfig)||fn.proconfig.length!==1||!paths.includes(fn.proconfig[0]))throw new Error('Original projection epoch function configuration differs');
    }
  }
  for(const [name,suffix] of [['eigos_lock_runtime_authority',' FOR UPDATE'],['eigos_current_runtime_authority','']] as const){
    const rows=await client.query(`SELECT p.prosrc,p.prosecdef,p.proretset,p.proisstrict,p.proleakproof,p.provolatile,p.proparallel,p.prokind,p.pronargs,p.proconfig,p.proowner=n.nspowner AS owner_matches,l.lanname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE n.nspname=$1 AND p.proname=$2`,[binding.business.schema,name]);
    const fn=rows.rows[0],body=`SELECT a.id,a.revision,a.configuration_digest FROM ${q(binding.business.schema)}.runtime_authority a WHERE a.slot=1${suffix}`;
    const bodyMatches=fn?.prosrc.trim()===body||name==='eigos_lock_runtime_authority'&&fn?.prosrc.trim()===body.replace(/ FOR UPDATE$/,' FOR SHARE');
    if(rows.rowCount!==1||!bodyMatches||fn.prosecdef!==true||fn.proretset!==true||fn.proisstrict!==false||fn.proleakproof!==false||fn.provolatile!=='v'||fn.proparallel!=='u'||fn.prokind!=='f'||Number(fn.pronargs)!==0||!equal(fn.proconfig,['search_path=pg_catalog, pg_temp'])||fn.owner_matches!==true||fn.lanname!=='sql')throw new Error('Original protected authority function differs');
  }
  if(planBusinessSnapshot(operation.businessSnapshot.path,binding.sourceAuthority.digest,binding.business.importPolicyDigest).fileDigest!==plan.fileDigest||snapshotHash(operation.membershipSnapshot.path,67108864)!==binding.membership.sourceFileDigest)throw new Error('Source snapshot changed during handoff verification');
}

async function assertTargetInventory(client:Client,checked:ReturnType<typeof readPostgresHandoffOperation>){
  const {binding,plan}=checked,contract=POSTGRES_RUNTIME_SCHEMA_CONTRACT;
  const tables=[...plan.tables.map(table=>table.name),'eigos_migration_receipt','eigos_business_mutex',contract.activationTable,contract.schemaReceiptTable,...contract.messagingNode.tables].sort();
  const actual=await client.query(`SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN('r','p','v','m','f') ORDER BY c.relname COLLATE "C"`,[binding.business.schema]);
  if(!equal(actual.rows.map(row=>row.relname).sort(),tables))throw new Error('Runtime relation inventory differs from the exact reviewed extension');
  const functions=await client.query(`SELECT p.proname,pg_catalog.oidvectortypes(p.proargtypes) AS args FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 ORDER BY p.proname,p.oid`,[binding.business.schema]);
  const expected=[...contract.baseFunctions,[contract.triggerFunction,''],['eigos_guard_relay_node_immutable','']];
  if(functions.rows.some(row=>row.proname==='eigos_network_evidence_invalidate'))expected.push(['eigos_network_evidence_invalidate','']);
  // Optional original-source helpers are determined from the pinned snapshot,
  // never from a function that happens to exist in the target schema.
  const source=new DatabaseSync(checked.operation.businessSnapshot.path,{readOnly:true});
  try{source.exec('PRAGMA query_only=ON; BEGIN');if(compileBusinessSchema(source).schemaStatements.some(sql=>sql.startsWith('CREATE FUNCTION eigos_projection_epoch_invalidate(')))expected.push(['eigos_projection_epoch_invalidate','']);}finally{source.close();}
  if(!equal(functions.rows.map(row=>[row.proname,row.args]).sort(),expected.sort()))throw new Error('Runtime function inventory differs from its reviewed extension');
  const sequences=await client.query(`SELECT c.relname,count(d.objid)::int AS owners,min(t.relname) AS table_name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_catalog.pg_depend d ON d.classid='pg_catalog.pg_class'::regclass AND d.objid=c.oid AND d.refclassid='pg_catalog.pg_class'::regclass AND d.deptype IN('a','i') LEFT JOIN pg_catalog.pg_class t ON t.oid=d.refobjid AND t.relnamespace=n.oid WHERE n.nspname=$1 AND c.relkind='S' GROUP BY c.oid,c.relname`,[binding.business.schema]);
  const nodeSequences=new Set<string>(contract.messagingNode.sequences);
  if(sequences.rowCount!==checked.verification.sequenceObservation.checked+nodeSequences.size||sequences.rows.some(row=>row.owners!==1||!tables.includes(row.table_name)||nodeSequences.has(row.relname)!==contract.messagingNode.tables.includes(row.table_name)))throw new Error('Runtime sequence inventory or ownership differs');
  const memberFunctions=await client.query(`SELECT p.proname,p.pronargs,p.prosecdef,p.prosrc FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1`,[binding.membership.schema]);
  const fn=memberFunctions.rows[0];if(memberFunctions.rowCount!==1||fn?.proname!=='eigos_membership_receipt_immutable'||Number(fn.pronargs)!==0||fn.prosecdef!==false||fn.prosrc.trim()!=="BEGIN RAISE EXCEPTION 'membership migration receipt is immutable'; END")throw new Error('Membership immutable receipt guard differs');
  const memberTriggers=await client.query(`SELECT c.relname,t.tgtype,t.tgenabled,t.tgqual IS NULL AS unconditional,t.tgattr::text AS attrs,t.tgnargs,p.proname,pn.nspname FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace WHERE n.nspname=$1 AND NOT t.tgisinternal`,[binding.membership.schema]);
  const trigger=memberTriggers.rows[0];if(memberTriggers.rowCount!==1||trigger?.relname!=='eigos_membership_migration_receipt'||trigger.nspname!==binding.membership.schema||Number(trigger.tgtype)!==27||trigger.tgenabled!=='O'||trigger.unconditional!==true||trigger.attrs!==''||Number(trigger.tgnargs)!==0||trigger.proname!=='eigos_membership_receipt_immutable')throw new Error('Membership immutable receipt trigger differs');
  const businessReceipt=await client.query(`SELECT t.tgtype,t.tgenabled,t.tgqual IS NULL AS unconditional,t.tgattr::text AS attrs,t.tgnargs,p.proname,pn.nspname FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace WHERE n.nspname=$1 AND c.relname='eigos_migration_receipt' AND NOT t.tgisinternal`,[binding.business.schema]);
  const guard=businessReceipt.rows[0];if(businessReceipt.rowCount!==1||guard?.nspname!==binding.business.schema||guard.proname!=='eigos_immutable_history'||Number(guard.tgtype)!==27||guard.tgenabled!=='O'||guard.unconditional!==true||guard.attrs!==''||Number(guard.tgnargs)!==0)throw new Error('Business migration receipt guard differs');
  const policies=await client.query(`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1::text[]) AND(c.relrowsecurity OR c.relforcerowsecurity)) OR EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid=r.ev_class JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1::text[])) OR EXISTS(SELECT 1 FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid=p.polrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1::text[])) AS unreviewed`,[[binding.business.schema,binding.membership.schema]]);
  if(policies.rows[0]?.unreviewed!==false)throw new Error('Unreviewed rule or row policy in imported runtime');
}

async function assertNoOtherGrantees(client:Client,binding:PostgresBinding,after:boolean){
  const rows=await client.query(`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n CROSS JOIN LATERAL pg_catalog.aclexplode(n.nspacl) a WHERE n.nspname=ANY($1::text[]) AND a.grantee<>n.nspowner AND a.grantee<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=$2))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a WHERE n.nspname=ANY($1::text[]) AND a.grantee<>c.relowner AND a.grantee<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=$2))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute att JOIN pg_catalog.pg_class c ON c.oid=att.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL pg_catalog.aclexplode(att.attacl) a WHERE n.nspname=ANY($1::text[]) AND a.grantee<>c.relowner AND a.grantee<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=$2))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a WHERE n.nspname=ANY($1::text[]) AND a.grantee<>p.proowner AND a.grantee<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=$2) AND($3 OR a.grantee<>0)) AS other`,[[binding.business.schema,binding.membership.schema],binding.connection.role,after]);
  if(rows.rows[0]?.other!==false)throw new Error('Target schema has unreviewed PUBLIC or other-role ACLs');
}

function activationDDL(schema:string){const s=q(schema),contract=POSTGRES_RUNTIME_SCHEMA_CONTRACT;return [
  `CREATE TABLE ${s}.${q(contract.activationTable)}(id TEXT PRIMARY KEY,body JSONB NOT NULL)`,
  `CREATE TABLE ${s}.${q(contract.schemaReceiptTable)}(slot BIGINT PRIMARY KEY CHECK(slot=1),body JSONB NOT NULL)`,
  `CREATE FUNCTION ${s}.${q(contract.triggerFunction)}() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ ${contract.triggerBody} $$`,
  ...[contract.activationTable,contract.schemaReceiptTable].map(table=>`CREATE TRIGGER ${q(`${table}_immutable`)} BEFORE UPDATE OR DELETE ON ${s}.${q(table)} FOR EACH ROW EXECUTE FUNCTION ${s}.${q(contract.triggerFunction)}()`),
];}
async function applyPrivileges(client:Client,grants:ReturnType<typeof postgresRuntimeGrantPlan>){
  const role=q(grants.role);
  for(const group of [grants.business,grants.membership]){
    const schema=q(group.schema);
    await client.query(`REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC,${role}`);
    for(const type of ['TABLES','SEQUENCES','FUNCTIONS'])await client.query(`REVOKE ALL ON ALL ${type} IN SCHEMA ${schema} FROM PUBLIC,${role}`);
    await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    for(const [table,privileges] of Object.entries(group.tables))if(privileges.length)await client.query(`GRANT ${privileges.join(',')} ON TABLE ${schema}.${q(table)} TO ${role}`);
    const seq=await client.query(`SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='S'`,[group.schema]);
    for(const row of seq.rows)if(group.sequencePrivileges.length)await client.query(`GRANT ${group.sequencePrivileges.join(',')} ON SEQUENCE ${schema}.${q(row.relname)} TO ${role}`);
    for(const name of group.functions)await client.query(`GRANT EXECUTE ON FUNCTION ${schema}.${name} TO ${role}`);
  }
}

async function lockHandoff(client:Client,checked:ReturnType<typeof readPostgresHandoffOperation>,runtimeExtension=false,readOnly=false){
  const {binding,plan}=checked;
  await client.query("SET LOCAL lock_timeout='10000ms'; SET LOCAL statement_timeout='60000ms'; SET LOCAL idle_in_transaction_session_timeout='60000ms'");
  // LOCK is a utility statement: obtain all original table locks before the
  // first SELECT fixes SERIALIZABLE's MVCC snapshot. Never certify stale rows
  // captured while waiting for another writer's table lock.
  const extension=runtimeExtension||checked.operation.phase==='activate'?[...POSTGRES_RUNTIME_SCHEMA_CONTRACT.messagingNode.tables,POSTGRES_RUNTIME_SCHEMA_CONTRACT.activationTable,POSTGRES_RUNTIME_SCHEMA_CONTRACT.schemaReceiptTable]:[];
  const relations=[...plan.tables.map(table=>table.name),'eigos_migration_receipt','eigos_business_mutex',...extension].map(table=>`${q(binding.business.schema)}.${q(table)}`);
  relations.push(...[...membershipTables,'eigos_membership_migration_receipt'].map(table=>`${q(binding.membership.schema)}.${q(table)}`));
  await client.query(`LOCK TABLE ${relations.sort().join(',')} IN ${readOnly?'ACCESS SHARE':'ACCESS EXCLUSIVE'} MODE`);
  for(const schema of [binding.business.schema,binding.membership.schema].sort())await client.query('SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext($1))',[schema]);
  await assertAdminIdentity(client,checked);
  const sessions=await client.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity WHERE usename=$1 AND pid<>pg_backend_pid()`,[binding.connection.role]);
  if(sessions.rows[0]?.n!==0)throw new Error('Runtime role has another session; stop and drain it before handoff');
  const live=await client.query(`SELECT EXISTS(SELECT 1 FROM ${q(binding.business.schema)}.security_manager WHERE expires_at>floor(extract(epoch FROM clock_timestamp())*1000)::bigint) OR EXISTS(SELECT 1 FROM ${q(binding.business.schema)}.work_claims WHERE expires_at>floor(extract(epoch FROM clock_timestamp())*1000)::bigint) AS active`);
  if(live.rows[0]?.active!==false)throw new Error('Original manager or task leases are still live; handoff never expires or replaces them');
  const row=await client.query(`SELECT id,revision,configuration_digest FROM ${q(binding.business.schema)}.runtime_authority WHERE slot=1 LIMIT 2`);
  if(row.rowCount!==1||row.rows[0]?.id!==binding.authority.id||Number(row.rows[0]?.revision)!==binding.authority.revision||row.rows[0]?.configuration_digest!==binding.authority.digest)throw new Error('Original authority identity changed');
}

async function assertAdminIdentity(client:Client,checked:ReturnType<typeof readPostgresHandoffOperation>){
  const found=await client.query("SELECT current_database() AS database,current_user AS role,session_user AS session_role,current_setting('server_encoding') AS encoding"),row=found.rows[0];
  if(found.rowCount!==1||row?.database!==checked.binding.connection.database||row.role!==checked.operation.adminIdentity.role||row.session_role!==checked.operation.adminIdentity.role||row.encoding!=='UTF8')throw new Error('Administrator connection differs from the reviewed target identity');
}

async function transaction<T>(client:Client,action:()=>Promise<T>,readOnly=false){
  if(client.getTransactionStatus()!=='I'||client.pipeline!==false)throw new Error('Handoff requires its own idle non-pipelined administrator connection');
  const observed=observePostgresClient(client);let opened=false,committing=false;
  try{observed.check();await client.query(readOnly?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN ISOLATION LEVEL SERIALIZABLE');opened=true;const result=await action();observed.check();if(client.getTransactionStatus()!=='T')throw new Error('Handoff transaction boundary was lost');committing=true;await client.query('COMMIT');opened=false;observed.check();return result;}
  catch(error){
    if(committing)throw new Error('PostgreSQL handoff COMMIT outcome is unknown; inspect immutable receipts before any manual retry',{cause:observed.annotate(error)});
    if(opened)try{await client.query('ROLLBACK');observed.check();}catch(rollback){throw new AggregateError([observed.annotate(error),observed.annotate(rollback)],'PostgreSQL handoff rollback is unknown; inspect target before retrying');}
    throw observed.annotate(error);
  }finally{observed.close();}
}

/** Explicit administrative write step only. Source data, permissions and
 * task rows remain byte-equivalent. No publisher/node/provider is started. */
export async function preparePostgresRuntimeSchema(client:Client,input:unknown){
  const checked=readPostgresHandoffOperation(input);if(checked.operation.phase!=='prepare-schema')throw new Error('Expected the separate schema preparation phase');
  const {binding,operation,plan,grants}=checked;
  // Preserve the original strict verifier, including its rejection of extras.
  const fresh=await verifyBusinessSnapshot(client,{snapshot:operation.businessSnapshot.path,schema:binding.business.schema,expectedFileDigest:plan.fileDigest,expectedAuthorityDigest:binding.sourceAuthority.digest,expectedPolicyDigest:binding.business.importPolicyDigest});
  if(!equal(fresh.tables,checked.verification.tables))throw new Error('Fresh strict verification differs from reviewed evidence');
  const identity=await auditImportedIdentities(client,{businessSchema:binding.business.schema,membershipSchema:binding.membership.schema,businessFileDigest:plan.fileDigest,membershipFileDigest:binding.membership.sourceFileDigest,now:Date.now()});
  if(identity.mismatchedSubjects!==0)throw new Error('Fresh identity audit failed');
  return transaction(client,async()=>{
    await lockHandoff(client,checked);await verifyOriginalRows(client,checked);
    await assertPostgresRuntimeRole(client,binding,grants,'ungranted');await assertNoOtherGrantees(client,binding,false);
    const extra=await client.query(`SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) UNION ALL SELECT p.proname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname=ANY($3::text[])`,[binding.business.schema,[...POSTGRES_RUNTIME_SCHEMA_CONTRACT.messagingNode.tables,...POSTGRES_RUNTIME_SCHEMA_CONTRACT.messagingNode.sequences,POSTGRES_RUNTIME_SCHEMA_CONTRACT.activationTable,POSTGRES_RUNTIME_SCHEMA_CONTRACT.schemaReceiptTable],[POSTGRES_RUNTIME_SCHEMA_CONTRACT.triggerFunction,'eigos_guard_relay_node_immutable']]);
    if(extra.rowCount)throw new Error('Runtime extension already exists or is partial; inspect it, never overwrite or retry an unknown commit');
    for(const sql of POSTGRES_RUNTIME_SCHEMA_CONTRACT.messagingNode.ddl)await client.query(sql.replaceAll('__SCHEMA__',q(binding.business.schema)));
    for(const sql of activationDDL(binding.business.schema))await client.query(sql);
    await applyPrivileges(client,grants);await assertPostgresRuntimeRole(client,binding,grants,'granted');await assertNoOtherGrantees(client,binding,true);await assertTargetInventory(client,checked);
    await client.query(`SET LOCAL ROLE ${q(binding.connection.role)}`);
    // A failed role check rolls back this entire transaction, including LOCAL
    // ROLE. Sending RESET after a server error can mask its first cause.
    await checkActivationSchema(client,binding.business.schema);await assertPostgresMessagingStorageSchema(client,binding.business.schema);await client.query('RESET ROLE');
    const clock=await client.query('SELECT clock_timestamp() AS at');
    const installedAt=new Date(clock.rows[0]?.at).toISOString();
    const receipt=postgresRuntimeSchemaReceiptSchema.parse({version:1,kind:'eigos.postgres-runtime-schema',businessSchema:binding.business.schema,baseSchemaDigest:binding.business.schemaDigest,contractDigest:checked.contractDigest,baseVerificationDigest:operation.businessVerification.sha256,installedAt});
    if(Date.parse(installedAt)<Date.parse(checked.verification.transactionStartedAt))throw new Error('Actual schema installation precedes reviewed verification');
    await client.query(`INSERT INTO ${q(binding.business.schema)}.${q(POSTGRES_RUNTIME_SCHEMA_CONTRACT.schemaReceiptTable)}(slot,body) VALUES(1,$1::jsonb)`,[JSON.stringify(receipt)]);
    const saved=await client.query(`SELECT body FROM ${q(binding.business.schema)}.${q(POSTGRES_RUNTIME_SCHEMA_CONTRACT.schemaReceiptTable)} WHERE slot=1 LIMIT 2`);
    if(saved.rowCount!==1||!equal(saved.rows[0]?.body,receipt))throw new Error('Actual immutable schema receipt readback differs');
    return {version:1,status:'schema-prepared-not-activated',schemaReceipt:receipt,schemaReceiptDigest:digest(receipt),grantPlanDigest:digest(grants),runtimeActivated:false};
  });
}

/** Independent post-COMMIT reader. The CLI uses a newly connected admin
 * client, repeats row/schema/ACL checks and reads the actual stored receipt.
 * It never repairs, replaces or activates a partially prepared destination. */
export async function verifyPreparedPostgresRuntimeSchema(client:Client,input:unknown){
  const checked=readPostgresHandoffOperation(input),{binding}=checked;
  return transaction(client,async()=>{
    await assertAdminIdentity(client,checked);
    await verifyOriginalRows(client,checked);await assertTargetInventory(client,checked);await assertPostgresRuntimeRole(client,binding,checked.grants,'granted');await assertNoOtherGrantees(client,binding,true);
    await client.query(`SET LOCAL ROLE ${q(binding.connection.role)}`);
    // A failed role check rolls back this entire transaction, including LOCAL
    // ROLE. Sending RESET after a server error can mask its first cause.
    await checkActivationSchema(client,binding.business.schema);await assertPostgresMessagingStorageSchema(client,binding.business.schema);await client.query('RESET ROLE');
    const rows=await client.query(`SELECT body FROM ${q(binding.business.schema)}.${q(POSTGRES_RUNTIME_SCHEMA_CONTRACT.schemaReceiptTable)} WHERE slot=1 LIMIT 2`);
    if(rows.rowCount!==1)throw new Error('Committed schema receipt is missing');const receipt=postgresRuntimeSchemaReceiptSchema.parse(rows.rows[0]?.body);
    if(receipt.businessSchema!==binding.business.schema||receipt.baseSchemaDigest!==binding.business.schemaDigest||receipt.contractDigest!==checked.contractDigest||receipt.baseVerificationDigest!==checked.operation.businessVerification.sha256||Date.parse(receipt.installedAt)<Date.parse(checked.verification.transactionStartedAt))throw new Error('Committed schema receipt differs from independently read storage');
    const activations=await client.query(`SELECT count(*)::int AS n FROM ${q(binding.business.schema)}.${q(POSTGRES_RUNTIME_SCHEMA_CONTRACT.activationTable)}`),activationRecords=activations.rows[0]?.n;
    if(!Number.isSafeInteger(activationRecords)||activationRecords<0||checked.operation.phase==='prepare-schema'&&activationRecords!==0)throw new Error('Unexpected activation record during schema preparation');
    return {version:1,status:'schema-verified',schemaReceiptDigest:digest(receipt),activationRecords,runtimeStarted:false};
  },true);
}

/** Host-only administrator boundary for offline node migration/readback. It
 * reuses the exact original-row, schema, ACL and owner checks, never a running
 * publisher. The separate storage context further restricts the node scope. */
export async function withPreparedPostgresNodeTransaction<T>(client:Client,input:unknown,action:(checked:ReturnType<typeof readPostgresHandoffOperation>)=>Promise<T>,readOnly=false){
  const checked=readPostgresHandoffOperation(input);
  if(checked.operation.phase!=='prepare-schema')throw new Error('Offline node migration requires the separate pre-activation schema operation');
  return transaction(client,async()=>{
    await lockHandoff(client,checked,true,readOnly);
    await verifyOriginalRows(client,checked);await assertTargetInventory(client,checked);await assertPostgresRuntimeRole(client,checked.binding,checked.grants,'granted');await assertNoOtherGrantees(client,checked.binding,true);
    await assertPostgresMessagingStorageSchema(client,checked.binding.business.schema);
    const activations=await client.query(`SELECT 1 FROM ${q(checked.binding.business.schema)}.eigos_runtime_activation LIMIT 1`);
    if(activations.rowCount)throw new Error('Offline node migration cannot run after activation');
    return action(checked);
  },readOnly);
}

/** Separate reviewed activation phase, including actual admin AEAD/full-row
 * node readback when Relay is enabled. It never starts an authorization lease. */
export async function activatePostgresPrimary(client:Client,input:unknown,options:{relayWrappingKey?:CryptoKey}={}){
  const checked=readPostgresHandoffOperation(input);if(checked.operation.phase!=='activate')throw new Error('Expected the separate reviewed activation phase');
  const {binding,grants}=checked;
  if(binding.relay&&!options.relayWrappingKey)throw new Error('Activation requires the existing host Relay wrapping key for actual offline node readback');
  const freshIdentity=await auditImportedIdentities(client,{businessSchema:binding.business.schema,membershipSchema:binding.membership.schema,businessFileDigest:binding.business.sourceFileDigest,membershipFileDigest:binding.membership.sourceFileDigest,now:Date.now()});
  if(freshIdentity.mismatchedSubjects!==0)throw new Error('Fresh identity audit failed');
  const handoff=postgresHandoffSchema.parse(readPinnedPostgresJson(binding.handoff!,65536));
  const activation=postgresActivationSchema.parse({version:1,kind:'eigos.postgres-activation',id:binding.activation!.id,bindingIdentity:postgresBindingIdentity(binding),sourceAuthority:binding.sourceAuthority,targetAuthority:binding.authority,businessSchema:binding.business.schema,membershipSchema:binding.membership.schema,
    handoffDigest:binding.handoff!.sha256,sourceFenceDigest:handoff.sourceFence.sha256,businessVerificationDigest:handoff.businessVerification.sha256,identityAuditDigest:handoff.identityAudit.sha256,runtimeSchemaReceiptDigest:binding.activation!.runtimeSchemaReceiptDigest,reviewDigest:handoff.reviewDigest});
  return transaction(client,async()=>{
    await lockHandoff(client,checked);await verifyOriginalRows(client,checked);await assertTargetInventory(client,checked);await assertPostgresRuntimeRole(client,binding,grants,'granted');await assertNoOtherGrantees(client,binding,true);
    const schema=q(binding.business.schema),existing=await client.query(`SELECT id FROM ${schema}.${q(POSTGRES_RUNTIME_SCHEMA_CONTRACT.activationTable)} LIMIT 1`);
    if(existing.rowCount)throw new Error('An activation record already exists; inspect it rather than retrying or replacing it');
    const receipt=await client.query(`SELECT body FROM ${schema}.${q(POSTGRES_RUNTIME_SCHEMA_CONTRACT.schemaReceiptTable)} WHERE slot=1 LIMIT 2`),imported=await client.query(`SELECT body FROM ${schema}.eigos_migration_receipt WHERE slot=1 LIMIT 2`);
    if(receipt.rowCount!==1||imported.rowCount!==1)throw new Error('Actual immutable migration or schema receipt is missing');
    assertReviewedPostgresActivation(binding,{handoff,sourceFence:checked.fence,businessVerification:checked.verification,identityAudit:checked.identity,runtimeSchema:receipt.rows[0]?.body,activation,businessImport:imported.rows[0]?.body});
    if(binding.relay){const {verifyPostgresNodesForActivation}=await import('./postgres-node-migration.js');await verifyPostgresNodesForActivation(client,binding,options.relayWrappingKey!,checked.operation.adminIdentity.role,checked.operation.businessVerification.sha256);}
    await client.query(`SET LOCAL ROLE ${q(binding.connection.role)}`);
    // A failed role check rolls back this entire transaction, including LOCAL
    // ROLE. Sending RESET after a server error can mask its first cause.
    await checkActivationSchema(client,binding.business.schema);await assertPostgresMessagingStorageSchema(client,binding.business.schema);await client.query('RESET ROLE');
    await client.query(`INSERT INTO ${schema}.${q(POSTGRES_RUNTIME_SCHEMA_CONTRACT.activationTable)}(id,body) VALUES($1,$2::jsonb)`,[activation.id,JSON.stringify(activation)]);
    const readback=await client.query(`SELECT body FROM ${schema}.${q(POSTGRES_RUNTIME_SCHEMA_CONTRACT.activationTable)} WHERE id=$1 LIMIT 2`,[activation.id]);
    if(readback.rowCount!==1||!equal(readback.rows[0]?.body,activation))throw new Error('Activation readback differs from reviewed evidence');
    return {version:1,status:'activation-recorded-not-started',activationDigest:digest(activation),runtimeStarted:false};
  });
}

/** Fresh independent runtime connection after acknowledged administrative
 * commit. Failure never removes a receipt or attempts another activation. */
export async function verifyPostgresHandoffRuntime(client:Client,input:unknown){const {binding}=readPostgresHandoffOperation(input);await verifyPostgresPrimaryActivation(client,binding);return {version:1,status:'activation-verified-not-started',runtimeStarted:false};}
