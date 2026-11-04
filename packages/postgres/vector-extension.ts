import type {Client} from 'pg';
import {createHash,X509Certificate} from 'node:crypto';
import {isAbsolute,resolve} from 'node:path';
import {z} from 'zod';
import {digest} from '../core/delegation.js';
import {readOwnedBindingFile} from '../deployment/postgres-binding.js';
import {supabaseProxyOptions} from './supabase-proxy.js';

const identifier=z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}$/);
const version=z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/);
export const postgresVectorOperationSchema=z.strictObject({
  version:z.literal(1),kind:z.literal('eigos.postgres-vector-operation'),
  target:z.strictObject({host:z.hostname(),port:z.number().int().min(1).max(65535),database:identifier,
    ca:z.strictObject({path:z.string().refine(path=>isAbsolute(path)&&resolve(path)===path),sha256:z.string().regex(/^[a-f0-9]{64}$/)}),
    proxyUrl:z.string().optional()}),
  adminIdentity:z.strictObject({user:identifier,role:identifier}),
  extension:z.strictObject({name:z.literal('vector'),schema:z.literal('extensions'),version}),
}).superRefine((operation,ctx)=>{
  try{supabaseProxyOptions(operation.target.host,operation.target.port,operation.target.proxyUrl);}
  catch{ctx.addIssue({code:'custom',message:'Invalid reviewed Supabase proxy'});}
});
export type PostgresVectorOperation=z.infer<typeof postgresVectorOperationSchema>;

/** Offline planning only. The exact version is an operator-reviewed target
 * fact, never inferred from an embedding provider or silently upgraded. */
export function previewPostgresVector(input:unknown){
  const operation=postgresVectorOperationSchema.parse(input);
  return {version:1,kind:'eigos.postgres-vector-preview',status:'preview-only',operation,
    installSql:installSql(operation),requiresExistingSchema:'extensions',targetInspected:false,
    writeScope:'vector-extension-only',businessDataChanged:false,runtimeGrantStatementsIssued:false,
    runtimeRoleCompatibility:'not-verified',semanticRetrieval:'not-configured',embeddingProvider:'not-configured'} as const;
}

/** Existing host administrator credentials remain in memory. No URL or
 * libpq fallback can override the reviewed target or verified CA. */
export function postgresVectorConnectionOptions(input:unknown,environment:NodeJS.ProcessEnv){
  const operation=postgresVectorOperationSchema.parse(input),{target,adminIdentity}=operation;
  for(const key of ['PGOPTIONS','PGBINARY','PGREPLICATION','PGSSLNEGOTIATION','PGSERVICE','PGSERVICEFILE']){
    if(environment[key]!==undefined||process.env[key]!==undefined)throw new Error('Unreviewed ambient PostgreSQL options are not allowed');
  }
  if([environment.NODE_TLS_REJECT_UNAUTHORIZED,process.env.NODE_TLS_REJECT_UNAUTHORIZED].some(value=>value!==undefined&&value!=='1'))throw new Error('TLS verification must remain enabled');
  if(environment.EIGOS_POSTGRES_ADMIN_USER!==adminIdentity.user)throw new Error('Administrator login differs from the reviewed target');
  const password=environment.EIGOS_POSTGRES_ADMIN_PASSWORD;
  if(!password||password.includes('\0'))throw new Error('Existing administrator password is unavailable');
  const ca=readOwnedBindingFile(target.ca.path,1048576,false);
  if(createHash('sha256').update(ca).digest('hex')!==target.ca.sha256)throw new Error('PostgreSQL CA differs from the reviewed target');
  const pem=ca.toString('utf8'),certificates=pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if(!certificates?.length)throw new Error('PostgreSQL CA is not a certificate bundle');
  try{for(const certificate of certificates)new X509Certificate(certificate);}catch{throw new Error('PostgreSQL CA bundle is invalid');}
  return {...supabaseProxyOptions(target.host,target.port,target.proxyUrl),host:target.host,port:target.port,database:target.database,
    user:adminIdentity.user,password,ssl:{ca:pem,rejectUnauthorized:true as const,servername:target.host},
    options:'-c search_path=pg_catalog',sslnegotiation:'postgres' as const,client_encoding:'UTF8',
    connectionTimeoutMillis:15000,query_timeout:15000,statement_timeout:10000,lock_timeout:5000,
    idle_in_transaction_session_timeout:10000,application_name:'eigos-postgres-vector-admin'};
}

const extensionSchema=z.strictObject({name:z.literal('vector'),schema:z.literal('extensions'),version,owner:identifier,relocatable:z.literal(true),hasConfigurationTables:z.literal(false)});
export const postgresVectorSmokeSchema=z.strictObject({
  fixture:z.literal('orthogonal-unit-vectors-v1'),dimensions:z.literal(3),
  l2:z.number().finite(),cosine:z.number().finite(),negativeInnerProduct:z.number().finite(),
  selfL2:z.number().finite(),selfCosine:z.number().finite(),selfNegativeInnerProduct:z.number().finite(),
});
export type PostgresVectorSmoke=z.infer<typeof postgresVectorSmokeSchema>;
/** These three-dimensional unit vectors are an arithmetic fixture only;
 * they do not choose a business embedding model or its dimensions. */
export function assertPostgresVectorSmoke(input:unknown):PostgresVectorSmoke{
  const smoke=postgresVectorSmokeSchema.parse(input);
  for(const [actual,expected] of [[smoke.l2,Math.SQRT2],[smoke.cosine,1],[smoke.negativeInnerProduct,0],[smoke.selfL2,0],[smoke.selfCosine,0],[smoke.selfNegativeInnerProduct,-1]]){
    if(actual===undefined||expected===undefined||Math.abs(actual-expected)>1e-6)throw new Error('Actual vector operator smoke result differs');
  }
  return smoke;
}

function installSql(operation:PostgresVectorOperation){return `CREATE EXTENSION vector WITH SCHEMA extensions VERSION '${operation.extension.version}'`;}
function assertIdleTls(client:Client){
  if(client.getTransactionStatus()!=='I'||client.pipeline!==false)throw new Error('Vector administration requires an idle client');
  const connection:unknown=Reflect.get(client,'connection'),stream=connection&&typeof connection==='object'?Reflect.get(connection,'stream'):undefined;
  if(!stream||typeof stream!=='object'||Reflect.get(stream,'encrypted')!==true||Reflect.get(stream,'authorized')!==true)throw new Error('Vector administration requires acknowledged verified TLS');
}
async function assertIdentity(client:Client,operation:PostgresVectorOperation){
  const result=await client.query("SELECT current_database() AS database,current_user AS role,session_user AS session_role,current_setting('server_encoding') AS encoding");
  const row=result.rows[0];
  if(result.rowCount!==1||!row||row.database!==operation.target.database||row.role!==operation.adminIdentity.role||row.session_role!==operation.adminIdentity.role||row.encoding!=='UTF8')throw new Error('Vector administrator identity differs from the reviewed target');
}
async function installedExtension(client:Client,operation:PostgresVectorOperation){
  const result=await client.query(`SELECT e.extname AS name,n.nspname AS schema,e.extversion AS version,pg_catalog.pg_get_userbyid(e.extowner) AS owner,
    e.extrelocatable AS relocatable,e.extconfig IS NOT NULL AS "hasConfigurationTables",e.oid::text AS oid
    FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector'`);
  if(result.rowCount===0)return undefined;
  const row=result.rows[0];if(result.rowCount!==1||!row)throw new Error('Vector extension inventory is incomplete');
  const {oid,...metadata}=row,extension=extensionSchema.parse(metadata);
  if(extension.version!==operation.extension.version||typeof oid!=='string')throw new Error('Installed vector version differs; automatic upgrades or relocation are forbidden');
  return {oid,extension};
}
const routineNames=['vector_in','vector_out','vector_dims','l2_distance','cosine_distance','vector_negative_inner_product'] as const;
const routineSignatures=['vector_in(cstring,oid,integer)','vector_out(extensions.vector)','vector_dims(extensions.vector)','l2_distance(extensions.vector,extensions.vector)','cosine_distance(extensions.vector,extensions.vector)','vector_negative_inner_product(extensions.vector,extensions.vector)'].map(name=>'extensions.'+name);

/** Inspect the actual routines/type/operators before executing even the
 * synthetic literals. A same-named SQL/security-definer replacement is denied. */
async function readbackInSnapshot(client:Client,operation:PostgresVectorOperation){
  const installed=await installedExtension(client,operation);if(!installed)throw new Error('Reviewed vector extension is not installed');
  const type=await client.query(`SELECT t.oid::text AS oid,t.typinput::oid::text AS input,t.typoutput::oid::text AS output,t.typisdefined,t.typtype,
    EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_type'::regclass AND d.objid=t.oid AND d.refclassid='pg_catalog.pg_extension'::regclass AND d.refobjid=$1::oid AND d.deptype='e') AS owned
    FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='extensions' AND t.typname='vector'`,[installed.oid]);
  const t=type.rows[0];if(type.rowCount!==1||!t||!t.owned||!t.typisdefined||t.typtype!=='b')throw new Error('Vector type is not owned by the reviewed extension');
  const routines=await client.query(`SELECT r.signature,p.oid::text AS oid,p.proname,p.prosrc,p.probin,p.provolatile,p.proisstrict,p.proparallel,p.prosecdef,p.proconfig,l.lanname,
    pg_catalog.format_type(p.prorettype,NULL) AS return_type,
    EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_proc'::regclass AND d.objid=p.oid AND d.refclassid='pg_catalog.pg_extension'::regclass AND d.refobjid=$2::oid AND d.deptype='e') AS owned
    FROM pg_catalog.unnest($1::text[]) r(signature) LEFT JOIN pg_catalog.pg_proc p ON p.oid=pg_catalog.to_regprocedure(r.signature)
    LEFT JOIN pg_catalog.pg_language l ON l.oid=p.prolang ORDER BY r.signature`,[routineSignatures,installed.oid]);
  if(routines.rowCount!==routineNames.length)throw new Error('Vector routine inventory is incomplete');
  const ids=new Map<string,string>();
  for(const [index,signature] of routineSignatures.entries()){
    const name=routineNames[index],rows=routines.rows.filter(row=>row.signature===signature),row=rows[0];
    const expectedReturn=name==='vector_in'?'extensions.vector':name==='vector_out'?'cstring':name==='vector_dims'?'integer':'double precision';
    if(rows.length!==1||!row||typeof row.oid!=='string'||row.proname!==name||row.prosrc!==name||row.probin!=='$libdir/vector'||row.lanname!=='c'||row.provolatile!=='i'||row.proisstrict!==true||row.proparallel!=='s'||row.prosecdef!==false||row.proconfig!==null||row.return_type!==expectedReturn||row.owned!==true)throw new Error('Vector routine implementation differs from the extension contract');
    ids.set(name!,row.oid);
  }
  if(t.input!==ids.get('vector_in')||t.output!==ids.get('vector_out'))throw new Error('Vector type IO implementation differs');
  const operators=await client.query(`SELECT o.oprname,o.oprcode::oid::text AS routine,
    EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_operator'::regclass AND d.objid=o.oid AND d.refclassid='pg_catalog.pg_extension'::regclass AND d.refobjid=$1::oid AND d.deptype='e') AS owned
    FROM pg_catalog.pg_operator o JOIN pg_catalog.pg_namespace n ON n.oid=o.oprnamespace
    WHERE n.nspname='extensions' AND o.oprname=ANY($2::text[]) AND o.oprleft=$3::oid AND o.oprright=$3::oid ORDER BY o.oprname`,[installed.oid,['<->','<=>','<#>'],t.oid]);
  for(const [name,routine] of [['<->','l2_distance'],['<=>','cosine_distance'],['<#>','vector_negative_inner_product']] as const){
    const rows=operators.rows.filter(row=>row.oprname===name);if(rows.length!==1||rows[0]?.routine!==ids.get(routine)||rows[0]?.owned!==true)throw new Error('Vector distance operator differs from the reviewed extension');
  }
  if(operators.rowCount!==3)throw new Error('Vector operator inventory is incomplete');
  const result=await client.query(`WITH v AS (SELECT $1::extensions.vector AS a,$2::extensions.vector AS b)
    SELECT extensions.vector_dims(a) AS dimensions,a OPERATOR(extensions.<->) b AS l2,a OPERATOR(extensions.<=>) b AS cosine,
      a OPERATOR(extensions.<#>) b AS "negativeInnerProduct",a OPERATOR(extensions.<->) a AS "selfL2",
      a OPERATOR(extensions.<=>) a AS "selfCosine",a OPERATOR(extensions.<#>) a AS "selfNegativeInnerProduct" FROM v`,['[1,0,0]','[0,1,0]']);
  if(result.rowCount!==1)throw new Error('Actual vector smoke is incomplete');
  const smoke=assertPostgresVectorSmoke({fixture:'orthogonal-unit-vectors-v1',...result.rows[0]});
  return {version:1,kind:'eigos.postgres-vector-readback',status:'verified-at-snapshot',extension:installed.extension,
    target:{host:operation.target.host,port:operation.target.port,database:operation.target.database,adminRole:operation.adminIdentity.role},
    catalogDigest:digest({extension:installed.extension,type:t,routines:routines.rows,operators:operators.rows}),smoke,
    businessDataRead:false,businessDataChanged:false,runtimeGrantStatementsIssued:false,runtimeRoleCompatibility:'not-verified',semanticRetrieval:'not-configured'} as const;
}

/** This verifier never installs, upgrades, relocates, grants or reads business
 * tables. A separate connection is required for post-commit independent proof. */
export async function verifyPostgresVector(client:Client,input:unknown){
  const operation=postgresVectorOperationSchema.parse(input);assertIdleTls(client);let opened=false;
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');opened=true;
    await client.query('SET LOCAL search_path=pg_catalog');await assertIdentity(client,operation);
    const result=await readbackInSnapshot(client,operation);await client.query('COMMIT');opened=false;return result;
  }catch(error){if(opened)try{await client.query('ROLLBACK');}catch{/* Preserve the first failure; this client must be discarded. */}throw error;}
}

/** Explicit migration administrator operation only, never a runtime startup
 * hook. Existing mismatched versions/namespaces fail instead of being moved. */
export async function installPostgresVector(client:Client,input:unknown){
  const operation=postgresVectorOperationSchema.parse(input);assertIdleTls(client);let opened=false,committing=false;
  try{
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');opened=true;
    await client.query('SET LOCAL search_path=pg_catalog');await assertIdentity(client,operation);
    const schema=await client.query("SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname='extensions'");
    if(schema.rowCount!==1)throw new Error('Existing extensions schema is required; this operation never creates schemas');
    const existing=await installedExtension(client,operation);
    if(!existing){
      const available=await client.query("SELECT version,relocatable,schema FROM pg_catalog.pg_available_extension_versions WHERE name='vector' AND version=$1",[operation.extension.version]);
      if(available.rowCount!==1||available.rows[0]?.relocatable!==true||available.rows[0]?.schema!==null&&available.rows[0]?.schema!=='extensions')throw new Error('Exact reviewed vector package is unavailable for this namespace');
      await client.query(installSql(operation));
    }
    const readback=await readbackInSnapshot(client,operation);committing=true;await client.query('COMMIT');opened=false;
    return {status:existing?'already-installed':'installed',commitAcknowledged:true,readback} as const;
  }catch(error){
    if(committing)throw new Error('Vector extension commit outcome is unknown; independently inspect before any retry',{cause:error});
    if(opened)try{await client.query('ROLLBACK');}catch{/* Do not replace the first failure or retry. */}
    throw error;
  }
}
