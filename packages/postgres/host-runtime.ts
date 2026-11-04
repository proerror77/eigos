import type {SemanticActionRanker} from '../semantic/catalog.js';
import pg,{type Client} from 'pg';
import type {Config} from '../core/config.js';
import {digest} from '../core/delegation.js';
import {runtimeAuthoritySchema,runtimeAuthorityDigest} from '../core/runtime-authority.js';
import {z} from 'zod';
import {readPostgresBinding,assertPostgresBindingAuthority,postgresConnectionOptions,postgresBindingIdentity,postgresHandoffSchema,postgresActivationSchema,postgresRuntimeSchemaReceiptSchema,POSTGRES_RUNTIME_SCHEMA_CONTRACT,readPinnedPostgresJson,readPostgresTaskRelayConfiguration,readPostgresRelaySourceInventory,readPostgresRelaySecrets,type PostgresBinding} from '../deployment/postgres-binding.js';
import {preparePostgresKernel} from './kernel-runtime.js';
import {stagedKernelComponents,type StagedKernelBuilder} from '../ontology/seed-definition.js';
import {PostgresDatabase} from './database.js';
import {PostgresMembershipDatabase} from './members-database.js';
import {PostgresMemberStore} from './member-store.js';
import {PostgresAuthorizationPublisher} from './authority-publisher.js';
import {auditImportedIdentities} from './identity-audit.js';
import {supabaseProxyOptions} from './supabase-proxy.js';
import type {AgentProgram} from '../core/agent-program.js';
import type {Job} from '../core/domain.js';
import {DomainError} from '../core/domain.js';
import type {Ref} from '../ontology/execution.js';
import {assertReviewedModel} from '../security/model-review.js';
import {postgresOntologyRelease} from './ontology-release.js';
import {PostgresTaskCommandService} from './task-command-service.js';
import {PostgresPermissionManagement} from './permission-management.js';
import {PostgresDefinitionService} from './definition-service.js';
import {PostgresDefinitionStore} from './definition-store.js';
import {postgresGoalProgram} from './goal-contexts.js';
import {assertPostgresMessagingStorageSchema} from './messaging-schema.js';
import {observePostgresClient} from './client-errors.js';
import {PostgresTaskRelay} from './task-relay.js';
import {PostgresAgentMessagingService,postgresMessagingNodeId} from './messaging-service.js';
import {PostgresRelayNodeStore,openPostgresRelayNode,relayNodeWrappingKey,listPostgresRelayNodeIdentities} from './relay-node-store.js';
import {RelayEnrollmentIssuer} from '../agent-transport/enrollment.js';
import {resolve} from 'node:path';
import {readDidiMemberConnection,didiSourceOwner} from '../core/didi-source.js';
import {didiBindingSchema} from '../capabilities/didi/contracts.js';
import {PostgresDidiAccount} from './didi-account.js';
import {PostgresReadProgramRegistry} from './didi-registry.js';
import {PostgresRelayReadAuthority} from './relay-read-authority.js';

const sha=z.string().regex(/^[a-f0-9]{64}$/),integer=z.number().int().nonnegative().safe();
const businessReceipt=z.strictObject({version:z.literal(2),status:z.literal('imported-not-activated'),sourceFileDigest:sha,schemaDigest:sha,authorityDigest:sha,policyDigest:sha,
  tables:z.array(z.strictObject({name:z.string().min(1).max(200),rows:integer,digest:sha})).max(10000)});
const membershipReceipt=z.strictObject({version:z.literal(1),status:z.literal('imported-not-activated'),sourceFileDigest:sha,
  tables:z.array(z.strictObject({table:z.string().min(1).max(200),rows:integer,digest:sha})).length(6)});
const same=(a:unknown,b:unknown)=>digest(a)===digest(b);
/** Structural task methods are not evidence that every configured provider
 * has a PostgreSQL execution port. Keep these enabled sources explicit. */
export function assertPostgresBuiltinSourceConfiguration(config:Config):void{
  const didi=!!(config.EIGOS_DIDI_KEY_FILE||config.EIGOS_DIDI_KEY_SHA256||config.EIGOS_DIDI_BINDING_ID||config.EIGOS_DIDI_MEMBER_CONNECTION_FILE||config.EIGOS_DIDI_RELAY_AGENT_ID||config.EIGOS_DIDI_AUDIT_DIR||config.EIGOS_DIDI_ORDER_TEST_ENABLED==='true'||config.EIGOS_DIDI_ORDERS_ENABLED==='mock');
  if(didi&&(!config.authority||!config.EIGOS_TASK_RELAY_FILE||!config.EIGOS_DIDI_RELAY_AGENT_ID||!config.EIGOS_DIDI_MEMBER_CONNECTION_FILE||!config.EIGOS_PERSONAL_SOURCE_OWNER||!config.EIGOS_DIDI_KEY_FILE||!config.EIGOS_DIDI_KEY_SHA256||!config.EIGOS_DIDI_BINDING_ID||config.EIGOS_DIDI_ENVIRONMENT!=='production'||config.EIGOS_DIDI_ORDERS_ENABLED!=='false'||config.EIGOS_DIDI_ORDER_TEST_ENABLED==='true'))throw new Error('PostgreSQL DiDi requires the complete current member-owned readonly Relay binding; order/direct-provider adapters are not installed');
  const unavailable=[
    [config.EIGOS_PAOTUI_SKILL_DIR||config.EIGOS_PAOTUI_MEMBER_CONNECTION_FILE||config.EIGOS_MEMBER_SOURCE_KEY_FILE||config.EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES?.length,'Meituan/Geo'],
    [config.EIGOS_ROLLINGGO_KEY_FILE,'RollingGo'],
    [config.EIGOS_ALIPAY_CONNECTION_FILE||config.EIGOS_WECHATPAY_CONNECTION_FILE||config.EIGOS_UNIONPAY_CONNECTION_FILE||config.EIGOS_TAOBAO_CONNECTION_FILE,'payment-commerce'],
    [config.EIGOS_SHOPIFY_CATALOG_MERCHANTS?.length||config.EIGOS_SHOPIFY_CHECKOUT_MERCHANTS?.length||config.EIGOS_SHOPIFY_PAYMENT_SANDBOX_URL,'Shopify'],
    [config.EIGOS_FREE_BOOKING_BRIDGE_URL||config.EIGOS_BOOKING_SANDBOX_URL,'booking/registration'],
    [config.EIGOS_SANDBOX_PROVIDER_URL||config.EIGOS_COMMERCE_SANDBOX_URL||config.EIGOS_STRIPE_TEST_ENABLED==='true','sandbox provider'],
    [config.EIGOS_NETWORK_ENABLED==='true'||config.EIGOS_CSV_PILOT==='true'||config.EIGOS_CSV_INPUT_DIR,'network/CSV'],
  ] as const;
  const missing=unavailable.filter(([enabled])=>!!enabled).map(([,name])=>name);
  if(missing.length)throw new Error(`PostgreSQL primary is not ready: configured execution adapters are not installed (${missing.join(', ')})`);
}

/** Actual current descriptor only. The provider Key path/fingerprint are
 * metadata and are never opened, copied or supplied to a model/provider here. */
export function readPostgresDidiHostConfiguration(config:Config){
  assertPostgresBuiltinSourceConfiguration(config);if(!config.EIGOS_DIDI_RELAY_AGENT_ID)return undefined;
  const path=config.EIGOS_DIDI_MEMBER_CONNECTION_FILE!,initial=readDidiMemberConnection(path),owner=config.EIGOS_PERSONAL_SOURCE_OWNER!;
  const binding=didiBindingSchema.parse({bindingId:config.EIGOS_DIDI_BINDING_ID,keyFile:config.EIGOS_DIDI_KEY_FILE,keySha256:config.EIGOS_DIDI_KEY_SHA256,environment:config.EIGOS_DIDI_ENVIRONMENT,...(config.EIGOS_DIDI_AUDIT_DIR?{auditDirectory:config.EIGOS_DIDI_AUDIT_DIR}:{})});
  if(didiSourceOwner(initial)!==owner||resolve(initial.binding.keyFile)!==resolve(binding.keyFile)||initial.binding.keySha256!==binding.keySha256)throw new Error('Current PostgreSQL DiDi routes must retain the original owner and credential fingerprint');
  return {binding,owner,peerId:config.EIGOS_DIDI_RELAY_AGENT_ID,descriptor:{readCurrent:()=>readDidiMemberConnection(path),expectedDigest:digest({policy:'member-didi-estimate@1',connection:initial})}};
}

/** Shared host assembly. Worker receives only its actual source-read authority
 * and registry; no publisher, durable node, wrapping key or model is created. */
export function createPostgresProgramTransport(config:Config,options:{database:PostgresDatabase;policyDigest:string;authority:{id:string;revision:number;digest:string};builder?:StagedKernelBuilder;role:'gateway'|'worker'}){
  if(!config.authority||config.authority.id!==options.authority.id||runtimeAuthorityDigest(config.authority)!==options.authority.digest||config.authority.revision!==options.authority.revision||config.PUBLIC_URL!==config.authority.canonicalOrigin)throw new Error('Program transport requires the same original host authority');
  const selected=readPostgresDidiHostConfiguration(config),account=selected?new PostgresDidiAccount(selected.binding,selected.owner,selected.descriptor):undefined;
  const opts={database:options.database,policyDigest:options.policyDigest,authorityId:options.authority.id,gatewayOrigin:config.PUBLIC_URL,builder:options.builder,didiAccount:account};
  const taskRelay=options.role==='gateway'&&config.EIGOS_TASK_RELAY_FILE?new PostgresTaskRelay(opts):undefined;
  const reads=selected?(taskRelay?.reads??new PostgresRelayReadAuthority(opts)):undefined;
  const registry=new PostgresReadProgramRegistry(options.policyDigest,{documentEnabled:config.EIGOS_EXECUTOR!=='disabled',...(selected?{didi:{kind:'relay' as const,binding:selected.binding,owner:selected.owner,account:account!,reads:reads!,peerId:selected.peerId,authority:{id:options.authority.id,gatewayOrigin:config.PUBLIC_URL}}}:{})});
  return {role:options.role,database:options.database,registry,taskRelay,reads,account,selected};
}
const runtimeContract=structuredClone(POSTGRES_RUNTIME_SCHEMA_CONTRACT),runtimeContractDigest=digest(runtimeContract);
const verificationSchema=z.strictObject({version:z.literal(1),status:z.literal('verified-at-snapshot'),transactionStartedAt:z.iso.datetime({offset:true}),sourceFileDigest:sha,schemaDigest:sha,authorityDigest:sha,policyDigest:sha,
  tables:businessReceipt.shape.tables,sequenceObservation:z.strictObject({checked:integer,atomicWithRows:z.literal(false)}),writerFenceVerified:z.literal(false),runtimeActivated:z.literal(false)});
const identitySchema=z.strictObject({version:z.literal(1),status:z.literal('audit-only'),checkedAt:integer,activeSubjects:integer,mismatchedSubjects:z.literal(0),runtimeActivated:z.literal(false)});
const sourceFenceSchema=z.strictObject({version:z.literal(1),kind:z.literal('eigos.source-authority-fence'),sourceAuthority:postgresHandoffSchema.shape.sourceAuthority,
  businessSnapshotDigest:sha,membershipSnapshotDigest:sha,fencedAt:z.iso.datetime({offset:true}),gatewayStopReceiptDigest:sha,workerDrainReceiptDigest:sha,claimsObservationDigest:sha,authorityFenceReceiptDigest:sha});

/** Validate already-produced evidence. This creates no verification, stop,
 * review or activation receipt, and preserves the verifier's original false
 * flags. It is separate from the ordinary candidate import preflight. */
export function assertReviewedPostgresActivation(binding:PostgresBinding,input:{handoff:unknown;sourceFence:unknown;businessVerification:unknown;identityAudit:unknown;runtimeSchema:unknown;activation:unknown;businessImport:unknown}):void{
  if(!binding.handoff||!binding.activation)throw new Error('PostgreSQL primary is not ready: actual reviewed handoff and activation receipts are required');
  const handoff=postgresHandoffSchema.parse(input.handoff),fence=sourceFenceSchema.parse(input.sourceFence),verification=verificationSchema.parse(input.businessVerification),identity=identitySchema.parse(input.identityAudit),schema=postgresRuntimeSchemaReceiptSchema.parse(input.runtimeSchema),activation=postgresActivationSchema.parse(input.activation),imported=businessReceipt.parse(input.businessImport);
  const bindingIdentity=postgresBindingIdentity(binding);
  if(handoff.activationId!==binding.activation.id||handoff.bindingIdentity!==bindingIdentity||!same(handoff.sourceAuthority,binding.sourceAuthority)||!same(handoff.targetAuthority,binding.authority)
    ||handoff.businessSchema!==binding.business.schema||handoff.membershipSchema!==binding.membership.schema||!same(fence.sourceAuthority,binding.sourceAuthority)||fence.businessSnapshotDigest!==binding.business.sourceFileDigest||fence.membershipSnapshotDigest!==binding.membership.sourceFileDigest)throw new Error('Reviewed PostgreSQL source/target handoff identities differ');
  if(verification.sourceFileDigest!==binding.business.sourceFileDigest||verification.schemaDigest!==binding.business.schemaDigest||verification.authorityDigest!==binding.sourceAuthority.digest||verification.policyDigest!==binding.business.importPolicyDigest||!same(verification.tables,imported.tables)
    ||Date.parse(fence.fencedAt)>Date.parse(verification.transactionStartedAt)||identity.checkedAt<Date.parse(fence.fencedAt))throw new Error('Reviewed PostgreSQL independent verification evidence differs');
  if(digest(schema)!==binding.activation.runtimeSchemaReceiptDigest||schema.businessSchema!==binding.business.schema||schema.baseSchemaDigest!==binding.business.schemaDigest||schema.contractDigest!==runtimeContractDigest||schema.baseVerificationDigest!==handoff.businessVerification.sha256
    ||Date.parse(schema.installedAt)<Date.parse(verification.transactionStartedAt))throw new Error('Reviewed post-import runtime schema receipt differs');
  const expected={version:1,kind:'eigos.postgres-activation',id:binding.activation.id,bindingIdentity,sourceAuthority:binding.sourceAuthority,targetAuthority:binding.authority,businessSchema:binding.business.schema,membershipSchema:binding.membership.schema,
    handoffDigest:binding.handoff.sha256,sourceFenceDigest:handoff.sourceFence.sha256,businessVerificationDigest:handoff.businessVerification.sha256,identityAuditDigest:handoff.identityAudit.sha256,runtimeSchemaReceiptDigest:binding.activation.runtimeSchemaReceiptDigest,reviewDigest:handoff.reviewDigest};
  if(!same(activation,expected)||digest(activation)!==binding.activation.receiptDigest)throw new Error('PostgreSQL activation record differs from the reviewed evidence');
}
export async function checkActivationSchema(client:Client,schema:string){
  const tables=[runtimeContract.activationTable,runtimeContract.schemaReceiptTable];
  for(const [index,table] of tables.entries()){
    const rows=await client.query(`SELECT a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,a.atthasdef,a.attgenerated,a.attidentity FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relname=$2 AND c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,[schema,table]);
    if(rows.rows.some(row=>row.atthasdef!==false||row.attgenerated!==''||row.attidentity!=='')||!same(rows.rows.map(row=>[row.attname,row.type,row.attnotnull]),index===0?runtimeContract.activationColumns:runtimeContract.schemaReceiptColumns))throw new Error('PostgreSQL activation schema is not installed as reviewed');
    const constraints=await client.query(`SELECT k.contype,k.convalidated,k.condeferrable,pg_get_constraintdef(k.oid) AS definition FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid=k.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2`,[schema,table]);
    const definitions=constraints.rows.map(row=>String(row.definition).replace(/\s+/g,''));
    if(constraints.rowCount!==(index===0?1:2)||constraints.rows.some(row=>row.convalidated!==true||row.condeferrable!==false)||!definitions.includes(`PRIMARYKEY(${index===0?'id':'slot'})`)
      ||index===1&&!definitions.some(value=>value==='CHECK((slot=1))'||value==='CHECK(slot=1)'))throw new Error('PostgreSQL activation identity constraints differ');
    const indexes=await client.query(`SELECT i.indisprimary,i.indisunique,i.indisvalid,i.indisready,i.indnatts,i.indnkeyatts,i.indpred IS NULL AS no_predicate,i.indexprs IS NULL AS no_expression,am.amname,
      pg_catalog.pg_get_indexdef(i.indexrelid,1,false) AS field FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_class idx ON idx.oid=i.indexrelid JOIN pg_catalog.pg_am am ON am.oid=idx.relam WHERE n.nspname=$1 AND c.relname=$2`,[schema,table]);
    const pk=indexes.rows[0];if(indexes.rowCount!==1||!pk.indisprimary||!pk.indisunique||!pk.indisvalid||!pk.indisready||Number(pk.indnatts)!==1||Number(pk.indnkeyatts)!==1||!pk.no_predicate||!pk.no_expression||pk.amname!=='btree'||pk.field!==(index===0?'id':'slot'))throw new Error('PostgreSQL activation index definition differs');
    const triggers=await client.query(`SELECT t.tgtype,t.tgenabled,t.tgattr::text AS attributes,t.tgqual IS NULL AS unconditional,t.tgnargs,p.prosrc,p.prosecdef,pn.nspname,p.proname,l.lanname FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace JOIN pg_catalog.pg_language l ON l.oid=p.prolang
      WHERE n.nspname=$1 AND c.relname=$2 AND NOT t.tgisinternal`,[schema,table]);
    const trigger=triggers.rows[0];if(triggers.rowCount!==1||Number(trigger.tgtype)!==27||trigger.tgenabled!=='O'||trigger.attributes!==''||trigger.unconditional!==true||Number(trigger.tgnargs)!==0||trigger.nspname!==schema||trigger.proname!==runtimeContract.triggerFunction||trigger.prosecdef!==false||trigger.lanname!=='plpgsql'||String(trigger.prosrc).trim()!==runtimeContract.triggerBody)throw new Error('PostgreSQL activation immutable-history guard differs');
  }
  const privilege=await client.query(`SELECT r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,pg_catalog.has_schema_privilege(current_user,$1,'CREATE') AS schema_create,
    pg_catalog.has_table_privilege(current_user,format('%I.%I',$1::text,$2::text),'INSERT,UPDATE,DELETE,TRUNCATE') AS activation_write,
    pg_catalog.has_table_privilege(current_user,format('%I.%I',$1::text,$3::text),'INSERT,UPDATE,DELETE,TRUNCATE') AS schema_receipt_write,
    EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname=$1 AND pg_catalog.pg_has_role(current_user,n.nspowner,'MEMBER')) AS schema_owner,
    EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname IN($2,$3) AND pg_catalog.pg_has_role(current_user,c.relowner,'MEMBER')) AS table_owner,
    EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname IN($4,$6) AND pg_catalog.pg_has_role(current_user,p.proowner,'MEMBER')) AS guard_owner,
    EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($5::text[]) AND pg_catalog.pg_has_role(current_user,c.relowner,'MEMBER')) AS node_ddl_owner
    FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`,[schema,...tables,runtimeContract.triggerFunction,[...runtimeContract.messagingNode.tables,...runtimeContract.messagingNode.sequences],'eigos_guard_relay_node_immutable']);
  const row=privilege.rows[0];if(privilege.rowCount!==1||Object.values(row).some(value=>value!==false))throw new Error('PostgreSQL primary runtime role can alter its activation authority');
}
/** No activation table is created here. Missing records, schema upgrade or
 * reviewed source-fence material leave formal startup explicitly not ready. */
export async function verifyPostgresPrimaryActivation(client:Client,binding:PostgresBinding):Promise<void>{
  if(!binding.handoff||!binding.activation)throw new Error('PostgreSQL primary is not ready: reviewed activation is absent');
  const handoff=postgresHandoffSchema.parse(readPinnedPostgresJson(binding.handoff,65536));
  const sourceFence=readPinnedPostgresJson(handoff.sourceFence,1048576),businessVerification=readPinnedPostgresJson(handoff.businessVerification),identityAudit=readPinnedPostgresJson(handoff.identityAudit,1048576);
  assertTls(client);if(client.getTransactionStatus()!=='I'||client.pipeline!==false)throw new Error('Primary activation verification requires an idle client');
  let opened=false;
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');opened=true;
    await client.query("SET LOCAL statement_timeout='10000ms'; SET LOCAL lock_timeout='5000ms'; SET LOCAL idle_in_transaction_session_timeout='10000ms'");
    await checkActivationSchema(client,binding.business.schema);const q=`"${binding.business.schema}"`;
    const a=await client.query(`SELECT CASE WHEN octet_length(body::text)<=1048576 THEN body END AS body FROM ${q}.eigos_runtime_activation WHERE id=$1 LIMIT 2`,[binding.activation.id]);
    const s=await client.query(`SELECT CASE WHEN octet_length(body::text)<=1048576 THEN body END AS body FROM ${q}.eigos_runtime_schema_receipt WHERE slot=1 LIMIT 2`);
    const imported=await client.query(`SELECT CASE WHEN octet_length(body::text)<=8388608 THEN body END AS body FROM ${q}.eigos_migration_receipt WHERE slot=1 LIMIT 2`);
    if(a.rowCount!==1||s.rowCount!==1||imported.rowCount!==1)throw new Error('PostgreSQL primary is not ready: activation or runtime schema receipt is missing');
    const base=businessReceipt.parse(imported.rows[0].body),expectedTables=[...base.tables.map(table=>table.name),'eigos_migration_receipt','eigos_business_mutex',runtimeContract.activationTable,runtimeContract.schemaReceiptTable,...runtimeContract.messagingNode.tables].sort();
    if(!runtimeContract.messagingNode.originalTables.every(table=>base.tables.some(value=>value.name===table)))throw new Error('Original imported messaging tables are missing from the reviewed base');
    const inventory=await client.query(`SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN('r','p','v','m','f') ORDER BY c.relname COLLATE "C" LIMIT 10001`,[binding.business.schema]);
    // New messaging/node relations require their actual registered DDL module
    // in this contract. Neither a receipt claim nor an ignored extra is enough.
    if(!same(inventory.rows.map(row=>row.relname).sort(),expectedTables))throw new Error('PostgreSQL runtime relation inventory differs from the installed reviewed contract');
    await assertPostgresMessagingStorageSchema(client,binding.business.schema);
    const functions=await client.query(`SELECT p.proname,pg_catalog.oidvectortypes(p.proargtypes) AS args FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 ORDER BY p.proname,p.oid LIMIT 10001`,[binding.business.schema]);
    const requiredFunctions=[...runtimeContract.baseFunctions,[runtimeContract.triggerFunction,''],['eigos_guard_relay_node_immutable','']],allowedFunctions=[...requiredFunctions,...runtimeContract.conditionalBaseFunctions];
    const names=functions.rows.map(row=>[row.proname,row.args]);
    if(requiredFunctions.some(expected=>!names.some(actual=>same(actual,expected)))||names.some(actual=>!allowedFunctions.some(expected=>same(actual,expected)))||new Set(names.map(value=>JSON.stringify(value))).size!==names.length)throw new Error('PostgreSQL runtime function inventory differs from the reviewed code');
    const sequences=await client.query(`SELECT c.relname,owned.table_name,owned.column_name,owned.identity,owned.primary_key FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN LATERAL(SELECT t.relname AS table_name,a.attname AS column_name,a.attidentity AS identity,EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid=t.oid AND k.contype='p' AND cardinality(k.conkey)=1 AND a.attnum=ANY(k.conkey)) AS primary_key
        FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_class t ON t.oid=d.refobjid JOIN pg_catalog.pg_namespace tn ON tn.oid=t.relnamespace JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid
        WHERE d.classid='pg_catalog.pg_class'::regclass AND d.objid=c.oid AND d.refclassid='pg_catalog.pg_class'::regclass AND d.deptype IN('a','i') AND tn.nspname=n.nspname) owned ON true
      WHERE n.nspname=$1 AND c.relkind='S' ORDER BY c.relname LIMIT 10001`,[binding.business.schema]);
    const nodeSequences=new Set<string>(runtimeContract.messagingNode.sequences),baseSequences=sequences.rows.filter(row=>!nodeSequences.has(row.relname)),verified=verificationSchema.parse(businessVerification);
    if(baseSequences.length!==verified.sequenceObservation.checked||new Set(sequences.rows.map(row=>row.relname)).size!==sequences.rows.length
      ||baseSequences.some(row=>!base.tables.some(table=>table.name===row.table_name)||!(row.identity==='a'&&row.column_name==='__eigos_rowid'||row.identity==='d'&&row.primary_key===true))
      ||base.tables.some(table=>baseSequences.filter(row=>row.table_name===table.name&&row.column_name==='__eigos_rowid'&&row.identity==='a').length!==1))throw new Error('PostgreSQL runtime sequence inventory differs from its verified base and node extension');
    assertReviewedPostgresActivation(binding,{handoff,sourceFence,businessVerification,identityAudit,runtimeSchema:s.rows[0].body,activation:a.rows[0].body,businessImport:imported.rows[0].body});
    await client.query('COMMIT');opened=false;
  }catch(error){if(opened)try{await client.query('ROLLBACK');}catch(rollback){throw new AggregateError([error,rollback],'PostgreSQL activation verification rollback failed',{cause:error});}throw error;}
}

/** Pure verification of the immutable import identities, never row equivalence,
 * writer fencing or activation. Current grants/data may advance after import. */
export function assertPostgresImportReceipts(binding:PostgresBinding,input:{business:unknown;membership:unknown;authority:{id:unknown;revision:unknown;configuration_digest:unknown;body?:unknown};policyDigest:unknown}):void{
  const business=businessReceipt.parse(input.business),membership=membershipReceipt.parse(input.membership),raw=input.authority.body;
  const authority=raw===undefined?undefined:runtimeAuthoritySchema.parse(typeof raw==='string'?JSON.parse(raw):raw);
  if(business.sourceFileDigest!==binding.business.sourceFileDigest||business.schemaDigest!==binding.business.schemaDigest||business.authorityDigest!==binding.sourceAuthority.digest||business.policyDigest!==binding.business.importPolicyDigest
    ||digest(business)!==binding.business.receiptDigest||membership.sourceFileDigest!==binding.membership.sourceFileDigest||digest(membership)!==binding.membership.receiptDigest)throw new Error('PostgreSQL import receipts differ from the reviewed binding');
  if(new Set(business.tables.map(table=>table.name)).size!==business.tables.length||new Set(membership.tables.map(table=>table.table)).size!==6
    ||[...membership.tables.map(table=>table.table)].sort().join(',')!=='agent_access_tokens,agent_registrations,member_connections,member_invitations,member_sessions,members')throw new Error('PostgreSQL import table identities are invalid');
  if(input.authority.id!==binding.authority.id||Number(input.authority.revision)!==binding.authority.revision||input.authority.configuration_digest!==binding.authority.digest
    ||authority&&(authority.id!==binding.authority.id||authority.revision!==binding.authority.revision||runtimeAuthorityDigest(authority)!==binding.authority.digest)||input.policyDigest!==binding.policyDigest)throw new Error('PostgreSQL target authority or policy differs from the reviewed binding');
}
function assertTls(client:Client){
  const connection:unknown=Reflect.get(client,'connection'),stream=connection&&typeof connection==='object'?Reflect.get(connection,'stream'):undefined;
  if(!stream||typeof stream!=='object'||Reflect.get(stream,'encrypted')!==true||Reflect.get(stream,'authorized')!==true)throw new Error('PostgreSQL requires an acknowledged verified TLS connection');
}
/** Only read-only SQL over a request-owned idle client. Never initializes an
 * authority, imports data, upgrades policy or writes an activation record. */
export async function preflightPostgresBinding(client:Client,binding:PostgresBinding){
  assertTls(client);
  if(client.getTransactionStatus()!=='I'||client.pipeline!==false)throw new Error('PostgreSQL preflight requires an idle client');
  let opened=false;
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');opened=true;
    await client.query("SET LOCAL statement_timeout='10000ms'; SET LOCAL lock_timeout='5000ms'; SET LOCAL idle_in_transaction_session_timeout='10000ms'");
    const identity=(await client.query("SELECT current_database() AS database,current_user AS role,session_user AS session_role,current_setting('server_encoding') AS encoding")).rows[0];
    if(!identity||identity.database!==binding.connection.database||identity.role!==binding.connection.role||identity.session_role!==binding.connection.role||identity.encoding!=='UTF8')throw new Error('PostgreSQL connection identity differs from the reviewed binding');
    const business=`"${binding.business.schema}"`,membership=`"${binding.membership.schema}"`;
    const b=await client.query(`SELECT CASE WHEN octet_length(body::text)<=8388608 THEN body END AS body FROM ${business}.eigos_migration_receipt WHERE slot=1 LIMIT 2`);
    const m=await client.query(`SELECT CASE WHEN octet_length(body::text)<=1048576 THEN body END AS body FROM ${membership}.eigos_membership_migration_receipt WHERE slot=1 LIMIT 2`);
    const a=await client.query(`SELECT id,revision,configuration_digest FROM ${business}.eigos_current_runtime_authority() LIMIT 2`);
    const p=await client.query(`SELECT d.digest FROM ${business}.security_policy_definitions d JOIN ${business}.security_settings s ON s.slot=d.slot WHERE d.slot=1 AND s.version=2 AND s.mode='foundation' LIMIT 2`);
    if(b.rowCount!==1||m.rowCount!==1||a.rowCount!==1||p.rowCount!==1)throw new Error('PostgreSQL reviewed import metadata is unavailable');
    assertPostgresImportReceipts(binding,{business:b.rows[0].body,membership:m.rows[0].body,authority:a.rows[0],policyDigest:p.rows[0].digest});
    await client.query('COMMIT');opened=false;
    const identities=await auditImportedIdentities(client,{businessSchema:binding.business.schema,membershipSchema:binding.membership.schema,businessFileDigest:binding.business.sourceFileDigest,membershipFileDigest:binding.membership.sourceFileDigest,now:Date.now()});
    if(identities.mismatchedSubjects!==0)throw new Error('PostgreSQL active identity mappings differ from membership');
    return {status:'preflight-only' as const,identityAudit:identities,sourceCurrentnessVerified:false as const,writerFenceVerified:false as const,runtimeActivated:false as const};
  }catch(error){if(opened)try{await client.query('ROLLBACK');}catch(rollback){throw new AggregateError([error,rollback],'PostgreSQL preflight rollback failed',{cause:error});}throw error;}
}

/** Candidate resources only. The Gateway owns the sole publisher; a Worker
 * receives independent pools and never constructs another publisher. No
 * polling, publisher start or formal activation occurs here. */
export async function createPostgresHostResources(config:Config,role:'gateway'|'worker',environment:NodeJS.ProcessEnv=process.env){
  if(config.EIGOS_STORAGE_BACKEND!=='postgres'||!config.EIGOS_POSTGRES_BINDING_FILE)throw new Error('Explicit PostgreSQL backend and private binding are required');
  const {binding,fileDigest}=readPostgresBinding(config.EIGOS_POSTGRES_BINDING_FILE);assertPostgresBindingAuthority(config,binding);
  const connection={...supabaseProxyOptions(binding.connection.host,binding.connection.port,binding.connection.proxyUrl),...postgresConnectionOptions(binding,environment)};
  const kernel=await preparePostgresKernel();
  const businessPool=new pg.Pool({...connection,max:3}),leasePool=new pg.Pool({...connection,max:2}),eligibilityPool=new pg.Pool({...connection,max:2}),controlPool=new pg.Pool({...connection,max:2}),membershipPool=new pg.Pool({...connection,max:2});
  const database=new PostgresDatabase(businessPool,binding.business.schema,binding.authority,{leasePool,eligibilityPool,kernel});
  const members=new PostgresMemberStore(new PostgresMembershipDatabase(membershipPool,binding.membership.schema,binding.membership.sourceFileDigest));
  const publisher=role==='gateway'?new PostgresAuthorizationPublisher({database,controlPool,schema:binding.business.schema,runtime:binding.authority,policyDigest:binding.policyDigest,members}):undefined;
  let closing:Promise<void>|undefined,unavailable=false,failure:unknown;
  const unavailableHandlers=new Set<()=>void>();
  const fail=(cause:unknown)=>{if(unavailable)return;unavailable=true;failure=cause;for(const handler of unavailableHandlers)try{handler();}catch{/* notification cannot restore readiness */}};
  publisher?.onUnavailable(value=>fail(value.cause));
  // pg evicts the failed idle client before emitting pool.error. Retain the
  // first cause and reject new work; never retry a possibly committed action.
  const pools=[businessPool,leasePool,eligibilityPool,controlPool,membershipPool];
  for(const pool of pools)pool.on('error',fail);
  const assertAvailable=()=>{if(closing||unavailable)throw new Error('PostgreSQL host is unavailable',{cause:failure});};
  const close=()=>closing??=(async()=>{unavailable=true;const errors:unknown[]=[];try{await publisher?.close();}catch(error){errors.push(error);}
    const results=await Promise.allSettled([database.close(),members.close(),controlPool.end()]);for(const result of results)if(result.status==='rejected')errors.push(result.reason);
    // Keep the error listener through a failed close as well: a surviving
    // failed socket must not become an unhandled EventEmitter error.
    if(errors.length)throw new AggregateError(errors,'PostgreSQL host resource shutdown failed');})();
  try{
    const readControl=async<T>(action:(client:Client)=>Promise<T>):Promise<T>=>{
      assertAvailable();const client=await controlPool.connect(),observed=observePostgresClient(client);
      try{assertAvailable();observed.check();assertTls(client);const result=await action(client);observed.check();assertAvailable();return result;}
      catch(error){if(observed.failure)fail(observed.failure);throw observed.annotate(error);}
      finally{try{client.release(observed.failure??(client.getTransactionStatus()==='I'?undefined:new Error('PostgreSQL control connection is not idle')));}finally{observed.close();}}
    };
    const preflight=await readControl(client=>preflightPostgresBinding(client,binding));
    const authorityCurrent=async()=>{
      if(closing||unavailable)return false;
      return readControl(async client=>{const result=await client.query(`SELECT id,revision,configuration_digest FROM "${binding.business.schema}".eigos_current_runtime_authority() LIMIT 2`),row=result.rows[0];
        return result.rowCount===1&&row.id===binding.authority.id&&Number(row.revision)===binding.authority.revision&&row.configuration_digest===binding.authority.digest;});
    };
    const requireWorkerReadiness=async()=>{
      if(!await authorityCurrent())throw new Error('PostgreSQL Worker is not ready: original authority is unavailable');
      const ready=await readControl(async client=>(await client.query(`SELECT 1 FROM "${binding.business.schema}".security_manager m JOIN "${binding.business.schema}".security_policy_definitions p ON p.slot=m.slot
        WHERE m.slot=1 AND m.expires_at>floor(extract(epoch FROM clock_timestamp())*1000)::bigint AND p.digest=$1 LIMIT 1`,[binding.policyDigest])).rowCount===1);
      if(!ready)throw new Error('PostgreSQL Worker is not ready: the existing Gateway publisher is unavailable');
    };
    return {binding,bindingFileDigest:fileDigest,kernel,database,members,publisher,preflight,close,authorityCurrent,requireWorkerReadiness,assertAvailable,get failure(){return failure;},
      requirePrimaryActivation:()=>readControl(client=>verifyPostgresPrimaryActivation(client,binding)),
      onUnavailable:(handler:()=>void)=>{unavailableHandlers.add(handler);if(unavailable)handler();},
      startPublisher:async()=>{if(!publisher)throw new Error('A Worker cannot start a second authorization publisher');assertAvailable();await publisher.start();assertAvailable();},
    };
  }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'PostgreSQL host preflight failed');}throw error;}
}

/** Formal mains must use this extra gate. A binding or candidate preflight
 * alone never substitutes for reviewed activation installed by another tool. */
export async function createPostgresPrimaryHostResources(config:Config,role:'gateway'|'worker',environment:NodeJS.ProcessEnv=process.env){
  if(!config.EIGOS_POSTGRES_BINDING_FILE)throw new Error('PostgreSQL primary is not ready: private binding is missing');
  const selected=readPostgresBinding(config.EIGOS_POSTGRES_BINDING_FILE);assertPostgresBindingAuthority(config,selected.binding);
  if(!selected.binding.handoff||!selected.binding.activation)throw new Error('PostgreSQL primary is not ready: actual reviewed handoff and activation proofs are absent');
  postgresHandoffSchema.parse(readPinnedPostgresJson(selected.binding.handoff,65536));
  const resources=await createPostgresHostResources(config,role,environment);
  try{
    if(resources.bindingFileDigest!==selected.fileDigest)throw new Error('PostgreSQL primary binding changed during startup');
    await resources.requirePrimaryActivation();return resources;
  }catch(error){try{await resources.close();}catch(cleanup){throw new AggregateError([error,cleanup],'PostgreSQL primary startup is not ready');}throw error;}
}

/** Real Gateway metadata/task services; no executor or model is constructed.
 * Other source runtimes must be installed explicitly instead of substituting
 * a different program, model, owner or task when a binding is unavailable. */
export function createPostgresGatewayServices(config:Config,resources:Awaited<ReturnType<typeof createPostgresHostResources>>,programTransport=createPostgresProgramTransport(config,{database:resources.database,policyDigest:resources.binding.policyDigest,authority:resources.binding.authority,builder:resources.kernel,role:'gateway'}),semantic?:SemanticActionRanker){
  assertPostgresBuiltinSourceConfiguration(config);
  if(config.EIGOS_SEMANTIC_MODEL_DIR&&!semantic)throw new Error('The configured semantic runtime must be loaded before creating Gateway services');
  const publisher=resources.publisher;if(!publisher)throw new Error('Gateway services require the sole Gateway authorization publisher');
  if(programTransport.role!=='gateway'||programTransport.database!==resources.database||!(programTransport.registry instanceof PostgresReadProgramRegistry)||programTransport.registry.policyDigest!==resources.binding.policyDigest)throw new Error('Gateway requires its own actual shared program transport');
  const catalog=programTransport.registry.catalog;
  const checkedProgram=async(client:Client,owner:string,releaseRef:Parameters<typeof postgresOntologyRelease>[1],ref:Ref,job?:Job):Promise<AgentProgram>=>{
    const release=await postgresOntologyRelease(client,releaseRef,resources.kernel);assertReviewedModel(stagedKernelComponents(resources.kernel).model,release.model);
    const program=ref.id==='eigos.goal'&&job?postgresGoalProgram(job):catalog.agentProgram(ref,owner);
    if(!program||!same(program.ref,ref)||!program.permitted(owner))throw new DomainError('CONFLICT','The original registered PostgreSQL program is unavailable');
    const state=job?.delegation?.agent;
    if(state&&same(state.programRef,ref)&&state.programDigest!==program.configurationDigest)throw new DomainError('CONFLICT','The original program configuration changed');
    // Definition implementations are the real registered program metadata.
    // No fake graph or storage object is lent to the synchronous catalogue.
    const registered=programTransport.registry.find(program.ref,program.configurationDigest);
    for(const action of program.actionIds){const definition=release.model.action(action);if(release.model.actionImplementation(action)?.kind!=='trusted'||definition.operation?.effect!=='local'&&!(registered?.kind==='didi'&&!definition.operation&&definition.read?.effect==='read'))throw new DomainError('CONFLICT','This source program requires its actual installed PostgreSQL adapter');}
    return program;
  };
  const tasks=new PostgresTaskCommandService(resources.database,resources.binding.policyDigest,resources.kernel,{
    allowSandboxActions:config.EIGOS_ACTION_SANDBOX==='true',
    prepareRequest:async(client,owner,job,ref,request)=>{if(!job.delegation?.ontologyRelease)throw new DomainError('CONFLICT','The original task release is missing');const program=await checkedProgram(client,owner,job.delegation.ontologyRelease,ref,job);return program.prepareRequest?.(request)??request;},
    assertProgram:async(client,owner,job,ref)=>{if(!job.delegation?.ontologyRelease)throw new DomainError('CONFLICT','The original task release is missing');await checkedProgram(client,owner,job.delegation.ontologyRelease,ref,job);},
    resolveObservationProgram:(client,owner,release,ref)=>checkedProgram(client,owner,release,ref),
  });
  const permissions=new PostgresPermissionManagement({database:resources.database,members:resources.members,publisher,catalog,policyDigest:resources.binding.policyDigest,builder:resources.kernel});
  const definitions=new PostgresDefinitionService({semantic,database:resources.database,tasks,catalog,publisher,policyDigest:resources.binding.policyDigest,builder:resources.kernel});
  return {tasks,members:resources.members,publisher,permissions,definitions,catalog,programTransport,
    assertSourceCurrent:()=>assertPostgresProgramSourceCurrent(programTransport,resources),
    ontologyRelease:()=>resources.database.run(async client=>(await new PostgresDefinitionStore(client,{builder:resources.kernel}).active('eigos.business')).ref),
    available:async()=>{try{resources.assertAvailable();return await resources.database.run(client=>publisher.withManagement(client,async()=>{resources.assertAvailable();return true;}));}catch{return false;}},
  };
}

/** Startup reads only: actual active member and unchanged original source
 * admission. It never self-admits, grants a source or replaces a deadline.
 * Claim/dispatch paths retain their own fresh account.assert checks. */
export async function assertPostgresProgramSourceCurrent(transport:ReturnType<typeof createPostgresProgramTransport>,resources:Awaited<ReturnType<typeof createPostgresHostResources>>){
  if(transport.database!==resources.database||transport.registry.policyDigest!==resources.binding.policyDigest)throw new Error('Source readiness requires the same actual primary database');
  const account=transport.account,selected=transport.selected;if(!account||!selected)return;
  account.assertBinding(selected.binding,selected.owner);
  const member=await resources.members.get(account.record.memberId);
  if(member.status!=='active'||!member.acceptedAt||member.issuer!==account.record.owner.issuer||member.tenant!==account.record.owner.tenant||member.subject!==account.record.owner.subject)throw new Error('The original DiDi member source is unavailable');
  await resources.database.run(async client=>{
    const row=await client.query(`SELECT configuration_digest,connection_id,owner,member_id,state FROM "${resources.binding.business.schema}".member_didi_source_admissions WHERE configuration_digest=$1 LIMIT 2`,[account.configurationDigest]),value=row.rows[0];
    if(row.rowCount!==1||value?.configuration_digest!==account.configurationDigest||value.connection_id!==account.record.connectionId||value.owner!==account.owner||value.member_id!==account.record.memberId||value.state!=='active')throw new Error('The original DiDi account has no current source admission');
  });
  account.assertBinding(selected.binding,selected.owner);resources.assertAvailable();
}

/** Configuration admission only, without opening credentials, a DB or network.
 * A disabled feature cannot silently discard a reviewed Relay deployment. */
export function assertPostgresRelayHostConfiguration(config:Pick<Config,'EIGOS_TASK_RELAY_FILE'|'EIGOS_MESSAGING_ENABLED'>,binding:PostgresBinding):void{
  if(!!config.EIGOS_TASK_RELAY_FILE!==!!binding.relay||config.EIGOS_MESSAGING_ENABLED==='true'&&!config.EIGOS_TASK_RELAY_FILE)throw new Error('PostgreSQL Relay startup requires its original enabled configuration and reviewed node migration binding');
  if(binding.relay&&config.EIGOS_TASK_RELAY_FILE!==binding.relay.configuration.path)throw new Error('Task Relay configuration differs from the reviewed PostgreSQL binding');
}

/** Real package-level Relay services, sharing the original primary database.
 * Assembly does not provision nodes, publish authority or start a poller. The
 * application owns HTTP/network startup after verifyMigrations has succeeded. */
export async function createPostgresRelayServices(config:Config,resources:Awaited<ReturnType<typeof createPostgresHostResources>>,environment:NodeJS.ProcessEnv=process.env,programTransport=createPostgresProgramTransport(config,{database:resources.database,policyDigest:resources.binding.policyDigest,authority:resources.binding.authority,builder:resources.kernel,role:'gateway'})){
  assertPostgresRelayHostConfiguration(config,resources.binding);
  const binding=resources.binding.relay;if(!binding||!config.EIGOS_TASK_RELAY_FILE)return undefined;
  const publisher=resources.publisher;if(!publisher)throw new Error('A Worker cannot own the primary Relay or a second publisher');
  const relayConfig=readPostgresTaskRelayConfiguration(resources.binding,config.EIGOS_TASK_RELAY_FILE);
  readPostgresRelaySourceInventory(resources.binding);
  const secrets=readPostgresRelaySecrets(resources.binding,environment);let wrappingKey:CryptoKey;
  try{wrappingKey=await relayNodeWrappingKey(secrets.wrappingKeyBytes);}finally{secrets.wrappingKeyBytes.fill(0);}
  resources.assertAvailable();
  const port=programTransport.taskRelay;
  if(programTransport.role!=='gateway'||programTransport.database!==resources.database||!port||programTransport.registry.policyDigest!==resources.binding.policyDigest||port.reads.didiAccount!==programTransport.account)throw new Error('Relay requires the actual same-account Gateway program transport');
  const enrollment=new RelayEnrollmentIssuer(secrets.enrollmentKey,config.PUBLIC_URL,relayConfig.relayUrl,port.enrollment);
  const expected=new Map(binding.endpointImports.map(node=>[postgresMessagingNodeId(node.endpointId),{agentId:node.agentId,importDigest:node.importDigest}]));
  // Even when communication routes are disabled, verify preserved historical
  // endpoint identities; their source history cannot be silently omitted.
  const messaging=new PostgresAgentMessagingService({database:resources.database,publisher,members:resources.members,relayUrl:relayConfig.relayUrl,wrappingKey,enrollment,
    permissionsUrl:`${config.PUBLIC_URL}/members/communications`,nodeImportDigests:new Map([...expected].map(([id,node])=>[id,node.importDigest]))});
  let closing:Promise<void>|undefined,verified=false;
  const assertCurrent=async()=>{if(closing)throw new Error('PostgreSQL Relay host is closing');resources.assertAvailable();await resources.database.run(client=>publisher.withManagement(client,async()=>{resources.assertAvailable();}));resources.assertAvailable();};
  const gatewayNode={database:resources.database,publisher,nodeId:binding.gatewayNode.nodeId,baseUrl:relayConfig.relayUrl,wrappingKey,expectedAgentId:binding.gatewayNode.agentId,expectedImportDigest:binding.gatewayNode.importDigest};
  return {port,configuration:relayConfig,enrollmentKey:secrets.enrollmentKey,
    messaging:config.EIGOS_MESSAGING_ENABLED==='true'?messaging:undefined,
    verifyMigrations:async()=>{
      await assertCurrent();await PostgresRelayNodeStore.verifyExisting(gatewayNode);
      const inventory=await listPostgresRelayNodeIdentities({database:resources.database,publisher});
      if(inventory.some(node=>node.nodeId!==gatewayNode.nodeId&&!node.nodeId.startsWith('communication:')))throw new Error('Unreviewed Relay node is outside the complete primary inventory');
      await messaging.assertNodeMigrations(expected);await assertCurrent();verified=true;
    },
    openClient:async()=>{if(!verified)throw new Error('Relay transport requires verified original node migrations');return openPostgresRelayNode({...gatewayNode,displayName:relayConfig.displayName,createIfMissing:false,assertCurrent});},
    close:()=>closing??=messaging.close(),
  };
}
