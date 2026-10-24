import { DatabaseSync } from 'node:sqlite';
import { lstatSync, realpathSync } from 'node:fs';
import { digest } from '../core/delegation.js';
import { ownerKey } from '../core/domain.js';
import { businessModel } from '../ontology/business-model.js';
import { BACKEND_VERSION } from '../ontology/execution.js';
import { POLICY_VERSION } from './contracts.js';

type Row = Record<string, unknown>;
const MAX_ROWS = 50_000;
const objectKey = (owner: string, type: string, id: string) => JSON.stringify([owner, type, id]);
const taskKey = (owner: string, id: string) => JSON.stringify([owner, id]);
const positive = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) > 0;
const record = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v);
function body(row: Row): Row | undefined {
  try { const v: unknown = JSON.parse(String(row.body)); return record(v) ? v : undefined; } catch { return; }
}
function count(db: DatabaseSync, table: string): number {
  // All callers use the fixed table names below; never accept table names from a snapshot.
  return Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
}
function requireTables(db: DatabaseSync, tables: Record<string, string[]>) {
  for (const [table, columns] of Object.entries(tables)) {
    const actual = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
    if (columns.some(c => !actual.includes(c))) throw new Error(`Snapshot schema unavailable: ${table}`);
    if (count(db, table) > MAX_ROWS) throw new Error(`Snapshot audit row limit exceeded: ${table}`);
  }
}
function openSnapshot(path: string): DatabaseSync {
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('Snapshot must be an existing regular file');
  const db = new DatabaseSync(path, { readOnly: true });
  try { db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN'); return db; }
  catch { db.close(); throw new Error('Cannot open a stable read-only snapshot'); }
}
function requireBodyBudget(db: DatabaseSync, table: string) {
  if (Number(db.prepare(`SELECT coalesce(sum(length(body)),0) AS n FROM ${table}`).get()!.n) > 64 * 1024 * 1024)
    throw new Error(`Snapshot audit byte limit exceeded: ${table}`);
}

/** Analyze explicit offline snapshots. Never creates a JobStore/MemberStore,
 * grants permissions, changes schema, follows arbitrary graph edges, or prints
 * task text, source payloads, member identity, tokens, or raw object identifiers. */
export function auditMigrationSnapshots(databaseSnapshot: string, membershipSnapshot?: string) {
  if (membershipSnapshot && realpathSync(databaseSnapshot) === realpathSync(membershipSnapshot)) throw new Error('Task and membership snapshots must be separate files');
  const db = openSnapshot(databaseSnapshot); let members: DatabaseSync | undefined;
  try {
    requireTables(db, {
      jobs: ['id', 'owner', 'state', 'body'], ontology_objects: ['owner', 'type', 'id', 'revision', 'definition_digest', 'body'],
      ontology_links: ['owner', 'type', 'from_type', 'from_id', 'to_type', 'to_id', 'definition_digest'],
      requests: ['owner', 'operation', 'request_id', 'response'], plan_grants: ['id', 'owner', 'job_id', 'body'],
      action_intents: ['id', 'owner', 'job_id', 'state', 'body'],
    });
    requireBodyBudget(db, 'jobs'); requireBodyBudget(db, 'ontology_objects');
    const membership = { supplied: !!membershipSnapshot, members: 0, activeMembers: 0, installations: 0, activeInstallations: 0,
      revokedInstallations: 0, unboundInstallations: 0, blockedConnections: 0, invalidRecords: 0 };
    const memberOwners = new Map<string, string>();
    if (membershipSnapshot) {
      members = openSnapshot(membershipSnapshot);
      requireTables(members, { members: ['id', 'issuer', 'tenant', 'subject', 'status'],
        agent_registrations: ['id', 'member_id', 'client_id', 'revoked'], member_connections: ['member_id', 'client_id', 'blocked'] });
      const people = members.prepare('SELECT id,issuer,tenant,subject,status FROM members').all();
      const byId = new Map(people.map(p => [p.id, p]));
      membership.members = people.length;
      for (const p of people) {
        if (![p.id, p.issuer, p.tenant, p.subject].every(v => typeof v === 'string' && v.length > 0)
          || !['active', 'new', 'pending', 'suspended'].includes(String(p.status))) { membership.invalidRecords++; continue; }
        if (p.status === 'active') membership.activeMembers++;
        memberOwners.set(ownerKey({ issuer: String(p.issuer), tenant: String(p.tenant), subject: String(p.subject), clientId: '', scopes: [] }), String(p.status));
      }
      const connections = members.prepare('SELECT member_id,client_id,blocked FROM member_connections').all();
      const blocked = new Set(connections.filter(c => c.blocked === 1).map(c => JSON.stringify([c.member_id, c.client_id])));
      membership.blockedConnections = blocked.size;
      for (const r of members.prepare('SELECT id,member_id,client_id,revoked FROM agent_registrations').all()) {
        membership.installations++;
        if (r.revoked === 1) membership.revokedInstallations++;
        else if (r.member_id === null) membership.unboundInstallations++;
        else if (![0, 1].includes(Number(r.revoked)) || !byId.has(r.member_id) || typeof r.client_id !== 'string' || !r.client_id) membership.invalidRecords++;
        else if (byId.get(r.member_id)?.status === 'active' && !blocked.has(JSON.stringify([r.member_id, r.client_id]))) membership.activeInstallations++;
      }
    }
    const jobRows = db.prepare('SELECT id,owner,state,CASE WHEN length(body)<=1000000 THEN body ELSE NULL END AS body FROM jobs ORDER BY owner,id').all();
    const jobs = new Map<string, { revision: number; current: boolean }>();
    const taskItems = jobRows.map(row => {
      const value = body(row), delegation = value?.delegation, request = record(delegation) ? delegation.request : undefined;
      const valid = !!value && value.id === row.id && value.state === row.state
        && ['submitted', 'auth-required', 'rejected', 'working', 'input-required', 'completed', 'canceled', 'failed'].includes(String(row.state))
        && record(request) && request.id === row.id && positive(request.revision);
      const current = valid && record(delegation) && delegation.backendVersion === BACKEND_VERSION;
      if (valid) jobs.set(taskKey(String(row.owner), String(row.id)), { revision: request.revision as number, current });
      // Current installations cannot prove which installation submitted a legacy task.
      return { recordDigest: digest(['task', row.owner, row.id]),
        disposition: !valid ? 'unrecognized_task_contract' : current ? 'requires_new_installation_grant' : 'legacy_read_only',
        membership: !membershipSnapshot ? 'not_checked' : memberOwners.get(String(row.owner)) === 'active' ? 'active' : 'unmapped_or_inactive',
        hasArtifact: !!value?.artifact, hasModelHistory: !!(Array.isArray(value?.runs) && value.runs.length),
        inferredInstallation: false, proposedGrant: false };
    });
    const rows = db.prepare('SELECT owner,type,id,revision,definition_digest,CASE WHEN length(body)<=1000000 THEN body ELSE NULL END AS body FROM ontology_objects ORDER BY owner,type,id').all();
    const objects = new Map<string, { row: Row; value: Row; properties: Row }>();
    const invalid = new Map<string, string>();
    for (const row of rows) {
      const key = objectKey(String(row.owner), String(row.type), String(row.id)), value = body(row);
      try {
        const definition = businessModel.object(String(row.type));
        if (row.definition_digest !== businessModel.fingerprint(String(row.type))) { invalid.set(key, 'definition_mismatch'); continue; }
        if (!value || !record(value.properties) || !positive(row.revision)) { invalid.set(key, 'invalid_object'); continue; }
        const properties = businessModel.parseProperties(String(row.type), value.properties);
        if (properties[definition.primaryKey] !== row.id) { invalid.set(key, 'identity_mismatch'); continue; }
        objects.set(key, { row, value, properties });
      } catch { invalid.set(key, 'unknown_type_or_invalid_properties'); }
    }
    const roots = new Map<string, Set<string>>(), linkReview: Record<string, number> = {};
    const reviewLink = (reason: string) => { linkReview[reason] = (linkReview[reason] ?? 0) + 1; };
    for (const row of db.prepare('SELECT owner,type,from_type,from_id,to_type,to_id,definition_digest FROM ontology_links').all()) {
      try {
        const l = businessModel.link(String(row.type));
        if (row.definition_digest !== digest(l)) { reviewLink('definition_mismatch'); continue; }
        if (!businessModel.implements(String(row.from_type), l.from.type) || !businessModel.implements(String(row.to_type), l.to.type)) { reviewLink('endpoint_type_mismatch'); continue; }
        const a = objectKey(String(row.owner), String(row.from_type), String(row.from_id)), b = objectKey(String(row.owner), String(row.to_type), String(row.to_id));
        if (!objects.has(a) || !objects.has(b)) { reviewLink('endpoint_not_currently_validated'); continue; }
        if (row.from_type !== 'ServiceRequest' && row.to_type !== 'ServiceRequest') continue;
        const root = row.from_type === 'ServiceRequest' ? a : b, target = root === a ? b : a;
        const found = roots.get(target) ?? new Set<string>(); found.add(root); roots.set(target, found);
      } catch { reviewLink('unknown_link_definition'); }
    }
    const objectItems = rows.map(row => {
      const key = objectKey(String(row.owner), String(row.type), String(row.id));
      const found = objects.get(key), candidates = row.type === 'ServiceRequest' ? [key] : [...roots.get(key) ?? []];
      let disposition = invalid.get(key) ?? 'unmapped_requires_explicit_binding';
      if (found && candidates.length) {
        const valid = candidates.every(k => {
          const root = objects.get(k)!, job = jobs.get(taskKey(String(row.owner), String(root.row.id)));
          const revision = found.properties.requestRevision;
          return job?.current && root.properties.revision === job.revision && (revision === undefined || revision === job.revision);
        });
        disposition = !valid ? 'stale_or_missing_task_evidence' : candidates.length > 1 ? 'multiple_tasks_require_review' : 'candidate_requires_evidence_review';
      }
      return { recordDigest: digest(['object', row.owner, row.type, row.id]), type: businessModel.hasType(String(row.type)) ? String(row.type) : 'unregistered',
        disposition, directTaskCandidates: candidates.length, proposedGrant: false };
    });
    const tally = (items: { disposition: string }[]) => items.reduce<Record<string, number>>((out, v) => { out[v.disposition] = (out[v.disposition] ?? 0) + 1; return out; }, {});
    return { stage: 'S0', version: POLICY_VERSION, mode: 'read_only_snapshot_audit', writes: 0, permissionsGranted: 0,
      migrationReady: false, sourceProvenanceVerified: false, crossDatabaseAtomicSnapshot: false,
      membership, tasks: { total: taskItems.length, dispositions: tally(taskItems), items: taskItems },
      objects: { total: objectItems.length, dispositions: tally(objectItems), items: objectItems },
      links: { total: count(db, 'ontology_links'), requiresReview: Object.values(linkReview).reduce((a, b) => a + b, 0), reasons: linkReview },
      existingPlanGrants: count(db, 'plan_grants'),
      outputReview: { cachedResponses: count(db, 'requests'), artifacts: taskItems.filter(t => t.hasArtifact).length, modelHistories: taskItems.filter(t => t.hasModelHistory).length,
        actionIntents: count(db, 'action_intents'), policy: 'private_until_reprojected', filesystemArtifactsScanned: false },
      requiredNextSteps: ['review_candidate_source_evidence', 'bind_installation_explicitly', 'issue_scoped_grants_after_approval', 'reproject_outputs', 'enforce_before_cutover'],
    };
  } finally {
    members?.close(); db.close();
  }
}
