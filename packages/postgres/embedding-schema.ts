import type {Client} from 'pg';
import {digest} from '../core/delegation.js';
import {z} from 'zod';
import {stagedKernelComponents,type StagedKernelBuilder} from '../ontology/seed-definition.js';

export const embeddingTableNames=Object.freeze(['ontology_embedding_batches','ontology_object_embeddings','eigos_runtime_schema_extensions'] as const);
export const embeddingRoutineNames=Object.freeze(['eigos_vector_from_values','eigos_vector_cosine_values','eigos_immutable_embedding'] as const);
const sha=z.string().regex(/^[a-f0-9]{64}$/);
export const postgresVectorFeatureSchema=z.strictObject({version:z.literal(1),kind:z.literal('eigos.task-vector-feature'),
  businessSchema:z.string().regex(/^eigos_business_[a-z0-9_]{1,40}$/),authority:z.strictObject({id:z.uuid(),revision:z.number().int().positive().safe(),digest:sha}),
  baseActivation:z.strictObject({id:z.uuid(),digest:sha}),runtimeRole:z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/),
  extensionVersion:z.literal('0.8.2'),contractDigest:sha,receiptDigest:sha});
export type PostgresVectorFeature=z.infer<typeof postgresVectorFeatureSchema>;
export const vectorSchemaReceiptSchema=postgresVectorFeatureSchema.omit({kind:true,receiptDigest:true}).extend({kind:z.literal('eigos.task-vector-schema'),installedAt:z.iso.datetime({offset:true}),
  adminRole:z.string().min(1).max(63),reviewDigest:sha});

export const EMBEDDING_SCHEMA_DDL=Object.freeze([
  `CREATE FUNCTION __SCHEMA__.eigos_vector_from_values(real[]) RETURNS extensions.vector LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ SELECT $1::extensions.vector $$`,
  `CREATE FUNCTION __SCHEMA__.eigos_vector_cosine_values(extensions.vector,real[]) RETURNS double precision LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ SELECT extensions.cosine_distance($1,$2::extensions.vector) $$`,
  `CREATE FUNCTION __SCHEMA__.eigos_immutable_embedding() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN RAISE EXCEPTION 'Derived embedding history is immutable'; END $$`,
  `CREATE TABLE __SCHEMA__.ontology_embedding_batches(owner text NOT NULL,installation_id text NOT NULL,task_id text NOT NULL,request_revision bigint NOT NULL,grant_id text NOT NULL,grant_revision bigint NOT NULL,batch_id text NOT NULL,batch_digest text NOT NULL,body jsonb NOT NULL,PRIMARY KEY(owner,installation_id,task_id,batch_id))`,
  `CREATE TABLE __SCHEMA__.ontology_object_embeddings(owner text NOT NULL,installation_id text NOT NULL,task_id text NOT NULL,batch_id text NOT NULL,object_type text NOT NULL,object_id text NOT NULL,object_revision bigint NOT NULL,ontology_id text NOT NULL,release_id text NOT NULL,release_digest text NOT NULL,space_digest text NOT NULL,fields_digest text NOT NULL,input_digest text NOT NULL,vector_digest text NOT NULL,dimensions integer NOT NULL,embedding extensions.vector NOT NULL,PRIMARY KEY(owner,installation_id,task_id,batch_id,object_type,object_id),FOREIGN KEY(owner,installation_id,task_id,batch_id) REFERENCES __SCHEMA__.ontology_embedding_batches(owner,installation_id,task_id,batch_id),CHECK(dimensions BETWEEN 1 AND 16000 AND extensions.vector_dims(embedding)=dimensions))`,
  `CREATE TABLE __SCHEMA__.eigos_runtime_schema_extensions(feature text PRIMARY KEY CHECK(feature='task-vectors-v1'),body jsonb NOT NULL)`,
  ...embeddingTableNames.map(table=>`CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON __SCHEMA__.${table} FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.eigos_immutable_embedding()`),
] as const);
export const POSTGRES_EMBEDDING_SCHEMA_CONTRACT=Object.freeze({version:1,kind:'eigos.task-vector-schema',extensionVersion:'0.8.2',tables:embeddingTableNames,
  routines:embeddingRoutineNames,ddlDigest:digest(EMBEDDING_SCHEMA_DDL)});
export const embeddingSchemaContractDigest=digest(POSTGRES_EMBEDDING_SCHEMA_CONTRACT);
export const quoteEmbeddingIdentifier=(value:string)=>`"${value.replaceAll('"','""')}"`;
export async function assertPostgresSemanticRelease(client:Client,schema:string,builder:StagedKernelBuilder,expectedGeneration?:number){
  if(client.getTransactionStatus()!=='T'||client.pipeline!==false||!/^eigos_business_[a-z0-9_]{1,40}$/.test(schema))throw new Error('Semantic release inspection requires the owned transaction snapshot');
  const kernel=stagedKernelComponents(builder);if(kernel.model.ref.version!=='29')throw new Error('Task vectors require the actual prepared semantic kernel');const q=quoteEmbeddingIdentifier(schema);
  const result=await client.query(`SELECT n.active_release_id,n.generation,r.digest,r.model_digest,CASE WHEN octet_length(r.body)<=8388608 THEN r.body END AS body
    FROM ${q}.ontology_namespaces n JOIN ${q}.ontology_definition_releases r ON r.id=n.active_release_id WHERE n.id=$1`,[kernel.model.ref.id]);
  const row=result.rows[0],generation=Number(row?.generation);
  if(result.rowCount!==1||row?.digest!==kernel.documentDigest||row.model_digest!==kernel.model.ref.digest||typeof row.body!=='string'||digest(JSON.parse(row.body))!==kernel.documentDigest
    ||!Number.isSafeInteger(generation)||generation<1||expectedGeneration!==undefined&&generation!==expectedGeneration)throw new Error('Task vectors require explicit activation of the exact semantic release');
  return {ontologyId:kernel.model.ref.id,releaseId:String(row.active_release_id),digest:row.digest as string,generation,status:'verified-at-snapshot' as const};
}

/** Pure extension routines only; names without actual membership are not proof.
 * This reuses the installed package's real IO/cast/distance dependencies, never
 * grants namespace access and never executes user-selected SQL. */
export async function assertEmbeddingVectorDependencies(client:Client){
  const extension=await client.query(`SELECT e.oid::text,n.nspname,e.extversion FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector'`);
  const e=extension.rows[0];if(extension.rowCount!==1||e?.nspname!=='extensions'||e.extversion!=='0.8.2')throw new Error('Exact reviewed vector 0.8.2 extension is required');
  const signatures=[['extensions.vector_in(cstring,oid,integer)','vector_in'],['extensions.vector_out(extensions.vector)','vector_out'],
    ['extensions.array_to_vector(real[],integer,boolean)','array_to_vector'],['extensions.vector_dims(extensions.vector)','vector_dims'],
    ['extensions.cosine_distance(extensions.vector,extensions.vector)','cosine_distance']];
  const routines=await client.query(`WITH candidates AS(SELECT p.*,n.nspname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='extensions')
    SELECT r.signature,p.oid::text,p.prosrc,p.probin,p.provolatile,p.prosecdef,p.proisstrict,p.proparallel,p.proconfig,p.proleakproof,p.proretset,p.prokind,p.prosupport::oid::text AS support,l.lanname,pg_catalog.format_type(p.prorettype,NULL) AS result,
    EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_proc'::regclass AND d.objid=p.oid AND d.refclassid='pg_catalog.pg_extension'::regclass AND d.refobjid=$2::oid AND d.deptype='e') AS owned
    FROM pg_catalog.unnest($1::text[]) r(signature) LEFT JOIN candidates p ON p.nspname||'.'||p.proname||'('||pg_catalog.replace(pg_catalog.oidvectortypes(p.proargtypes),', ', ',')||')'=r.signature
    LEFT JOIN pg_catalog.pg_language l ON l.oid=p.prolang`,[signatures.map(([signature])=>signature),e.oid]);
  if(routines.rowCount!==signatures.length)throw new Error('Vector dependency inventory is incomplete');
  for(const [signature,source] of signatures){const rows=routines.rows.filter(row=>row.signature===signature),r=rows[0],result=source==='vector_out'?'cstring':source==='vector_dims'?'integer':source==='cosine_distance'?'double precision':'extensions.vector';
    if(rows.length!==1||!r?.oid||!r.owned||r.prosrc!==source||r.result!==result||r.probin!=='$libdir/vector'||r.lanname!=='c'||r.provolatile!=='i'||r.prosecdef!==false||r.proisstrict!==true||r.proparallel!=='s'||r.proconfig!==null||r.proleakproof||r.proretset||r.prokind!=='f'||r.support!=='0')throw new Error('Vector dependency implementation differs from its reviewed contract');}
  const cast=await client.query(`SELECT c.castfunc::oid::text,c.castmethod,c.castcontext,
    EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_cast'::regclass AND d.objid=c.oid AND d.refclassid='pg_catalog.pg_extension'::regclass AND d.refobjid=$1::oid AND d.deptype='e') AS owned
    FROM pg_catalog.pg_cast c JOIN pg_catalog.pg_type t ON t.oid=c.casttarget JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
    WHERE c.castsource='real[]'::regtype AND n.nspname='extensions' AND t.typname='vector'`,[e.oid]);
  if(cast.rowCount!==1||!cast.rows[0]?.owned||cast.rows[0].castmethod!=='f'||cast.rows[0].castcontext!=='a'||cast.rows[0].castfunc!==routines.rows.find(row=>row.prosrc==='array_to_vector')?.oid)throw new Error('Vector cast implementation differs');
  const type=await client.query(`SELECT t.typinput::oid::text,t.typoutput::oid::text,t.typtype,t.typisdefined,
    EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_type'::regclass AND d.objid=t.oid AND d.refclassid='pg_catalog.pg_extension'::regclass AND d.refobjid=$1::oid AND d.deptype='e') AS owned
    FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='extensions' AND t.typname='vector'`,[e.oid]);
  const t=type.rows[0];if(type.rowCount!==1||!t?.owned||t.typtype!=='b'||!t.typisdefined
    ||!routines.rows.some(r=>r.signature===signatures[0]![0]&&r.oid===t.typinput)||!routines.rows.some(r=>r.signature===signatures[1]![0]&&r.oid===t.typoutput))throw new Error('Vector type IO differs from its actual extension');
}

/** Read-only catalog proof of this exact extension. Used by the installer,
 * independent verifier and runtime; a receipt never substitutes for objects. */
export async function assertPostgresEmbeddingSchema(client:Client,input:PostgresVectorFeature,options:{adminRole?:string}={}){
  const feature=postgresVectorFeatureSchema.parse(input),schema=feature.businessSchema,q=quoteEmbeddingIdentifier(schema);
  if(feature.contractDigest!==embeddingSchemaContractDigest)throw new Error('Embedding schema contract differs');
  const reachable=await client.query(`SELECT pg_catalog.has_schema_privilege($1,'extensions','USAGE,CREATE') AS reachable`,[feature.runtimeRole]);
  if(reachable.rows[0]?.reachable!==false)throw new Error('Runtime vector namespace isolation differs');
  await assertEmbeddingVectorDependencies(client);
  const receipt=await client.query(`SELECT body FROM ${q}.eigos_runtime_schema_extensions WHERE feature='task-vectors-v1' LIMIT 2`);
  if(receipt.rowCount!==1)throw new Error('Embedding schema receipt is missing');
  const saved=vectorSchemaReceiptSchema.parse(receipt.rows[0]?.body),{receiptDigest:_digest,kind:_kind,...expected}=feature;
  if(digest(receipt.rows[0].body)!==feature.receiptDigest||Object.entries(expected).some(([key,value])=>digest(value)!==digest(Reflect.get(saved,key))))throw new Error('Embedding schema receipt differs from its pinned feature');
  const namespace=await client.query(`SELECT pg_catalog.pg_get_userbyid(nspowner) AS owner FROM pg_catalog.pg_namespace WHERE nspname=$1`,[schema]);
  if(namespace.rowCount!==1||namespace.rows[0]?.owner!==saved.adminRole||saved.adminRole===feature.runtimeRole||options.adminRole&&options.adminRole!==saved.adminRole)throw new Error('Embedding schema owner differs from its installation');
  const tables=await client.query(`SELECT c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity,c.relpersistence,c.relispartition,c.relhassubclass,
    EXISTS(SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS inherits,pg_catalog.pg_get_userbyid(c.relowner) AS owner
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND(c.relname LIKE 'ontology_embedding_%' OR c.relname='ontology_object_embeddings' OR c.relname='eigos_runtime_schema_extensions') AND c.relkind IN('r','p','v','m','f','S') ORDER BY c.relname`,[schema]);
  if(digest(tables.rows.map(row=>row.relname))!==digest([...embeddingTableNames].sort())||tables.rows.some(row=>row.relkind!=='r'||row.relrowsecurity||row.relforcerowsecurity||row.relpersistence!=='p'||row.relispartition||row.relhassubclass||row.inherits||row.owner!==saved.adminRole))throw new Error('Embedding relation inventory differs');
  const expectedColumns:Record<string,[string,string,boolean][]>={
    ontology_embedding_batches:[['owner','text',true],['installation_id','text',true],['task_id','text',true],['request_revision','bigint',true],['grant_id','text',true],['grant_revision','bigint',true],['batch_id','text',true],['batch_digest','text',true],['body','jsonb',true]],
    ontology_object_embeddings:[...['owner','installation_id','task_id','batch_id','object_type','object_id'].map(name=>[name,'text',true] as [string,string,boolean]),['object_revision','bigint',true],...['ontology_id','release_id','release_digest','space_digest','fields_digest','input_digest','vector_digest'].map(name=>[name,'text',true] as [string,string,boolean]),['dimensions','integer',true],['embedding','extensions.vector',true]],
    eigos_runtime_schema_extensions:[['feature','text',true],['body','jsonb',true]],
  };
  const primaryKeys:Record<string,string[]>={ontology_embedding_batches:['owner','installation_id','task_id','batch_id'],ontology_object_embeddings:['owner','installation_id','task_id','batch_id','object_type','object_id'],eigos_runtime_schema_extensions:['feature']};
  const normalized=(value:string)=>value.replace(/[\s"()]/g,'');
  for(const table of embeddingTableNames){
    const columns=await client.query(`SELECT a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,a.attgenerated,a.attidentity,d.adbin IS NOT NULL AS has_default,a.attcollation=t.typcollation AS default_collation
      FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_type t ON t.oid=a.atttypid JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,[schema,table]);
    if(digest(columns.rows.map(row=>[row.attname,row.type,row.attnotnull]))!==digest(expectedColumns[table])||columns.rows.some(row=>row.attgenerated||row.attidentity||row.has_default||!row.default_collation))throw new Error('Embedding columns differ');
    const constraints=await client.query(`SELECT k.contype,k.condeferrable,k.condeferred,k.convalidated,k.confupdtype,k.confdeltype,tn.nspname AS target_schema,t.relname AS target_table,
      ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY x(num,ord) JOIN pg_catalog.pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=x.num ORDER BY x.ord) AS columns,
      ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY x(num,ord) JOIN pg_catalog.pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=x.num ORDER BY x.ord) AS target_columns,
      pg_catalog.pg_get_expr(k.conbin,k.conrelid) AS expression FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid=k.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_catalog.pg_class t ON t.oid=k.confrelid LEFT JOIN pg_catalog.pg_namespace tn ON tn.oid=t.relnamespace WHERE n.nspname=$1 AND c.relname=$2`,[schema,table]);
    const pk=constraints.rows.filter(row=>row.contype==='p'),fk=constraints.rows.filter(row=>row.contype==='f'),checks=constraints.rows.filter(row=>row.contype==='c');
    if(constraints.rows.length!==(table==='ontology_embedding_batches'?1:table==='ontology_object_embeddings'?3:2)||constraints.rows.some(row=>row.condeferrable||row.condeferred||!row.convalidated)
      ||pk.length!==1||digest(pk[0]?.columns)!==digest(primaryKeys[table]))throw new Error('Embedding constraints differ');
    if(table==='ontology_object_embeddings'){
      if(fk.length!==1||fk[0]?.target_schema!==schema||fk[0]?.target_table!=='ontology_embedding_batches'||digest(fk[0]?.columns)!==digest(primaryKeys.ontology_embedding_batches)
        ||digest(fk[0]?.target_columns)!==digest(primaryKeys.ontology_embedding_batches)||fk[0]?.confupdtype!=='a'||fk[0]?.confdeltype!=='a'||checks.length!==1
        ||normalized(checks[0]?.expression??'')!==normalized('dimensions >= 1 AND dimensions <= 16000 AND extensions.vector_dims(embedding) = dimensions'))throw new Error('Embedding foreign key or dimension check differs');
    }else if(fk.length||table==='eigos_runtime_schema_extensions'&&(checks.length!==1||normalized(checks[0]?.expression??'')!==normalized("feature = 'task-vectors-v1'::text")))throw new Error('Embedding receipt constraint differs');
    const indexes=await client.query(`SELECT i.indisunique,i.indisprimary,i.indisvalid,i.indisready,i.indislive,i.indnatts,i.indnkeyatts,i.indpred IS NULL AS plain_predicate,i.indexprs IS NULL AS plain_expression,am.amname,
      ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY x(num,ord) JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=x.num ORDER BY x.ord) AS columns,
      NOT EXISTS(SELECT 1 FROM unnest(i.indcollation,i.indkey,i.indoption) x(coll,num,opt) JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=x.num WHERE x.coll<>a.attcollation OR x.opt<>0) AS default_order
      FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_class ix ON ix.oid=i.indexrelid JOIN pg_catalog.pg_am am ON am.oid=ix.relam WHERE n.nspname=$1 AND c.relname=$2`,[schema,table]);
    const index=indexes.rows[0];if(indexes.rowCount!==1||!index?.indisunique||!index.indisprimary||!index.indisvalid||!index.indisready||!index.indislive||!index.plain_predicate||!index.plain_expression||!index.default_order||index.amname!=='btree'
      ||Number(index.indnatts)!==primaryKeys[table]!.length||Number(index.indnkeyatts)!==primaryKeys[table]!.length||digest(index.columns)!==digest(primaryKeys[table]))throw new Error('Embedding index inventory differs');
    const triggers=await client.query(`SELECT t.tgname,t.tgtype,t.tgenabled,t.tgfoid::text,t.tgnargs,t.tgqual IS NULL AS unconditional,t.tgattr::text,t.tgconstraint,
      p.proname,pn.nspname AS function_schema FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
      WHERE n.nspname=$1 AND c.relname=$2 AND NOT t.tgisinternal`,[schema,table]);
    const trigger=triggers.rows[0];if(triggers.rowCount!==1||trigger?.tgname!==table+'_immutable'||Number(trigger.tgtype)!==27||trigger.tgenabled!=='O'||trigger.proname!=='eigos_immutable_embedding'||trigger.function_schema!==schema||Number(trigger.tgnargs)!==0||!trigger.unconditional||trigger.tgattr!==''||Number(trigger.tgconstraint)!==0)throw new Error('Embedding immutable guards differ');
    const extras=await client.query(`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=$1::regclass) OR EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite r WHERE r.ev_class=$1::regclass) AS extra`,[`${q}.${quoteEmbeddingIdentifier(table)}`]);
    if(extras.rows[0]?.extra!==false)throw new Error('Unreviewed embedding policy/rule');
    const privileges=await client.query(`SELECT pg_catalog.has_table_privilege($1,c.oid,'SELECT') AS read,pg_catalog.has_table_privilege($1,c.oid,'INSERT') AS insert,
      pg_catalog.has_table_privilege($1,c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR pg_catalog.has_any_column_privilege($1,c.oid,'UPDATE,REFERENCES') AS extra,
      EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner AND a.grantee<>pg_catalog.to_regrole($1)::oid) AS other_grantee
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$2 AND c.relname=$3`,[feature.runtimeRole,schema,table]);
    const privilege=privileges.rows[0];if(privileges.rowCount!==1||privilege?.read!==true||privilege.insert!==(table!=='eigos_runtime_schema_extensions')||privilege.extra!==false||privilege.other_grantee!==false)throw new Error('Embedding runtime table privileges differ');
  }
  const functions=await client.query(`SELECT p.proname,p.prosrc,p.prosecdef,p.proisstrict,p.provolatile,p.proparallel,p.proconfig,p.proleakproof,p.proretset,p.prokind,pg_catalog.pg_get_userbyid(p.proowner) AS owner,
    pg_catalog.oidvectortypes(p.proargtypes) AS args,pg_catalog.format_type(p.prorettype,NULL) AS result,l.lanname
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE n.nspname=$1 AND(p.proname LIKE 'eigos_vector_%' OR p.proname='eigos_immutable_embedding') ORDER BY p.proname`,[schema]);
  const from=functions.rows.find(row=>row.proname==='eigos_vector_from_values'),distance=functions.rows.find(row=>row.proname==='eigos_vector_cosine_values'),guard=functions.rows.find(row=>row.proname==='eigos_immutable_embedding');
  const config=['search_path=pg_catalog, pg_temp'];
  if(functions.rowCount!==3||!from||!distance||!guard||from.args!=='real[]'||from.result!=='extensions.vector'||from.prosrc.trim()!=='SELECT $1::extensions.vector'
    ||distance.args!=='extensions.vector, real[]'||distance.result!=='double precision'||distance.prosrc.trim()!=='SELECT extensions.cosine_distance($1,$2::extensions.vector)'
    ||[from,distance].some(row=>row.lanname!=='sql'||!row.prosecdef||!row.proisstrict||row.provolatile!=='i'||row.proparallel!=='s'||digest(row.proconfig)!==digest(config))
    ||guard.args!==''||guard.result!=='trigger'||guard.prosrc.trim()!=="BEGIN RAISE EXCEPTION 'Derived embedding history is immutable'; END"||guard.lanname!=='plpgsql'||guard.prosecdef||guard.proisstrict||guard.provolatile!=='v'||guard.proparallel!=='u'||digest(guard.proconfig)!==digest(config)
    ||functions.rows.some(row=>row.owner!==saved.adminRole||row.proleakproof||row.proretset||row.prokind!=='f'))throw new Error('Embedding numeric wrappers differ');
  const routineAcl=await client.query(`SELECT p.proname,pg_catalog.has_function_privilege($1,p.oid,'EXECUTE') AS execute,
    EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND a.grantee<>pg_catalog.to_regrole($1)::oid) AS other_grantee
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$2 AND p.proname=ANY($3::text[])`,[feature.runtimeRole,schema,embeddingRoutineNames]);
  if(routineAcl.rowCount!==3||routineAcl.rows.some(row=>row.execute!==(row.proname!=='eigos_immutable_embedding')||row.other_grantee))throw new Error('Embedding runtime routine privileges differ');
  return saved;
}
