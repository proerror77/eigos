import type {Client} from 'pg';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {isAbsolute} from 'node:path';
import {join} from 'node:path';
import {mkdirSync,writeFileSync} from 'node:fs';
import {digest} from '../core/delegation.js';
import {agentIdSchema,relayOrigin} from '../relay/contracts.js';
import {relayNodeSnapshotSchema} from '../agent-transport/store.js';
import {validateRelayNodeSnapshot,relayNodeWrappingKey,withPostgresOfflineRelayNodeContext,importPostgresRelayNodeInAdminContext,postgresRelayNodeDigestInAdminContext,type OfflineRelayNodeReview} from '../postgres/relay-node-store.js';
import {readPostgresHandoffOperation,withPreparedPostgresNodeTransaction} from './postgres-handoff.js';
import {postgresBindingSchema,postgresNodeMigrationBindingIdentity,postgresHistoricalRelayOrigin,postgresRelayRepointReceiptSchema,postgresRelaySourceInventoryV2Schema,readPinnedPostgresJson,readOwnedBindingFile,readPostgresRelaySourceInventory,readReviewedPostgresRelayConfiguration,POSTGRES_RUNTIME_SCHEMA_CONTRACT,type PostgresBinding} from './postgres-binding.js';

const sha=z.string().regex(/^[a-f0-9]{64}$/),file=z.strictObject({path:z.string().refine(isAbsolute),sha256:sha});
const sourceFiles=z.strictObject({credentialFileDigest:sha,stateFileDigest:sha});
const sourceNode=z.strictObject({nodeId:z.string().min(1).max(200),agentId:agentIdSchema,endpointId:z.uuid().optional(),sourceSnapshot:file,sourceSnapshotDigest:sha,sourceFiles});
export const postgresNodeSourceManifestSchema=z.strictObject({version:z.literal(1),kind:z.literal('eigos.relay-node-source-files'),sourceAuthority:postgresBindingSchema.shape.sourceAuthority,businessSnapshotDigest:sha,membershipSnapshotDigest:sha,sourceBaseUrl:z.string().transform(postgresHistoricalRelayOrigin),nodes:z.array(sourceNode).min(1).max(1001),uninitializedEndpoints:z.array(z.uuid()).max(1000)});
export const postgresNodeMigrationOperationSchema=z.strictObject({version:z.literal(1),kind:z.literal('eigos.postgres-node-migration'),handoffOperation:file,schemaReceiptDigest:sha,sourceManifest:file,targetConfiguration:file,wrappingKey:z.strictObject({env:z.literal('EIGOS_RELAY_WRAPPING_KEY'),sha256:sha})});
type SourceManifest=z.infer<typeof postgresNodeSourceManifestSchema>;
const wrappingKeyPins=new WeakMap<CryptoKey,string>();
function requireWrappingKey(key:CryptoKey,expected:string){if(wrappingKeyPins.get(key)!==expected)throw new Error('Offline migration requires the actual hash-pinned host wrapping key');}

/** No source file is changed. Only the origin field is replaced; signatures
 * and original receipt TEXT are verified without treating expiry/history as
 * current permission or contacting either Relay. */
export async function repointRelayNodeSnapshot(input:unknown,options:{nodeId:string;agentId:string;sourceBaseUrl:string;targetBaseUrl:string;sourceSnapshotDigest:string;sourceFiles:z.infer<typeof sourceFiles>}){
  const snapshot=relayNodeSnapshotSchema.parse(input),source=postgresHistoricalRelayOrigin(options.sourceBaseUrl),target=relayOrigin(options.targetBaseUrl);
  if(snapshot.credentials.baseUrl!==source||digest(snapshot)!==options.sourceSnapshotDigest)throw new Error('Original private snapshot differs from its exact source digest or origin');
  if(snapshot.format!=='eigos.relay-node.snapshot.v2')throw new Error('Offline formal migration requires v2 original receipt TEXT; v1 raw serialization is unknown');
  const changed={...snapshot,credentials:{...snapshot.credentials,baseUrl:target}},targetSnapshotDigest=digest(changed);
  await validateRelayNodeSnapshot(changed,{baseUrl:target,agentId:options.agentId,digest:targetSnapshotDigest});
  const {baseUrl:_source,...originalKeys}=snapshot.credentials,{baseUrl:_target,...targetKeys}=changed.credentials;
  if(digest(originalKeys)!==digest(targetKeys)||digest([snapshot.outbox,snapshot.inbox,snapshot.retained])!==digest([changed.outbox,changed.inbox,changed.retained]))throw new Error('Origin repoint changed original private values or history');
  const receipt=postgresRelayRepointReceiptSchema.parse({version:1,kind:'eigos.relay-node-origin-repoint',nodeId:options.nodeId,agentId:options.agentId,sourceBaseUrl:source,targetBaseUrl:target,sourceSnapshotDigest:options.sourceSnapshotDigest,targetSnapshotDigest,
    credentialsDigest:digest(originalKeys),historyDigest:digest([snapshot.outbox,snapshot.inbox,snapshot.retained]),cursorsDigest:digest([snapshot.outbox.map(row=>row.cursor),snapshot.inbox.map(row=>row.cursor),snapshot.retained.map(row=>row.cursor)]),sourceFiles:options.sourceFiles,counts:{outbox:snapshot.outbox.length,inbox:snapshot.inbox.length,retained:snapshot.retained.length},receiptText:'preserved',serverAcceptance:'not-observed'});
  return {snapshot:changed,receipt};
}

export async function postgresMigrationWrappingKey(reference:{env:'EIGOS_RELAY_WRAPPING_KEY';sha256:string},environment:NodeJS.ProcessEnv=process.env){
  const value=environment.EIGOS_RELAY_WRAPPING_KEY;if(typeof value!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value))throw new Error('Existing host node wrapping key is unavailable');
  const bytes=Buffer.from(value,'base64url');try{if(bytes.length!==32||bytes.toString('base64url')!==value||createHash('sha256').update(bytes).digest('hex')!==reference.sha256)throw new Error('Existing host wrapping key differs from the reviewed migration');const key=await relayNodeWrappingKey(bytes);wrappingKeyPins.set(key,reference.sha256);return key;}finally{bytes.fill(0);}
}

function readOperation(input:unknown){
  const operation=postgresNodeMigrationOperationSchema.parse(input),handoffInput=readPinnedPostgresJson(operation.handoffOperation,65536),checked=readPostgresHandoffOperation(handoffInput);
  if(checked.operation.phase!=='prepare-schema')throw new Error('Node import uses the separate schema-prepared, not activated, binding');
  const manifest=postgresNodeSourceManifestSchema.parse(readPinnedPostgresJson(operation.sourceManifest,1048576)),configuration=readReviewedPostgresRelayConfiguration(operation.targetConfiguration),binding=checked.binding;
  if(digest(manifest.sourceAuthority)!==digest(binding.sourceAuthority)||manifest.businessSnapshotDigest!==binding.business.sourceFileDigest||manifest.membershipSnapshotDigest!==binding.membership.sourceFileDigest||new Set(manifest.nodes.map(node=>node.nodeId)).size!==manifest.nodes.length||manifest.nodes.filter(node=>!node.endpointId).length!==1||manifest.nodes.some(node=>node.endpointId?node.nodeId!==`communication:${node.endpointId}`:node.nodeId.startsWith('communication:'))||new Set(manifest.uninitializedEndpoints).size!==manifest.uninitializedEndpoints.length||manifest.nodes.some(node=>node.endpointId&&manifest.uninitializedEndpoints.includes(node.endpointId)))throw new Error('Complete source manifest differs from its original authority, files or endpoint identities');
  return {operation,handoffInput,checked,manifest,configuration};
}
async function repointSource(manifest:SourceManifest,node:z.infer<typeof sourceNode>,targetBaseUrl:string){
  const snapshot=readPinnedPostgresJson(node.sourceSnapshot,67108864);
  return repointRelayNodeSnapshot(snapshot,{...node,sourceBaseUrl:manifest.sourceBaseUrl,targetBaseUrl});
}
export async function previewPostgresNodeMigration(input:unknown){
  const loaded=readOperation(input),nodes=[];
  for(const node of loaded.manifest.nodes){const checked=await repointSource(loaded.manifest,node,loaded.configuration.relayUrl);nodes.push({nodeId:node.nodeId,agentId:node.agentId,...(node.endpointId?{endpointId:node.endpointId}:{}),sourceSnapshotDigest:node.sourceSnapshotDigest,targetSnapshotDigest:checked.receipt.targetSnapshotDigest,sourceFiles:node.sourceFiles,counts:checked.receipt.counts,repointReceipt:checked.receipt});}
  return {version:1,status:'preview-only',bindingIdentity:postgresNodeMigrationBindingIdentity(loaded.checked.binding),sourceManifestDigest:loaded.operation.sourceManifest.sha256,sourceBaseUrl:loaded.manifest.sourceBaseUrl,targetBaseUrl:loaded.configuration.relayUrl,schemaReceiptDigest:loaded.operation.schemaReceiptDigest,nodes,uninitializedEndpoints:loaded.manifest.uninitializedEndpoints,serverAcceptance:'not-observed',targetInspected:false};
}
function reviewFor(binding:PostgresBinding,adminRole:string,schemaReceiptDigest:string,baseVerificationDigest:string,nodes:OfflineRelayNodeReview['nodes']):OfflineRelayNodeReview{return {businessSchema:binding.business.schema,membershipSchema:binding.membership.schema,adminRole,runtimeRole:binding.connection.role,authority:binding.authority,businessSourceDigest:binding.business.sourceFileDigest,membershipSourceDigest:binding.membership.sourceFileDigest,policyDigest:binding.policyDigest,schemaReceiptDigest,contractDigest:digest(POSTGRES_RUNTIME_SCHEMA_CONTRACT),baseSchemaDigest:binding.business.schemaDigest,baseVerificationDigest,nodes};}
async function assertCompleteNodes(client:Client,binding:PostgresBinding,nodes:readonly {nodeId:string;agentId:string;endpointId?:string}[],absent:readonly string[],importing:boolean){
  const q=`"${binding.business.schema}"`,rows=await client.query(`SELECT id,CASE WHEN octet_length(body)<=32768 THEN body END AS body FROM ${q}.messaging_grants ORDER BY id LIMIT 1001`);
  if(rows.rows.length>1000)throw new Error('Complete communication history exceeds the reviewed migration bound');
  const ids=new Set(rows.rows.map(row=>String(row.id)));
  for(const node of nodes)if(node.endpointId&&!ids.has(node.endpointId))throw new Error('A source node has no original communication metadata');
  for(const id of absent)if(!ids.has(id))throw new Error('Source absence evidence has no original endpoint');
  for(const row of rows.rows){if(typeof row.body!=='string')throw new Error('Complete communication metadata is unreadable');const grant=z.object({id:z.string(),agentId:agentIdSchema.optional()}).parse(JSON.parse(row.body));if(grant.id!==row.id)throw new Error('Original communication metadata identity differs');const node=nodes.find(node=>node.endpointId===row.id);
    if(node){if(grant.agentId&&grant.agentId!==node.agentId)throw new Error('Original endpoint agent identity differs');}
    else if(grant.agentId||!absent.includes(row.id))throw new Error('Missing node history or explicit frozen source absence evidence');
  }
  const existing=await client.query(`SELECT node_id,agent_id FROM ${q}.eigos_relay_node_state ORDER BY node_id COLLATE "C" LIMIT 1002`);
  if(existing.rows.length>1001||existing.rows.some(row=>!nodes.some(node=>node.nodeId===row.node_id&&node.agentId===row.agent_id))||!importing&&existing.rowCount!==nodes.length)throw new Error('Actual PG node inventory is missing, extra or pinned to another identity');
  // No history may exist without state; a partial earlier import is never
  // reinterpreted as an empty or newly initialized node.
  for(const table of ['outbox','inbox','retained'])if((await client.query(`SELECT 1 FROM ${q}.eigos_relay_node_${table} h LEFT JOIN ${q}.eigos_relay_node_state s ON s.node_id=h.node_id WHERE s.node_id IS NULL LIMIT 1`)).rowCount)throw new Error('Partial original node history requires operator recovery');
}

/** One actual admin transaction imports the whole reviewed set. It creates
 * neither a manager lease nor a task/grant, and never calls a remote Relay. */
export async function importPostgresNodeMigration(client:Client,input:unknown,wrappingKey:CryptoKey){
  const loaded=readOperation(input),preview=await previewPostgresNodeMigration(input),binding=loaded.checked.binding;
  requireWrappingKey(wrappingKey,loaded.operation.wrappingKey.sha256);
  return withPreparedPostgresNodeTransaction(client,loaded.handoffInput,async checked=>{
    const pins=preview.nodes.map(node=>({nodeId:node.nodeId,agentId:node.agentId,baseUrl:preview.targetBaseUrl,digest:node.targetSnapshotDigest,snapshotVersion:2 as const}));
    await assertCompleteNodes(client,binding,preview.nodes,loaded.manifest.uninitializedEndpoints,true);
    return withPostgresOfflineRelayNodeContext(client,reviewFor(binding,checked.operation.adminIdentity.role,loaded.operation.schemaReceiptDigest,checked.operation.businessVerification.sha256,pins),async context=>{
      const results=[];
      for(const node of loaded.manifest.nodes){const changed=await repointSource(loaded.manifest,node,preview.targetBaseUrl),pin=pins.find(pin=>pin.nodeId===node.nodeId)!;
        const imported=await importPostgresRelayNodeInAdminContext(context,{nodeId:pin.nodeId,baseUrl:pin.baseUrl,wrappingKey,snapshot:changed.snapshot,expectedAgentId:pin.agentId,expectedSnapshotDigest:pin.digest});
        const readback=await postgresRelayNodeDigestInAdminContext(context,{nodeId:pin.nodeId,baseUrl:pin.baseUrl,wrappingKey,expectedAgentId:pin.agentId,expectedSnapshotDigest:pin.digest});
        results.push({nodeId:node.nodeId,...(node.endpointId?{endpointId:node.endpointId}:{}),repoint:changed.receipt,importReceipt:imported,readback});
      }
      await assertCompleteNodes(client,binding,preview.nodes,loaded.manifest.uninitializedEndpoints,false);
      return {version:1,status:'nodes-imported-not-started',bindingIdentity:preview.bindingIdentity,sourceManifestDigest:loaded.operation.sourceManifest.sha256,sourceBaseUrl:preview.sourceBaseUrl,targetBaseUrl:preview.targetBaseUrl,nodes:results,serverAcceptance:'not-observed'};
    });
  });
}

export async function verifyPostgresNodeMigration(client:Client,input:unknown,wrappingKey:CryptoKey){
  const loaded=readOperation(input),preview=await previewPostgresNodeMigration(input),binding=loaded.checked.binding;
  requireWrappingKey(wrappingKey,loaded.operation.wrappingKey.sha256);
  return withPreparedPostgresNodeTransaction(client,loaded.handoffInput,async checked=>{
    await assertCompleteNodes(client,binding,preview.nodes,loaded.manifest.uninitializedEndpoints,false);
    const pins=preview.nodes.map(node=>({nodeId:node.nodeId,agentId:node.agentId,baseUrl:preview.targetBaseUrl,digest:node.targetSnapshotDigest,snapshotVersion:2 as const}));
    return withPostgresOfflineRelayNodeContext(client,reviewFor(binding,checked.operation.adminIdentity.role,loaded.operation.schemaReceiptDigest,checked.operation.businessVerification.sha256,pins),async context=>{
      const nodes=[];for(const pin of pins)nodes.push({nodeId:pin.nodeId,...await postgresRelayNodeDigestInAdminContext(context,{nodeId:pin.nodeId,baseUrl:pin.baseUrl,wrappingKey,expectedAgentId:pin.agentId,expectedSnapshotDigest:pin.digest})});
      return {version:1,status:'nodes-verified-not-started',sourceManifestDigest:loaded.operation.sourceManifest.sha256,nodes,serverAcceptance:'not-observed'};
    });
  },true);
}

/** Persist only metadata returned by the real import and a separate actual
 * readback. A new private directory prevents overwriting an unknown outcome.
 * No private snapshot or key value is copied to these deployable receipts. */
export function writePostgresNodeMigrationEvidence(input:unknown,imported:Awaited<ReturnType<typeof importPostgresNodeMigration>>,verified:Awaited<ReturnType<typeof verifyPostgresNodeMigration>>,directory:string){
  const loaded=readOperation(input),binding=loaded.checked.binding;
  if(!isAbsolute(directory)||imported.sourceManifestDigest!==loaded.operation.sourceManifest.sha256||verified.sourceManifestDigest!==imported.sourceManifestDigest||imported.nodes.length!==loaded.manifest.nodes.length||verified.nodes.length!==loaded.manifest.nodes.length||imported.bindingIdentity!==postgresNodeMigrationBindingIdentity(binding))throw new Error('Actual node import/readback evidence differs from this reviewed operation');
  mkdirSync(directory,{mode:0o700});
  const write=(name:string,value:unknown)=>{const path=join(directory,name),bytes=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value,null,2)+'\n');writeFileSync(path,bytes,{mode:0o600,flag:'wx'});return {path,sha256:createHash('sha256').update(bytes).digest('hex')};};
  const raw=readOwnedBindingFile(loaded.operation.sourceManifest.path,1048576,true);if(createHash('sha256').update(raw).digest('hex')!==loaded.operation.sourceManifest.sha256)throw new Error('Frozen source manifest changed');
  const sourceManifest=write('source-files.json',raw),nodes=[];
  for(const [index,source] of loaded.manifest.nodes.entries()){
    const actual=imported.nodes.find(node=>node.nodeId===source.nodeId),readback=verified.nodes.find(node=>node.nodeId===source.nodeId);
    if(!actual||!readback||readback.agentId!==source.agentId||readback.digest!==actual.repoint.targetSnapshotDigest||digest(readback.counts)!==digest(actual.repoint.counts)||actual.importReceipt.digest!==readback.digest)throw new Error('Independent node row readback differs from its actual import');
    const {nodeId:_node,...plainReadback}=readback;
    nodes.push({nodeId:source.nodeId,agentId:source.agentId,...(source.endpointId?{endpointId:source.endpointId}:{}),sourceSnapshotDigest:source.sourceSnapshotDigest,targetSnapshotDigest:actual.repoint.targetSnapshotDigest,sourceFiles:source.sourceFiles,counts:readback.counts,repointReceipt:write(`node-${index}-repoint.json`,actual.repoint),importReceipt:write(`node-${index}-import.json`,actual.importReceipt),independentReadback:write(`node-${index}-readback.json`,plainReadback)});
  }
  const gateway=nodes.find(node=>!node.endpointId)!,endpoints=nodes.filter(node=>node.endpointId);
  const inventory=postgresRelaySourceInventoryV2Schema.parse({version:2,kind:'eigos.relay-node-source-inventory',sourceAuthority:binding.sourceAuthority,businessSnapshotDigest:binding.business.sourceFileDigest,membershipSnapshotDigest:binding.membership.sourceFileDigest,sourceBaseUrl:loaded.manifest.sourceBaseUrl,targetBaseUrl:loaded.configuration.relayUrl,configurationDigest:loaded.operation.targetConfiguration.sha256,bindingIdentity:postgresNodeMigrationBindingIdentity(binding),sourceManifest,gatewayNode:gateway,endpointImports:endpoints});
  return {version:1,status:'node-evidence-written-not-activated',sourceInventory:write('source-inventory.json',inventory),relayEvidence:{baseUrl:loaded.configuration.relayUrl,configuration:loaded.operation.targetConfiguration,wrappingKey:loaded.operation.wrappingKey,gatewayNode:{nodeId:gateway.nodeId,agentId:gateway.agentId,importDigest:gateway.targetSnapshotDigest},endpointImports:endpoints.map(node=>({endpointId:node.endpointId!,agentId:node.agentId,importDigest:node.targetSnapshotDigest}))},serverAcceptance:'not-observed'};
}

/** Called inside the actual activation transaction after its full original
 * row/schema/ACL checks. No nested transaction, publisher or callback oracle. */
export async function verifyPostgresNodesForActivation(client:Client,binding:PostgresBinding,wrappingKey:CryptoKey,adminRole:string,baseVerificationDigest:string){
  requireWrappingKey(wrappingKey,binding.relay!.wrappingKey.sha256);
  const inventory=readPostgresRelaySourceInventory(binding),baseUrl=binding.relay!.baseUrl;
  const nodes=[inventory.gatewayNode,...inventory.endpointImports].map(node=>({nodeId:node.nodeId,agentId:node.agentId,...('endpointId'in node&&typeof node.endpointId==='string'?{endpointId:node.endpointId}:{}),digest:'targetSnapshotDigest'in node?node.targetSnapshotDigest:node.importDigest,snapshotVersion:(inventory.version===2?2:1) as 1|2}));
  const absent=inventory.version===2?postgresNodeSourceManifestSchema.parse(readPinnedPostgresJson(inventory.sourceManifest,1048576)).uninitializedEndpoints:[];
  await assertCompleteNodes(client,binding,nodes,absent,false);
  return withPostgresOfflineRelayNodeContext(client,reviewFor(binding,adminRole,binding.activation!.runtimeSchemaReceiptDigest,baseVerificationDigest,nodes.map(node=>({...node,baseUrl}))),async context=>{
    for(const node of nodes)await postgresRelayNodeDigestInAdminContext(context,{nodeId:node.nodeId,baseUrl,wrappingKey,expectedAgentId:node.agentId,expectedSnapshotDigest:node.digest});
    return {nodes:nodes.length,serverAcceptance:'not-observed'};
  });
}
