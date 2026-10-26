import { businessModel } from '../ontology/business-model.js';
import type { OntologyModel } from '../ontology/model.js';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError, ownerKey, type Principal } from '../core/domain.js';
import { digest } from '../core/delegation.js';
import { claimAuthorityCurrent } from '../core/runtime-authority.js';
import { agentAccessGrantSchema, taskDataGrantSchema, taskExecutionAuthoritySchema, securityDefaults, accessContextSchema, POLICY_VERSION, SECURITY_CONTRACT, type AccessContext } from './contracts.js';
import { SecurityPolicies } from './policy-store.js';
import { withAuthorization, type AuthorizationScope } from './context.js';
import {RecoveryStore} from './recovery.js';
import {businessTransaction,hasTransaction} from '../core/transaction.js';

export type SecurityMode = 'legacy' | 'foundation';
export type AgentAccessGrant = z.infer<typeof agentAccessGrantSchema>;
export type TaskDataGrant = z.infer<typeof taskDataGrantSchema>;
export type TaskAuthority = z.infer<typeof taskExecutionAuthoritySchema>;
export interface SubjectFacts { ownerKey: string; memberId: string; installationId: string; clientId: string; active: boolean }
export interface Subject extends SubjectFacts { epoch: number; validUntil: number }
export interface Fence { ownerKey: string; kind: 'member' | 'connection' | 'installation'; targetId: string; revision: number; state: 'pending' | 'applied' | 'cleared' }
export class SecurityError extends DomainError {
  constructor(readonly reason: 'AUTHORIZATION_REQUIRED' | 'ACCESS_REVOKED' | 'AUTHORITY_UNAVAILABLE' | 'REVOCATION_PENDING' | 'POLICY_CHANGED' | 'SOURCE_NOT_AUTHORIZED' | 'OUTPUT_NOT_ALLOWED' | 'INSUFFICIENT_ACCESS', message: string = reason) { super('FORBIDDEN', message); }
}
type Row = Record<string, unknown>;
const subject = (r: Row): Subject => ({ ownerKey: String(r.owner), memberId: String(r.member_id), installationId: String(r.installation_id), clientId: String(r.client_id), active: r.state === 'active', epoch: Number(r.epoch), validUntil: Number(r.valid_until) });
const fenceKey = (f: Pick<Fence, 'ownerKey' | 'kind' | 'targetId'>) => digest([f.ownerKey, f.kind, f.targetId]);
const grant = (r: Row) => ({ ...JSON.parse(String(r.body)), revision: Number(r.revision), status: String(r.state) });
const authorityQuery = `FROM security_task_authorities a
 JOIN jobs j ON j.id=a.task_id AND j.owner=a.owner
 JOIN security_subjects s ON s.installation_id=a.installation_id AND s.owner=a.owner AND s.member_id=a.member_id
 JOIN security_grants g ON g.id=a.agent_grant_id AND g.owner=a.owner AND g.installation_id=a.installation_id AND g.kind='agent_access'
 JOIN security_grants d ON d.id=a.data_grant_id AND d.owner=a.owner AND d.installation_id=a.installation_id AND d.kind='task_data' AND d.parent_id=g.id AND d.parent_revision=g.revision
 JOIN security_manager m ON m.slot=1
 JOIN security_settings cfg ON cfg.slot=1 AND cfg.version=2 AND cfg.mode='foundation'
 JOIN security_policy pol ON pol.slot=1 AND pol.revision>0
 JOIN security_policy_definitions pd ON pd.slot=1 AND pd.digest=:securityDefinition
 WHERE a.state='active' AND s.state='active' AND g.state='active' AND d.state='active'
 AND s.epoch=a.auth_epoch AND g.revision=a.agent_grant_revision AND d.revision=a.data_grant_revision
 AND a.request_revision=json_extract(j.body,'$.delegation.request.revision')
 AND json_extract(d.body,'$.purpose')='delegated_task'
 AND a.expires_at>:securityNow AND s.valid_until>:securityNow AND g.expires_at>:securityNow AND d.expires_at>:securityNow AND m.expires_at>:securityNow`;

/** Uses the JobStore connection. Membership/token/profile data stay in their
 * separate database. This store never derives grants from an OAuth scope. */
export class SecurityStore {
  private sequence = 0;
  private atomicDepth = 0;
  get inTransaction() { return this.atomicDepth > 0; }
  readonly enabled: boolean;
  readonly policies: SecurityPolicies;
  readonly recoveries: RecoveryStore;
  constructor(private db: DatabaseSync, mode: SecurityMode = 'legacy', readonly now: () => number = Date.now,readOnly=false, readonly model: OntologyModel = businessModel) {
    const version=mode==='foundation'?2:1;
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='security_settings'").get();
    const orphanedSecurity = !table && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('security_subjects','security_grants','security_task_authorities') LIMIT 1").get();
    const existing = table ? db.prepare('SELECT version,mode FROM security_settings WHERE slot=1').get() : undefined;
    if(readOnly && (!existing || mode!=='foundation'))throw new Error('A read-only security reader requires an existing foundation database');
    if (orphanedSecurity || table && !existing) throw new Error('Security database configuration is missing; no automatic fallback');
    if (existing && (existing.version !== version || existing.mode !== mode)) throw new Error('Security database mode/version mismatch; no automatic downgrade or cutover');
    if(existing && mode==='foundation')for(const name of ['security_manager','security_subjects','security_fences','security_grants','security_task_authorities','security_events']) {
      if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))throw new Error('Security authority table is missing; explicit recovery is required');
    }
    if (!existing && mode === 'foundation' && Number(db.prepare('SELECT count(*) AS n FROM jobs').get()!.n) > 0) throw new Error('Existing tasks require an explicit offline security migration');
    this.enabled = mode === 'foundation';
    if(!readOnly)this.atomic(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS security_settings(slot INTEGER PRIMARY KEY CHECK(slot=1),version INTEGER NOT NULL,mode TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS security_manager(slot INTEGER PRIMARY KEY CHECK(slot=1),token TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS security_subjects(installation_id TEXT PRIMARY KEY,owner TEXT NOT NULL,member_id TEXT NOT NULL,client_id TEXT NOT NULL,epoch INTEGER NOT NULL,state TEXT NOT NULL,valid_until INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS security_subject_owner ON security_subjects(owner,client_id);
      CREATE TABLE IF NOT EXISTS security_fences(id TEXT PRIMARY KEY,owner TEXT NOT NULL,kind TEXT NOT NULL,target_id TEXT NOT NULL,revision INTEGER NOT NULL,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS security_grants(id TEXT PRIMARY KEY,kind TEXT NOT NULL,owner TEXT NOT NULL,member_id TEXT NOT NULL,installation_id TEXT NOT NULL,parent_id TEXT,parent_revision INTEGER,revision INTEGER NOT NULL,state TEXT NOT NULL,expires_at INTEGER NOT NULL,body TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS security_active_agent_grant ON security_grants(installation_id) WHERE kind='agent_access' AND state='active';
      CREATE TABLE IF NOT EXISTS security_task_authorities(id TEXT PRIMARY KEY,owner TEXT NOT NULL,member_id TEXT NOT NULL,installation_id TEXT NOT NULL,task_id TEXT NOT NULL,request_revision INTEGER NOT NULL,agent_grant_id TEXT NOT NULL,agent_grant_revision INTEGER NOT NULL,data_grant_id TEXT NOT NULL,data_grant_revision INTEGER NOT NULL,auth_epoch INTEGER NOT NULL,state TEXT NOT NULL,expires_at INTEGER NOT NULL,body TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS security_active_task_authority ON security_task_authorities(task_id) WHERE state='active';
      CREATE TABLE IF NOT EXISTS security_events(id TEXT PRIMARY KEY,at INTEGER NOT NULL,kind TEXT NOT NULL,subject_digest TEXT NOT NULL,revision INTEGER NOT NULL);`);
      db.prepare('INSERT OR IGNORE INTO security_settings VALUES(1,?,?)').run(version,mode);
      if (db.prepare('SELECT mode FROM security_settings WHERE slot=1').get()?.mode !== mode) throw new Error('Security mode changed concurrently');
    });
    this.policies = new SecurityPolicies(db, this,readOnly);
    this.recoveries = new RecoveryStore(db,this,readOnly);
  }
  atomic<T>(fn: () => T): T {
    // A top-level deferred SAVEPOINT can lose its read snapshot to another WAL
    // writer before it writes. Reserve the writer first; nested calls still use
    // savepoints inside their caller's transaction and roll back with it.
    if (!this.atomicDepth && !hasTransaction(this.db)) return businessTransaction(this.db, () => this.atomic(fn));
    const name = `security_${++this.sequence}`;
    this.db.exec(`SAVEPOINT ${name}`);
    this.atomicDepth++;
    try { const result = fn(); this.db.exec(`RELEASE ${name}`); return result; }
    catch (error) { this.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
    finally { this.atomicDepth--; }
  }
  private event(kind: string, ref: unknown, revision: number) { this.db.prepare('INSERT INTO security_events VALUES(?,?,?,?,?)').run(randomUUID(), this.now(), kind, digest(ref), revision); }
  acquireManager(): string {
    if (!this.enabled) throw new Error('Security foundation is disabled');
    return this.atomic(() => {
      const row = this.db.prepare('SELECT expires_at FROM security_manager WHERE slot=1').get();
      if (row && Number(row.expires_at) > this.now()) throw new SecurityError('AUTHORITY_UNAVAILABLE', 'Another authorization Gateway is active');
      const token = randomUUID(); this.db.prepare('INSERT INTO security_manager VALUES(1,?,?) ON CONFLICT(slot) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at').run(token, this.now() + securityDefaults.authorityProjectionLeaseSeconds * 1000);
      return token;
    });
  }
  renewManager(token: string): boolean {
    return this.db.prepare('UPDATE security_manager SET expires_at=? WHERE slot=1 AND token=? AND expires_at>?').run(this.now() + securityDefaults.authorityProjectionLeaseSeconds * 1000, token, this.now()).changes === 1;
  }
  releaseManager(token: string) { this.db.prepare('UPDATE security_manager SET expires_at=0 WHERE slot=1 AND token=?').run(token); }
  managerCurrent(token: string): boolean {
    try { this.requireManager(token); return true; } catch { return false; }
  }
  private requireManager(token?: string) {
    this.policies.revision();
    const row = this.db.prepare("SELECT m.token,m.expires_at FROM security_manager m JOIN security_settings c ON c.slot=m.slot WHERE m.slot=1 AND c.version=2 AND c.mode='foundation'").get();
    if (!this.enabled || !row || Number(row.expires_at) <= this.now() || token !== undefined && row.token !== token) throw new SecurityError('AUTHORITY_UNAVAILABLE');
  }
  subjects(): Subject[] { return this.db.prepare('SELECT * FROM security_subjects ORDER BY installation_id').all().map(subject); }
  getSubject(installationId: string): Subject | undefined { const row = this.db.prepare('SELECT * FROM security_subjects WHERE installation_id=?').get(installationId); return row ? subject(row) : undefined; }
  private fenced(f: SubjectFacts): boolean {
    return !!this.db.prepare("SELECT 1 FROM security_fences WHERE owner=? AND state<>'cleared' AND ((kind='member' AND target_id=?) OR (kind='connection' AND target_id=?) OR (kind='installation' AND target_id=?)) LIMIT 1").get(f.ownerKey, f.memberId, f.clientId, f.installationId);
  }
  authenticateSubject(f:SubjectFacts,managerToken:string):Subject {
    this.requireManager(managerToken);
    const current=this.getSubject(f.installationId);
    if(current && (current.ownerKey!==f.ownerKey || current.memberId!==f.memberId || current.clientId!==f.clientId))throw new SecurityError('POLICY_CHANGED');
    // Authentication already re-read membership and token facts. An unchanged,
    // live subject needs no write while a Worker publishes its task result.
    if(f.active && current?.active && current.validUntil>this.now() && !this.fenced(f))return this.requireSubject(f.installationId,current.epoch);
    return this.publishSubject(f,managerToken);
  }
  publishSubject(f: SubjectFacts, managerToken: string): Subject {
    return this.atomic(() => {
      this.requireManager(managerToken);
      const old = this.getSubject(f.installationId);
      if (old && (old.ownerKey !== f.ownerKey || old.memberId !== f.memberId || old.clientId !== f.clientId)) throw new SecurityError('POLICY_CHANGED');
      const active = f.active && !this.fenced(f) && (!old || old.active);
      const epoch = (old?.epoch ?? 1) + (old?.active && !active ? 1 : 0);
      this.db.prepare('INSERT INTO security_subjects VALUES(?,?,?,?,?,?,?) ON CONFLICT(installation_id) DO UPDATE SET epoch=excluded.epoch,state=excluded.state,valid_until=excluded.valid_until')
        .run(f.installationId, f.ownerKey, f.memberId, f.clientId, epoch, active ? 'active' : 'denied', active ? this.now() + securityDefaults.authorityProjectionLeaseSeconds * 1000 : 0);
      if (old?.active && !active) this.invalidateInstallation(f.installationId);
      return this.getSubject(f.installationId)!;
    });
  }
  requireSubject(installationId: string, epoch?: number): Subject {
    this.requireManager(); const value = this.getSubject(installationId);
    if (!value?.active || value.validUntil <= this.now() || this.fenced(value)) throw new SecurityError('ACCESS_REVOKED');
    if (epoch !== undefined && value.epoch !== epoch) throw new SecurityError('POLICY_CHANGED');
    return value;
  }
  private invalidateInstallation(id: string) {
    this.db.prepare("UPDATE security_grants SET state='revoked',revision=revision+1 WHERE installation_id=? AND state='active'").run(id);
    this.db.prepare("UPDATE security_task_authorities SET state='revoked' WHERE installation_id=? AND state='active'").run(id);
  }
  deny(input: Pick<Fence, 'ownerKey' | 'kind' | 'targetId'>): Fence {
    return this.atomic(() => {
      const id = fenceKey(input), old = this.db.prepare('SELECT revision,state FROM security_fences WHERE id=?').get(id);
      // Each coordination attempt has a fresh fence version. A delayed restore
      // must never clear a newer revocation from another process.
      const revision = Number(old?.revision ?? 0) + 1;
      this.db.prepare("INSERT INTO security_fences VALUES(?,?,?,?,?,'pending') ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,state='pending'").run(id, input.ownerKey, input.kind, input.targetId, revision);
      for (const s of this.subjects().filter(s => s.ownerKey === input.ownerKey && (input.kind === 'member' ? s.memberId === input.targetId : input.kind === 'connection' ? s.clientId === input.targetId : s.installationId === input.targetId))) {
        if (s.active) this.db.prepare("UPDATE security_subjects SET state='denied',epoch=epoch+1,valid_until=0 WHERE installation_id=?").run(s.installationId);
        this.invalidateInstallation(s.installationId);
      }
      this.event('deny', id, revision); return { ...input, revision, state: 'pending' };
    });
  }
  settleFence(f: Fence, state: 'applied' | 'cleared') {
    this.atomic(() => {
      if (this.db.prepare('UPDATE security_fences SET state=? WHERE id=? AND revision=?').run(state, fenceKey(f), f.revision).changes !== 1) throw new SecurityError('POLICY_CHANGED');
      if (state === 'cleared') {
        // Restore eligibility only. Revoked grants and old task authorities stay revoked.
        for (const s of this.subjects().filter(s => s.ownerKey === f.ownerKey && !this.fenced(s))) this.db.prepare("UPDATE security_subjects SET state='active',epoch=epoch+1,valid_until=0 WHERE installation_id=?").run(s.installationId);
      }
      this.event(state, fenceKey(f), f.revision);
    });
  }
  completeFence(f: Fence, state: 'applied' | 'cleared', changeMembership: () => void) {
    // The deny is already committed. Serialize the subsequent source update
    // against newer coordination attempts without pretending the two DBs commit
    // atomically: a crash/rollback here leaves the original pending deny intact.
    this.atomic(() => {
      if (this.db.prepare('UPDATE security_fences SET state=state WHERE id=? AND revision=?').run(fenceKey(f), f.revision).changes !== 1) throw new SecurityError('POLICY_CHANGED');
      changeMembership();
      this.settleFence(f, state);
    });
  }
  pendingFences(): Fence[] { return this.db.prepare("SELECT * FROM security_fences WHERE state='pending'").all().map(r => ({ ownerKey: String(r.owner), kind: r.kind as Fence['kind'], targetId: String(r.target_id), revision: Number(r.revision), state: 'pending' })); }
  hasFence(input: Pick<Fence, 'ownerKey' | 'kind' | 'targetId'>): boolean {
    return !!this.db.prepare("SELECT 1 FROM security_fences WHERE id=? AND state<>'cleared'").get(fenceKey(input));
  }
  agentGrant(installationId: string): AgentAccessGrant {
    this.requireSubject(installationId);
    const row = this.db.prepare("SELECT * FROM security_grants WHERE installation_id=? AND kind='agent_access' AND state='active' AND expires_at>?").get(installationId, this.now());
    if (!row) throw new SecurityError('AUTHORIZATION_REQUIRED');
    return agentAccessGrantSchema.parse(grant(row));
  }
  listGrants(owner: string): (AgentAccessGrant | TaskDataGrant)[] { return this.db.prepare('SELECT * FROM security_grants WHERE owner=? ORDER BY rowid').all(owner).map(r => r.kind === 'agent_access' ? agentAccessGrantSchema.parse(grant(r)) : taskDataGrantSchema.parse(grant(r))); }
  issueAgentGrant(input: unknown): AgentAccessGrant {
    const g = agentAccessGrantSchema.parse(input);
    return this.atomic(() => {
      const s = this.requireSubject(g.installationId);
      if (s.ownerKey !== g.ownerKey || s.memberId !== g.memberId || g.status !== 'active' || g.revision !== 1 || Date.parse(g.issuedAt) > this.now() || Date.parse(g.expiresAt) <= this.now()) throw new SecurityError('ACCESS_REVOKED');
      if (this.db.prepare("SELECT 1 FROM security_grants WHERE installation_id=? AND kind='agent_access' AND state='active'").get(g.installationId)) throw new DomainError('CONFLICT', 'Revoke the current installation grant before approving a replacement');
      this.insertGrant(g); this.event('agent_grant_issued', g.id, g.revision); return g;
    });
  }
  private insertGrant(g: AgentAccessGrant | TaskDataGrant) {
    this.db.prepare('INSERT INTO security_grants VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(g.id, g.kind, g.ownerKey, g.memberId, g.installationId,
      'parentGrant' in g ? g.parentGrant.id : null, 'parentGrant' in g ? g.parentGrant.revision : null, g.revision, g.status, Date.parse(g.expiresAt), JSON.stringify(g));
  }
  revokeGrant(owner: string, id: string, expectedRevision: number) {
    this.atomic(() => {
      const row = this.db.prepare('SELECT * FROM security_grants WHERE owner=? AND id=?').get(owner, id);
      if (!row) throw new DomainError('NOT_FOUND', 'Grant not found');
      if (Number(row.revision) !== expectedRevision) throw new DomainError('CONFLICT', 'Grant revision changed');
      this.db.prepare("UPDATE security_grants SET state='revoked',revision=revision+1 WHERE id=? OR parent_id=?").run(id, id);
      this.db.prepare("UPDATE security_task_authorities SET state='revoked' WHERE agent_grant_id=? OR data_grant_id=?").run(id, id);
      this.event('grant_revoked', id, expectedRevision + 1);
    });
  }
  /** Internal provisioning seam for S2. No S1 public endpoint can attach a task. */
  issueTaskGrant(input: unknown): TaskDataGrant {
    const g = taskDataGrantSchema.parse(input);
    return this.atomic(() => {
      const parent = this.agentGrant(g.installationId);
      const same = parent.id === g.parentGrant.id && parent.revision === g.parentGrant.revision && parent.ownerKey === g.ownerKey && parent.memberId === g.memberId;
      const permitted = (type: string, fields: string[]) => fields.every(f => parent.resources.some(r => r.type === type && r.fields.includes(f)));
      if (!same || g.status !== 'active' || g.revision !== 1 || Date.parse(g.issuedAt) > this.now() || Date.parse(g.expiresAt) <= this.now()
        || Date.parse(g.expiresAt) > Date.parse(parent.expiresAt) || !g.channels.every(c => parent.channels.includes(c))
        || !g.inputs.every(i => permitted(i.object.type, i.fields)) || !g.outputs.every(o => permitted(o.type, o.fields) && parent.sourceBindingIds.includes(o.sourceBindingId))) throw new SecurityError('ACCESS_REVOKED');
      const job = this.db.prepare('SELECT owner,body FROM jobs WHERE id=?').get(g.taskId);
      if (!job || job.owner !== g.ownerKey || JSON.parse(String(job.body)).delegation?.request?.revision !== g.requestRevision) throw new DomainError('CONFLICT', 'Grant must bind the current owned request revision');
      for (const input of g.inputs) {
        const object = this.db.prepare('SELECT revision FROM ontology_objects WHERE owner=? AND type=? AND id=?').get(g.ownerKey, input.object.type, input.object.id);
        if (!object || object.revision !== input.objectRevision) throw new DomainError('CONFLICT', 'Grant input must reference a current owned object revision');
      }
      if(g.purpose!=='delegated_task' || g.inputs.length && !g.operations.includes('member_asset.read')) throw new SecurityError('AUTHORIZATION_REQUIRED');
      this.insertGrant(g); this.policies.bindInputs(g); this.event('task_grant_issued', g.id, g.revision); return g;
    });
  }
  attachTaskAuthority(input: unknown): TaskAuthority {
    const a = taskExecutionAuthoritySchema.parse(input);
    return this.atomic(() => {
      const s = this.requireSubject(a.installationId, a.authEpoch), p = this.agentGrant(a.installationId);
      const row = this.db.prepare("SELECT * FROM security_grants WHERE id=? AND kind='task_data' AND state='active' AND expires_at>?").get(a.dataGrant.id, this.now());
      if (!row) throw new SecurityError('AUTHORIZATION_REQUIRED');
      const d = taskDataGrantSchema.parse(grant(row));
      if (a.ownerKey !== s.ownerKey || a.memberId !== s.memberId || a.agentGrant.id !== p.id || a.agentGrant.revision !== p.revision
        || d.installationId !== a.installationId || d.ownerKey !== a.ownerKey || d.memberId !== a.memberId || d.revision !== a.dataGrant.revision
        || d.parentGrant.id !== p.id || d.parentGrant.revision !== p.revision || d.taskId !== a.taskId || d.requestRevision !== a.requestRevision
        || !d.operations.includes('task.process') || (a.authorityOrigin==='agent_submission' ? !a.submittedScopes.includes('tasks:write') || d.inputs.length > 0 && !a.submittedScopes.includes('tasks:read') : a.submittedScopes.length!==0)
        || a.revision !== 1 || Date.parse(a.issuedAt) > this.now() || Date.parse(a.expiresAt) <= this.now() || Date.parse(a.expiresAt) > Math.min(Date.parse(d.expiresAt), Date.parse(p.expiresAt))) throw new SecurityError('ACCESS_REVOKED');
      this.db.prepare("INSERT INTO security_task_authorities VALUES(?,?,?,?,?,?,?,?,?,?,?,'active',?,?)").run(a.id, a.ownerKey, a.memberId, a.installationId, a.taskId, a.requestRevision, p.id, p.revision, d.id, d.revision, s.epoch, Date.parse(a.expiresAt), JSON.stringify(a));
      this.event('task_authority_attached', a.id, a.revision); return a;
    });
  }
  readonly workPredicate = `AND id IN (SELECT a.task_id ${authorityQuery})`;
  workAuthority(owner: string, jobId: string, now = this.now()): TaskAuthority | undefined {
    if (!this.enabled) return;
    try{this.policies.revision();}catch{return;}
    const row = this.db.prepare(`SELECT a.body ${authorityQuery} AND a.owner=? AND a.task_id=?`).get({ securityNow: now,securityDefinition:this.policies.definitionDigest }, owner, jobId);
    return row ? taskExecutionAuthoritySchema.parse(JSON.parse(String(row.body))) : undefined;
  }
  agentContext(principal: Principal): Extract<AccessContext, { actorKind: 'agent' }> {
    const actor = accessContextSchema.parse(principal.access);
    if (actor.actorKind !== 'agent' || actor.ownerKey !== ownerKey(principal) || actor.clientId !== principal.clientId
      || digest([...actor.tokenScopes].sort()) !== digest([...new Set(principal.scopes)].sort())) throw new SecurityError('AUTHORIZATION_REQUIRED');
    this.requireSubject(actor.installationId, actor.authEpoch);
    const parent = this.agentGrant(actor.installationId);
    if (parent.id !== actor.agentGrant.id || parent.revision !== actor.agentGrant.revision) throw new SecurityError('POLICY_CHANGED');
    return actor;
  }
  taskGrant(actor: Extract<AccessContext, { actorKind: 'agent' | 'worker' }>, taskId: string): TaskDataGrant {
    this.requireSubject(actor.installationId, actor.authEpoch);
    const parent = this.agentGrant(actor.installationId);
    const rows = this.db.prepare("SELECT d.* FROM security_grants d JOIN jobs j ON j.id=json_extract(d.body,'$.taskId') AND j.owner=d.owner WHERE d.owner=? AND d.installation_id=? AND d.kind='task_data' AND d.state='active' AND d.expires_at>? AND d.parent_id=? AND d.parent_revision=? AND json_extract(d.body,'$.taskId')=? AND json_extract(d.body,'$.requestRevision')=json_extract(j.body,'$.delegation.request.revision') ORDER BY d.rowid DESC")
      .all(actor.ownerKey, actor.installationId, this.now(), parent.id, parent.revision, taskId);
    if (rows.length !== 1) throw new SecurityError('AUTHORIZATION_REQUIRED');
    return taskDataGrantSchema.parse(grant(rows[0]!));
  }
  scope(actor: Extract<AccessContext, { actorKind: 'agent' | 'worker' }>, taskId: string | undefined, operation: AuthorizationScope['operation']): AuthorizationScope {
    const data = taskId ? this.taskGrant(actor, taskId) : undefined, policyRevision = this.policies.revision();
    if (data && (data.purpose!=='delegated_task' || !data.operations.includes(operation) || data.inputs.length>0 && !data.operations.includes('member_asset.read'))) throw new SecurityError('AUTHORIZATION_REQUIRED');
    const parent = this.agentGrant(actor.installationId);
    const scope: AuthorizationScope = { actor, policies: this.policies, grant: data, operation, policyRevision, lineage: new Map(), assertCurrent: () => {
      this.requireSubject(actor.installationId, actor.authEpoch);
      const currentParent = this.agentGrant(actor.installationId);
      if (currentParent.id !== parent.id || currentParent.revision !== parent.revision || this.policies.revision() !== policyRevision) throw new SecurityError('POLICY_CHANGED');
      if (data) { const current = this.taskGrant(actor, data.taskId); if (current.id !== data.id || current.revision !== data.revision) throw new SecurityError('POLICY_CHANGED'); }
      if (actor.actorKind === 'worker') {
        const lease=this.db.prepare('SELECT token,expires_at FROM work_claims WHERE job_id=?').get(actor.taskId);
        if (this.workAuthority(actor.ownerKey, actor.taskId)?.id !== actor.authorityRef.id || !lease || Number(lease.expires_at)<=this.now() || digest(String(lease.token))!==actor.claimRef
          || !claimAuthorityCurrent(this.db,actor.taskId,String(lease.token))) throw new SecurityError('ACCESS_REVOKED');
      }
    } };
    scope.assertCurrent(); if(actor.actorKind==='worker') this.policies.loadLineage(scope); return scope;
  }
  withAgent<T>(principal: Principal, taskId: string | undefined, operation: AuthorizationScope['operation'], action: (scope: AuthorizationScope) => T): T {
    const scope = this.scope(this.agentContext(principal), taskId, operation);
    return withAuthorization(scope, () => { const value = action(scope); scope.assertCurrent(); return value; });
  }
  workerScope(owner: string, taskId: string, authorityId: string, claimToken: string): AuthorizationScope {
    const a = this.workAuthority(owner, taskId), subject = a && this.requireSubject(a.installationId, a.authEpoch);
    if (!a || !subject || a.id !== authorityId) throw new SecurityError('ACCESS_REVOKED');
    const actor = accessContextSchema.parse({ version: SECURITY_CONTRACT, actorKind: 'worker', ownerKey: owner, memberId: a.memberId, installationId: a.installationId,
      clientId: subject.clientId, tokenScopes: a.submittedScopes, authEpoch: a.authEpoch, policyVersion: POLICY_VERSION, checkedAt: new Date(this.now()).toISOString(),
      taskId, requestRevision: a.requestRevision, authorityRef: { id: a.id, revision: a.revision }, dataGrant: a.dataGrant, claimRef: digest(claimToken) });
    if (actor.actorKind !== 'worker') throw new SecurityError('ACCESS_REVOKED');
    return this.scope(actor, taskId, 'task.process');
  }
}
