import type { Client } from 'pg';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError, taskIdSchema } from '../core/domain.js';
import { ontologyIdSchema, ontologyReleaseRefSchema, parseOntologyDocument, type OntologyReleaseRef } from '../ontology/definition-contracts.js';
import { compatibleDefinitionModels } from '../ontology/definition-compatibility.js';
import type { DefinitionCompatibilityInput } from '../ontology/definition-store.js';
import { BACKEND_VERSION } from '../ontology/execution.js';
import { compileOntologyDocument, type TrustedDefinitionRegistry } from '../ontology/model-compiler.js';
import { createCurrentKernelDefinition, createSeedDefinition, stagedKernelComponents, type StagedKernelBuilder } from '../ontology/seed-definition.js';
import { validateTaskReadProjection } from '../ontology/task-read-proof.js';
import type { Job } from '../core/domain.js';
import { postgresBusinessSchema,postgresBusinessToken,postgresBusinessKernel } from './runtime-transaction.js';

let registry: TrustedDefinitionRegistry | undefined;
function trustedRegistry(): TrustedDefinitionRegistry {
  if (!registry) {
    const seed = createSeedDefinition();
    createCurrentKernelDefinition(seed.registry);
    registry = seed.registry;
  }
  return registry;
}
function conflict(message: string): never { throw new DomainError('CONFLICT', message); }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Namespace visibility only. `admin` must be derived from an authenticated
 * principal, never request input. Task grants, installation and field-level
 * output checks remain the caller's responsibility in the same transaction. */
export async function postgresAssertOntologyAccess(client: Client, owner: string, ontologyId: string, admin = false): Promise<void> {
  const schema = postgresBusinessSchema(client), id = ontologyIdSchema.parse(ontologyId);
  if (typeof owner !== 'string' || typeof admin !== 'boolean') throw new Error('Invalid ontology access context');
  const result = await client.query(`SELECT n.owner FROM "${schema}".ontology_namespaces n JOIN "${schema}".ontology_definition_releases r ON r.id=n.active_release_id WHERE n.id=$1`, [id]);
  if (result.rowCount !== 1) throw new DomainError('NOT_FOUND', 'Ontology is not available');
  if (result.rows[0].owner !== null && result.rows[0].owner !== owner && !admin) throw new DomainError('FORBIDDEN', 'Ontology belongs to another owner');
}

/** Resolve an existing historical read witness, not an execution pin or a
 * task/field authorization. The caller must check those permissions in the
 * same fenced transaction. The database still parses the full task JSON.
 * Oversized proof inputs fail closed until streaming canonicalization exists. */
export async function postgresProjectedTaskOntologyRelease(client: Client, owner: string, taskId: string, builder?: StagedKernelBuilder) {
  const schema = postgresBusinessSchema(client), q = `"${schema}"`;
  if (!owner || !taskId) return conflict('Invalid task identity');
  const result = await client.query(`SELECT p.task_id AS proof_id,
    CASE WHEN octet_length(p.body)<=65536 THEN p.body END AS proof,
    CASE WHEN octet_length(p.digest)=64 THEN p.digest END AS digest
    FROM ${q}.jobs j LEFT JOIN ${q}.ontology_task_read_projections p ON p.owner=j.owner AND p.task_id=j.id
    WHERE j.owner=$1 AND j.id=$2`, [owner,taskId]);
  if (result.rowCount !== 1) throw new DomainError('NOT_FOUND', 'Task not found');
  const row = result.rows[0];
  if (row.proof_id === null) return undefined;
  if (row.proof === null || row.digest === null) return conflict('Historical proof exceeds safe runtime limits');
  const source = await client.query(`SELECT CASE WHEN octet_length(minimal.value::text)<=8388608 THEN minimal.value::text END AS task_body
    FROM ${q}.jobs j
    CROSS JOIN LATERAL (SELECT ${q}.eigos_try_jsonb(j.body) AS value OFFSET 0) body
    CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(body.value)='object' THEN jsonb_build_object(
      'id',body.value->'id',
      'delegation',jsonb_build_object('backendVersion',body.value#>'{delegation,backendVersion}', 'ontologyRelease',body.value#>'{delegation,ontologyRelease}')
        || CASE WHEN body.value#>'{delegation,request}' IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('request',body.value#>'{delegation,request}') END,
      'artifact',body.value->'artifact') END AS value OFFSET 0) minimal
    WHERE j.owner=$1 AND j.id=$2`,[owner,taskId]);
  if (source.rowCount !== 1 || source.rows[0].task_body === null) return conflict('Historical task proof inputs are invalid or exceed safe runtime limits');
  const job = JSON.parse(String(source.rows[0].task_body)) as Job;
  if (job.id !== taskId) return conflict('Stored task identity is invalid');
  const ref = validateTaskReadProjection(owner,job,String(row.proof),String(row.digest));
  return postgresOntologyRelease(client,ref,builder);
}

const readContextSchema = z.strictObject({ ontologyId: ontologyIdSchema.optional(), release: ontologyReleaseRefSchema.optional(), taskId: taskIdSchema.optional() });

/** Match the existing ontology read context without granting task access.
 * The caller must derive owner/admin from the authenticated principal and
 * enforce the task grant and field policy inside the same transaction. */
export async function postgresOntologyReadContext(client: Client, owner: string, input: unknown = {}, admin = false, builder?: StagedKernelBuilder) {
  const schema = postgresBusinessSchema(client), context = readContextSchema.parse(input), q = `"${schema}"`;
  if (context.taskId && (context.ontologyId || context.release)) throw new DomainError('INVALID_INPUT', 'Task reads already have an immutable ontology release');
  if (context.ontologyId && context.release && context.ontologyId !== context.release.ontologyId) throw new DomainError('INVALID_INPUT', 'Ontology namespace and release differ');
  let release;
  if (context.taskId) {
    release = await postgresProjectedTaskOntologyRelease(client,owner,context.taskId,builder);
    if (!release) {
      const result = await client.query(`SELECT jsonb_typeof(body.value) AS kind,
        CASE WHEN body.value#>'{delegation,ontologyRelease}' IS NULL OR body.value#>'{delegation,ontologyRelease}'='null'::jsonb THEN 'absent'
          WHEN octet_length((body.value#>'{delegation,ontologyRelease}')::text)<=1024 THEN 'present' ELSE 'invalid' END AS ref_state,
        CASE WHEN octet_length((body.value#>'{delegation,ontologyRelease}')::text)<=1024 THEN (body.value#>'{delegation,ontologyRelease}')::text END AS ref
        FROM ${q}.jobs j CROSS JOIN LATERAL (SELECT ${q}.eigos_try_jsonb(j.body) AS value OFFSET 0) body WHERE j.owner=$1 AND j.id=$2`,[owner,context.taskId]);
      if (result.rowCount !== 1) throw new DomainError('NOT_FOUND','Task not found');
      const row = result.rows[0];
      if (row.kind !== 'object' || row.ref_state === 'invalid') return conflict('Stored ontology reference is invalid');
      if (row.ref_state === 'absent') release = await postgresTaskOntologyRelease(client,owner,context.taskId,builder);
      else {
        const ref = ontologyReleaseRefSchema.parse(JSON.parse(String(row.ref)));
        await postgresAssertOntologyAccess(client,owner,ref.ontologyId,admin);
        release = await postgresOntologyRelease(client,ref,builder);
      }
    }
  } else if (context.release) {
    await postgresAssertOntologyAccess(client,owner,context.release.ontologyId,admin);
    release = await postgresOntologyRelease(client,context.release,builder);
  }
  else {
    const id = context.ontologyId ?? 'eigos.business';
    const row = (await client.query(`SELECT n.active_release_id,r.digest FROM ${q}.ontology_namespaces n JOIN ${q}.ontology_definition_releases r ON r.id=n.active_release_id WHERE n.id=$1`,[id])).rows[0];
    if (!row) throw new DomainError('NOT_FOUND','Ontology is not available');
    await postgresAssertOntologyAccess(client,owner,id,admin);
    release = await postgresOntologyRelease(client,ontologyReleaseRefSchema.parse({ontologyId:id,releaseId:row.active_release_id,digest:row.digest}),builder);
  }
  await postgresAssertOntologyAccess(client,owner,release.ref.ontologyId,admin);
  return release;
}

type ResolvedRelease=Awaited<ReturnType<typeof resolveOntologyRelease>>;
const releaseSnapshots=new WeakMap<object,{bytes:number;entries:{key:string;kernel:StagedKernelBuilder|undefined;value:ResolvedRelease;bytes:number}[]}>();
type ReleaseContent = {
  document: ReturnType<typeof parseOntologyDocument>;
  documentDigest: string;
  model: ReturnType<typeof compileOntologyDocument>;
  bytes: number;
};
const releaseContents = new WeakMap<TrustedDefinitionRegistry, { bytes: number; entries: Map<string, ReleaseContent> }>();
function contentCache(registry: TrustedDefinitionRegistry) {
  let cache = releaseContents.get(registry);
  if (!cache) {
    cache = { bytes: 0, entries: new Map() };
    releaseContents.set(registry, cache);
  }
  return cache;
}

/** Explicit host-only reading scope. Ordinary administration and writer paths
 * keep resolving rows freshly; no cache survives this callback. */
export async function withPostgresOntologyReleaseSnapshot<T>(client:Client,action:()=>Promise<T>):Promise<T>{
  const token=postgresBusinessToken(client);
  if(releaseSnapshots.has(token))throw new Error('Nested immutable release snapshots are not supported');
  releaseSnapshots.set(token,{bytes:0,entries:[]});
  try{
    const value=await action();
    if(postgresBusinessToken(client)!==token)throw new Error('The exact active PostgreSQL business transaction is required');
    return value;
  }finally{releaseSnapshots.delete(token);}
}

/** Immutable release content only, bounded to this exact transaction and trusted
 * compiler. Namespace visibility, grants, roles and current leases are never
 * cached here. Published rows and aliases have immutable-history guards. */
export async function postgresOntologyRelease(client:Client,input:OntologyReleaseRef,builder?:StagedKernelBuilder):Promise<ResolvedRelease>{
  const token=postgresBusinessToken(client),ref=ontologyReleaseRefSchema.parse(input),key=digest(ref);
  const kernel=builder===undefined?postgresBusinessKernel(client,token):builder;
  if(kernel!==undefined)stagedKernelComponents(kernel);
  const snapshot=releaseSnapshots.get(token),cached=snapshot?.entries.find(entry=>entry.key===key&&entry.kernel===kernel);
  if(cached)return cached.value;
  const value=await resolveOntologyRelease(client,ref,kernel);
  if(postgresBusinessToken(client)!==token)throw new Error('The exact active PostgreSQL business transaction is required');
  if(snapshot){
    if(releaseSnapshots.get(token)!==snapshot)throw new Error('Immutable release reading scope has closed');
    const bytes=Buffer.byteLength(JSON.stringify(value.document));
    if(bytes<=8388608){
      while(snapshot.entries.length>=8||snapshot.bytes+bytes>8388608)snapshot.bytes-=snapshot.entries.shift()!.bytes;
      snapshot.entries.push({key,kernel,value,bytes});snapshot.bytes+=bytes;
    }
  }
  return value;
}

/** Resolve an exact persisted release using the same trusted compiler as the
 * SQLite authority. The caller owns namespace and task/source authorization. */
async function resolveOntologyRelease(client: Client, input: OntologyReleaseRef, builder?: StagedKernelBuilder) {
  const schema = postgresBusinessSchema(client), ref = ontologyReleaseRefSchema.parse(input), q = `"${schema}"`;
  const kernel=builder===undefined?postgresBusinessKernel(client,postgresBusinessToken(client)):builder;
  const staged = kernel === undefined ? undefined : stagedKernelComponents(kernel);
  const registry = staged?.registry ?? trustedRegistry(), cache = contentCache(registry);
  const offered = new Map(cache.entries);
  const values = [ref.releaseId, ref.ontologyId, ref.digest, [...offered.keys()]];
  // The database hashes the actual stored bytes on every lookup. A cache hit
  // avoids transferring/parsing the document while still detecting corruption,
  // deletion, alias changes and a changed stored model fingerprint.
  const project = (selection: string) => `SELECT
    CASE WHEN content_digest=ANY($4::text[]) THEN NULL ELSE body END AS body,
    model_digest,created_at,sequence,content_digest
    FROM (SELECT selected.*,pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(body,'UTF8')),'hex') AS content_digest
      FROM (${selection}) selected OFFSET 0) verified`;
  let result = await client.query(project(`SELECT body,model_digest,created_at,sequence FROM ${q}.ontology_definition_releases WHERE id=$1 AND ontology_id=$2 AND digest=$3`), values);
  if (!result.rowCount) result = await client.query(project(`SELECT r.body,r.model_digest,r.created_at,r.sequence FROM ${q}.ontology_definition_release_aliases a JOIN ${q}.ontology_definition_releases r ON r.id=a.canonical_id AND r.ontology_id=a.ontology_id AND r.digest=a.digest WHERE a.alias_id=$1 AND a.ontology_id=$2 AND a.digest=$3`), values);
  if (result.rowCount !== 1) return conflict('The exact ontology release is unavailable');
  const row = result.rows[0];
  if (typeof row.content_digest !== 'string' || !/^[a-f0-9]{64}$/.test(row.content_digest)) return conflict('Stored ontology content fingerprint is invalid');
  // Keep the offered entries alive until the query returns, even when another
  // request evicts one from the shared LRU while this connection is waiting.
  let content = cache.entries.get(row.content_digest) ?? offered.get(row.content_digest);
  if (!content) {
    if (typeof row.body !== 'string' || createHash('sha256').update(row.body).digest('hex') !== row.content_digest) return conflict('Stored ontology release bytes changed');
    let document;
    try { document = parseOntologyDocument(JSON.parse(row.body)); }
    catch { return conflict('Stored ontology release is invalid'); }
    const documentDigest = digest(document);
    if (document.id !== ref.ontologyId || documentDigest !== ref.digest) return conflict('Stored ontology release digest is invalid');
    const model = staged && documentDigest === staged.documentDigest ? staged.model : compileOntologyDocument(document, registry);
    content = { document: freeze(document), documentDigest, model, bytes: Buffer.byteLength(row.body) };
  }
  const { document, documentDigest, model } = content;
  if (document.id !== ref.ontologyId || documentDigest !== ref.digest) return conflict('Stored ontology release digest is invalid');
  if (model.ref.digest !== row.model_digest) return conflict('Ontology compiler or trusted handler contract changed');
  const sequence = Number(row.sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 1 || typeof row.created_at !== 'string') return conflict('Stored ontology release metadata is invalid');
  if (content.bytes <= 16777216) {
    if (cache.entries.delete(row.content_digest)) cache.bytes -= content.bytes;
    while (cache.entries.size >= 8 || cache.bytes + content.bytes > 16777216) {
      const oldest = cache.entries.keys().next().value!;
      cache.bytes -= cache.entries.get(oldest)!.bytes;
      cache.entries.delete(oldest);
    }
    cache.entries.set(row.content_digest, content);
    cache.bytes += content.bytes;
  }
  return Object.freeze({ ref: freeze(ref), document: freeze(document), model, sequence, createdAt: row.created_at });
}

/** Resolve the release pinned to an owned task, including the explicit legacy
 * bootstrap reference. It does not grant access or validate a Worker claim. */
export async function postgresTaskOntologyRelease(client: Client, owner: string, taskId: string, builder?: StagedKernelBuilder) {
  const schema = postgresBusinessSchema(client), q = `"${schema}"`;
  if (!owner || !taskId) return conflict('Invalid task identity');
  const result = await client.query(`SELECT a.id AS authority_id,
    CASE WHEN jsonb_typeof(body.value->'authorityId')='string' AND octet_length(body.value->>'authorityId') <= 256 THEN body.value->>'authorityId' END AS task_authority,
    CASE WHEN jsonb_typeof(body.value#>'{delegation,backendVersion}')='string' AND octet_length(body.value#>>'{delegation,backendVersion}') <= 256 THEN body.value#>>'{delegation,backendVersion}' END AS backend_version,
    CASE WHEN body.value#>'{delegation,ontologyRelease}' IS NULL OR body.value#>'{delegation,ontologyRelease}' = 'null'::jsonb THEN 'absent'
         WHEN octet_length((body.value#>'{delegation,ontologyRelease}')::text) <= 1024 THEN 'present' ELSE 'invalid' END AS ref_state,
    CASE WHEN octet_length((body.value#>'{delegation,ontologyRelease}')::text) <= 1024 THEN (body.value#>'{delegation,ontologyRelease}')::text END AS ref
    FROM ${q}.jobs j CROSS JOIN ${q}.eigos_current_runtime_authority() a
    CROSS JOIN LATERAL (SELECT ${q}.eigos_try_jsonb(j.body) AS value OFFSET 0) body
    WHERE j.owner=$1 AND j.id=$2`, [owner,taskId]);
  if (result.rowCount !== 1) throw new DomainError('NOT_FOUND', 'Task not found');
  const row = result.rows[0];
  if (row.backend_version !== BACKEND_VERSION) return conflict('Historical backend tasks have no current executable ontology context');
  if (row.task_authority !== row.authority_id) return conflict('Historical runtime authority tasks are read-only');
  let ref: unknown;
  if (row.ref_state === 'absent') {
    const bootstrap = await client.query(`SELECT CASE WHEN octet_length(legacy_ref) <= 1024 THEN legacy_ref END AS legacy_ref FROM ${q}.ontology_definition_bootstrap WHERE id=1`);
    if (bootstrap.rowCount !== 1) return conflict('Ontology definitions have not been initialized');
    try { ref = JSON.parse(String(bootstrap.rows[0].legacy_ref)); }
    catch { return conflict('Stored legacy ontology reference is invalid'); }
  } else {
    if (row.ref_state !== 'present') return conflict('Stored ontology reference is invalid');
    try { ref = JSON.parse(String(row.ref)); }
    catch { return conflict('Stored ontology reference is invalid'); }
  }
  return postgresOntologyRelease(client, ontologyReleaseRefSchema.parse(ref),builder);
}

/** Compare a stored fact's historical definition against its pinned target.
 * Callers must still enforce the task's object-level and field permissions. */
export async function postgresOntologyDefinitionCompatible(client: Client, targetRef: OntologyReleaseRef, supplied: DefinitionCompatibilityInput, builder?: StagedKernelBuilder): Promise<boolean> {
  const schema = postgresBusinessSchema(client), ref = ontologyReleaseRefSchema.parse(targetRef), input = structuredClone(supplied), q = `"${schema}"`;
  const result = await client.query(`SELECT f.release_id,r.digest FROM ${q}.ontology_definition_fingerprints f JOIN ${q}.ontology_definition_releases r ON r.id=f.release_id WHERE f.ontology_id=$1 AND f.kind=$2 AND f.api_name=$3 AND f.fingerprint=$4`, [ref.ontologyId,input.kind,input.id,input.storedDigest]);
  if (result.rowCount !== 1) return false;
  const originalRef = ontologyReleaseRefSchema.safeParse({ ontologyId: ref.ontologyId, releaseId: result.rows[0].release_id, digest: result.rows[0].digest });
  if (!originalRef.success) return false;
  try {
    const target = await postgresOntologyRelease(client, ref,builder), original = await postgresOntologyRelease(client, originalRef.data,builder);
    return compatibleDefinitionModels(original.model, target.model, input);
  } catch (error) {
    if (error instanceof DomainError) return false;
    throw error;
  }
}
