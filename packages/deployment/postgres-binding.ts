import {constants,openSync,closeSync,fstatSync,readSync} from 'node:fs';
import {isAbsolute,resolve} from 'node:path';
import {createHash,X509Certificate} from 'node:crypto';
import {z} from 'zod';
import type {Config} from '../core/config.js';
import {runtimeAuthorityDigest} from '../core/runtime-authority.js';
import {digest} from '../core/delegation.js';
import {POSTGRES_MESSAGING_NODE_SCHEMA_V1} from '../postgres/messaging-schema.js';
import {agentIdSchema,relayOrigin} from '../relay/contracts.js';

const sha=z.string().regex(/^[a-f0-9]{64}$/),absolute=z.string().refine(value=>isAbsolute(value)&&resolve(value)===value);
const file=z.strictObject({path:absolute,sha256:sha});
const authority=z.strictObject({id:z.uuid(),revision:z.number().int().positive().safe(),digest:sha});
const identifier=z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}$/);
export const postgresBindingSchema=z.strictObject({
  version:z.literal(1),kind:z.literal('eigos.postgres-binding'),
  authority,sourceAuthority:authority,
  policyDigest:sha,
  business:z.strictObject({schema:z.string().regex(/^eigos_business_[a-z0-9_]{1,40}$/),sourceFileDigest:sha,schemaDigest:sha,importPolicyDigest:sha,receiptDigest:sha}),
  membership:z.strictObject({schema:z.string().regex(/^eigos_membership_[a-z0-9_]{1,40}$/),sourceFileDigest:sha,receiptDigest:sha}),
  connection:z.strictObject({host:z.hostname(),port:z.number().int().min(1).max(65535),database:identifier,user:identifier,role:identifier,
    tls:z.strictObject({ca:file}),passwordEnv:z.literal('EIGOS_POSTGRES_PASSWORD'),
    proxyUrl:z.url().refine(value=>{const url=new URL(value);return url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&!!url.port&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/';}).optional()}),
  relay:z.strictObject({baseUrl:z.string().transform(relayOrigin),configuration:file,sourceInventory:file,wrappingKey:z.strictObject({env:z.literal('EIGOS_RELAY_WRAPPING_KEY'),sha256:sha}),enrollmentKey:file,
    gatewayNode:z.strictObject({nodeId:z.string().min(1).max(200),agentId:agentIdSchema,importDigest:sha}),
    endpointImports:z.array(z.strictObject({endpointId:z.uuid(),agentId:agentIdSchema,importDigest:sha})).max(1000)}).optional(),
  handoff:file.optional(),activation:z.strictObject({id:z.uuid(),receiptDigest:sha,runtimeSchemaReceiptDigest:sha}).optional(),
}).superRefine((binding,ctx)=>{
  if(binding.authority.id!==binding.sourceAuthority.id||binding.authority.revision<binding.sourceAuthority.revision)ctx.addIssue({code:'custom',message:'Original authority identity must remain unchanged'});
  if(!!binding.handoff!==!!binding.activation)ctx.addIssue({code:'custom',message:'Formal activation requires both reviewed handoff and database receipt references'});
  if(binding.authority.digest!==binding.sourceAuthority.digest&&!binding.handoff)ctx.addIssue({code:'custom',message:'Authority progression requires an explicit reviewed handoff'});
  if(binding.relay&&new Set(binding.relay.endpointImports.map(endpoint=>endpoint.endpointId)).size!==binding.relay.endpointImports.length)ctx.addIssue({code:'custom',message:'Duplicate messaging endpoint import'});
  if(binding.relay?.gatewayNode.nodeId.startsWith('communication:'))ctx.addIssue({code:'custom',message:'The Gateway must retain its separate original Relay node'});
});
export type PostgresBinding=z.infer<typeof postgresBindingSchema>;
const hash=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
/** Stable host binding identity avoids circular hashes of the handoff files. */
export function postgresBindingIdentity(input:PostgresBinding):string{const {handoff:_handoff,activation:_activation,...identity}=postgresBindingSchema.parse(input);return digest(identity);}

/** Input contracts only. The controlled handoff producer must obtain real
 * writer fencing and independent verification; this module creates neither. */
export const postgresHandoffSchema=z.strictObject({version:z.literal(1),kind:z.literal('eigos.postgres-handoff'),activationId:z.uuid(),bindingIdentity:sha,
  sourceAuthority:authority,targetAuthority:authority,businessSchema:z.string().regex(/^eigos_business_[a-z0-9_]{1,40}$/),membershipSchema:z.string().regex(/^eigos_membership_[a-z0-9_]{1,40}$/),
  sourceFence:file,businessVerification:file,identityAudit:file,reviewDigest:sha});
function freezeContract<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freezeContract(child);Object.freeze(value);}return value;}
export const POSTGRES_RUNTIME_SCHEMA_CONTRACT=freezeContract({version:1,kind:'eigos.postgres-runtime-schema',activationTable:'eigos_runtime_activation',schemaReceiptTable:'eigos_runtime_schema_receipt',
  activationColumns:[['id','text',true],['body','jsonb',true]],schemaReceiptColumns:[['slot','bigint',true],['body','jsonb',true]],activationPrimaryKey:['id'],schemaReceiptPrimaryKey:['slot'],
  baseFunctions:[['eigos_try_jsonb','text'],['eigos_immutable_history',''],['eigos_preserve_rowid',''],['eigos_lock_runtime_authority',''],['eigos_current_runtime_authority','']],conditionalBaseFunctions:[['eigos_network_evidence_invalidate','']],
  schemaReceiptCheck:'slot=1',triggerFunction:'eigos_immutable_runtime_activation',triggerBody:"BEGIN RAISE EXCEPTION 'Runtime activation history is immutable'; END",mutation:'insert-by-reviewed-handoff-only',messagingNode:structuredClone(POSTGRES_MESSAGING_NODE_SCHEMA_V1)});
export const postgresRuntimeSchemaReceiptSchema=z.strictObject({version:z.literal(1),kind:z.literal('eigos.postgres-runtime-schema'),businessSchema:z.string(),baseSchemaDigest:sha,contractDigest:sha,baseVerificationDigest:sha,installedAt:z.iso.datetime({offset:true})});
export const postgresActivationSchema=z.strictObject({version:z.literal(1),kind:z.literal('eigos.postgres-activation'),id:z.uuid(),bindingIdentity:sha,sourceAuthority:authority,targetAuthority:authority,businessSchema:z.string(),membershipSchema:z.string(),
  handoffDigest:sha,sourceFenceDigest:sha,businessVerificationDigest:sha,identityAuditDigest:sha,runtimeSchemaReceiptDigest:sha,reviewDigest:sha});
export function readPinnedPostgresJson(reference:z.infer<typeof file>,maxBytes=8388608):unknown{
  try{const bytes=readOwnedBindingFile(reference.path,maxBytes,true);if(hash(bytes)!==reference.sha256)throw new Error();return JSON.parse(bytes.toString('utf8'));}
  catch{throw new Error('Reviewed PostgreSQL evidence is unavailable or changed');}
}
const enrollmentKeySchema=z.strictObject({kty:z.literal('OKP'),crv:z.literal('Ed25519'),x:z.string().regex(/^[A-Za-z0-9_-]{43}$/),d:z.string().regex(/^[A-Za-z0-9_-]{43}$/)});
const relayConfigurationSchema=z.strictObject({version:z.literal(1),relayUrl:z.string().transform(relayOrigin),credentialPath:absolute.optional(),statePath:absolute.optional(),displayName:z.string().min(1).max(80).default('EIGOS'),enrollmentKeyFile:absolute.optional(),operatorInstallationId:z.uuid().optional()});
const nodeCounts=z.strictObject({outbox:z.number().int().min(0).max(10000),inbox:z.number().int().min(0).max(10000),retained:z.number().int().min(0).max(10000)});
const nodeInventory=z.strictObject({nodeId:z.string().min(1).max(200),agentId:agentIdSchema,importDigest:sha,counts:nodeCounts,importReceipt:file,independentReadback:file});
export const postgresRelaySourceInventorySchema=z.strictObject({version:z.literal(1),kind:z.literal('eigos.relay-node-source-inventory'),sourceAuthority:authority,businessSnapshotDigest:sha,baseUrl:z.string().transform(relayOrigin),configurationDigest:sha,
  gatewayNode:nodeInventory,endpointImports:z.array(nodeInventory.extend({endpointId:z.uuid()})).max(1000)});
/** This checks existing, hash-pinned operator evidence; it never creates an
 * inventory or certifies source completeness. The actual reviewed handoff
 * pins this whole binding, and live startup separately checks every PG node. */
export function readPostgresRelaySourceInventory(binding:PostgresBinding){
  const relay=binding.relay;if(!relay)throw new Error('Configured PostgreSQL Relay binding is missing');
  const inventory=postgresRelaySourceInventorySchema.parse(readPinnedPostgresJson(relay.sourceInventory,1048576));
  const pin=(node:{nodeId:string;agentId:string;importDigest:string})=>({nodeId:node.nodeId,agentId:node.agentId,importDigest:node.importDigest});
  const endpoints=inventory.endpointImports.map(node=>({endpointId:node.endpointId,agentId:node.agentId,importDigest:node.importDigest})).sort((a,b)=>a.endpointId.localeCompare(b.endpointId));
  const expected=[...relay.endpointImports].sort((a,b)=>a.endpointId.localeCompare(b.endpointId));
  if(digest(inventory.sourceAuthority)!==digest(binding.sourceAuthority)||inventory.businessSnapshotDigest!==binding.business.sourceFileDigest||inventory.baseUrl!==relay.baseUrl||inventory.configurationDigest!==relay.configuration.sha256
    ||digest(pin(inventory.gatewayNode))!==digest(relay.gatewayNode)||digest(endpoints)!==digest(expected)
    ||inventory.endpointImports.some(node=>node.nodeId!==`communication:${node.endpointId}`)||new Set([inventory.gatewayNode,...inventory.endpointImports].map(node=>node.nodeId)).size!==1+endpoints.length)throw new Error('Complete Relay source inventory differs from its reviewed binding');
  for(const node of [inventory.gatewayNode,...inventory.endpointImports]){
    const imported=z.strictObject({status:z.enum(['imported','already-imported']),nodeId:z.string(),agentId:agentIdSchema,digest:sha,counts:nodeCounts}).parse(readPinnedPostgresJson(node.importReceipt,4096));
    const readback=z.strictObject({agentId:agentIdSchema,digest:sha,counts:nodeCounts}).parse(readPinnedPostgresJson(node.independentReadback,4096));
    if(imported.nodeId!==node.nodeId||imported.agentId!==node.agentId||readback.agentId!==node.agentId||imported.digest!==node.importDigest||readback.digest!==node.importDigest
      ||digest(imported.counts)!==digest(node.counts)||digest(readback.counts)!==digest(node.counts))throw new Error('Complete Relay import or independent readback differs from its source snapshot');
  }
  return inventory;
}
/** PG transport never opens the optional legacy credential/state paths. It
 * requires the independently migrated durable node declared in the binding. */
export function readPostgresTaskRelayConfiguration(binding:PostgresBinding,path:string){
  if(!binding.relay||binding.relay.configuration.path!==path)throw new Error('Task Relay configuration differs from the reviewed PostgreSQL binding');
  const config=relayConfigurationSchema.parse(readPinnedPostgresJson(binding.relay.configuration,8192));
  if(config.relayUrl!==binding.relay.baseUrl||config.enrollmentKeyFile&&config.enrollmentKeyFile!==binding.relay.enrollmentKey.path)throw new Error('Relay origin or enrollment key differs from the reviewed binding');return config;
}
/** Reads existing host secrets only. No key generation, rotation or model/JSON
 * secret input is accepted, and the reviewed wrapping-key fingerprint is fixed. */
export function readPostgresRelaySecrets(binding:PostgresBinding,environment:NodeJS.ProcessEnv){
  if(!binding.relay)throw new Error('Configured PostgreSQL Relay binding is missing');
  const value=environment.EIGOS_RELAY_WRAPPING_KEY;
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value))throw new Error('Host Relay wrapping key is unavailable');
  const bytes=Buffer.from(value,'base64url');
  if(bytes.length!==32||bytes.toString('base64url')!==value||hash(bytes)!==binding.relay.wrappingKey.sha256){bytes.fill(0);throw new Error('Host Relay wrapping key differs from the reviewed binding');}
  try{return {wrappingKeyBytes:bytes,enrollmentKey:enrollmentKeySchema.parse(readPinnedPostgresJson(binding.relay.enrollmentKey,4096))};}
  catch{bytes.fill(0);throw new Error('Reviewed Relay enrollment key is unavailable or invalid');}
}

/** No URL/password/activation state is accepted in this operator-owned file.
 * The file binds existing imports; reading it initializes no store or grant. */
export function readPostgresBinding(path:string):{binding:PostgresBinding;fileDigest:string}{
  let bytes:Buffer;
  try{bytes=readOwnedBindingFile(path,65536,true);return {binding:postgresBindingSchema.parse(JSON.parse(bytes.toString('utf8'))),fileDigest:hash(bytes)};}
  catch{throw new Error('Invalid owned PostgreSQL binding file');}
}
export function readOwnedBindingFile(path:string,maxBytes:number,privateFile:boolean):Buffer{
  if(!isAbsolute(path)||resolve(path)!==path||!Number.isSafeInteger(maxBytes)||maxBytes<1)throw new Error('An absolute owned file is required');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const before=fstatSync(fd);
    if(!before.isFile()||before.nlink!==1||process.getuid&&before.uid!==process.getuid()&&(privateFile||before.uid!==0)||(before.mode&(privateFile?0o077:0o022))!==0||before.size<1||before.size>maxBytes)throw new Error('File ownership, permissions or size are invalid');
    const buffer=Buffer.allocUnsafe(before.size+1);let offset=0;
    while(offset<buffer.length){const read=readSync(fd,buffer,offset,buffer.length-offset,null);if(!read)break;offset+=read;}
    const bytes=buffer.subarray(0,offset),after=fstatSync(fd);
    if(bytes.length!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw new Error('Owned file changed during read');
    return bytes;
  }finally{closeSync(fd);}
}
export function assertPostgresBindingAuthority(config:Pick<Config,'authority'|'EIGOS_AUTH_MODE'|'EIGOS_SECURITY_MODE'>,binding:PostgresBinding):void{
  if(!config.authority||config.EIGOS_AUTH_MODE!=='jwt'||config.EIGOS_SECURITY_MODE!=='foundation')throw new Error('PostgreSQL requires the existing primary foundation JWT authority');
  const expected={id:config.authority.id,revision:config.authority.revision,digest:runtimeAuthorityDigest(config.authority)};
  if(digest(binding.authority)!==digest(expected))throw new Error('PostgreSQL binding differs from the existing primary authority');
}
/** Pinned CA bytes and hostname verification are mandatory for every pool.
 * Returning options never connects and never consults URL/PG* fallbacks. */
export function postgresConnectionOptions(binding:PostgresBinding,environment:NodeJS.ProcessEnv){
  const {connection}=postgresBindingSchema.parse(binding);
  for(const key of ['PGOPTIONS','PGBINARY','PGREPLICATION','PGSSLNEGOTIATION','PGSERVICE','PGSERVICEFILE'])if(environment[key]!==undefined||process.env[key]!==undefined)throw new Error('Unreviewed ambient PostgreSQL connection options are not allowed');
  const ca=readOwnedBindingFile(connection.tls.ca.path,1048576,false);
  if(hash(ca)!==connection.tls.ca.sha256)throw new Error('PostgreSQL CA differs from the reviewed binding');
  const pem=ca.toString('utf8'),certificates=pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if(!certificates?.length)throw new Error('PostgreSQL CA is not a certificate bundle');
  try{for(const certificate of certificates)new X509Certificate(certificate);}catch{throw new Error('PostgreSQL CA bundle is invalid');}
  const password=environment.EIGOS_POSTGRES_PASSWORD;
  if(typeof password!=='string'||!password.length||password.includes('\0'))throw new Error('PostgreSQL runtime password is unavailable');
  return {host:connection.host,port:connection.port,database:connection.database,user:connection.user,password,
    ssl:{ca:pem,rejectUnauthorized:true as const,servername:connection.host},connectionTimeoutMillis:15000,
    options:'-c search_path=pg_catalog',sslnegotiation:'postgres' as const,client_encoding:'UTF8',query_timeout:15000,
    statement_timeout:10000,lock_timeout:5000,idle_in_transaction_session_timeout:10000,application_name:'eigos-postgres-runtime'};
}
