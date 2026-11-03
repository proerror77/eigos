import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, copyFileSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmSync, chmodSync, existsSync, writeFileSync, statfsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { digest } from '../core/delegation.js';
import { ownerKey } from '../core/domain.js';
import { consentDeadline } from '../security/consent-lifetime.js';
import { installRuntimeAuthority, runtimeAuthorityDigest, runtimeAuthorityMatches, runtimeAuthoritySchema, type RuntimeAuthority } from '../core/runtime-authority.js';

export interface PrimaryRelocationInput {
  businessSnapshot: string;
  membershipSnapshot: string;
  sourceAuthority: RuntimeAuthority;
  targetDirectory: string;
}
const fileHash = (path: string): string => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > 8 * 1024 ** 3)
      throw new Error('Relocation requires bounded owned private snapshot files');
    const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
    let length: number;
    while ((length = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, length));
    return hash.digest('hex');
  } finally { closeSync(fd); }
};
function closedSnapshot(path: string): DatabaseSync {
  if (!isAbsolute(path) || ['-wal', '-shm', '-journal'].some(suffix => existsSync(path + suffix)))
    throw new Error('Use explicit closed self-contained snapshots without SQLite sidecars');
  fileHash(path);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; BEGIN');
    if (String(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toLowerCase() !== 'delete'
      || db.prepare('PRAGMA integrity_check(1)').get()?.integrity_check !== 'ok'
      || db.prepare('PRAGMA foreign_key_check').get()) throw new Error('A closed DELETE-mode snapshot with valid integrity is required');
    return db;
  } catch (error) { db.close(); throw error; }
}
const table = (db: DatabaseSync, name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
function inspect(input: PrimaryRelocationInput, now = Date.now()) {
  const source = runtimeAuthoritySchema.parse(input.sourceAuthority), target = resolve(input.targetDirectory);
  if (!isAbsolute(input.targetDirectory) || existsSync(target)) throw new Error('Use a new absolute relocation target');
  const declared = (path: string) => existsSync(path) ? realpathSync(path) : resolve(path);
  if (realpathSync(input.businessSnapshot) === declared(source.databasePath) || realpathSync(input.membershipSnapshot) === declared(source.membershipDatabasePath))
    throw new Error('Capture closed source copies; relocation cannot operate on the declared live stores');
  if (realpathSync(input.businessSnapshot) === realpathSync(input.membershipSnapshot)) throw new Error('Business and membership snapshots must be distinct');
  const business = closedSnapshot(input.businessSnapshot);
  let members: DatabaseSync | undefined;
  try {
    members = closedSnapshot(input.membershipSnapshot);
    if (!runtimeAuthorityMatches(business, source)) throw new Error('Snapshot authority differs from the reviewed source descriptor');
    const settings = business.prepare('SELECT mode,version FROM security_settings WHERE slot=1').get();
    if (settings?.mode !== 'foundation' || settings.version !== 2) throw new Error('An existing Foundation v2 source is required');
    for (const name of ['jobs', 'ontology_definition_releases', 'security_policy', 'security_policy_definitions']) if (!table(business, name)) throw new Error('The business snapshot is incomplete');
    for (const name of ['members', 'agent_registrations']) if (!table(members, name)) throw new Error('The membership snapshot is incomplete');
    if (table(business, 'work_claims') && business.prepare('SELECT 1 FROM work_claims LIMIT 1').get()
      || table(business, 'runtime_work_claims') && business.prepare('SELECT 1 FROM runtime_work_claims LIMIT 1').get()
      || table(business, 'security_manager') && business.prepare('SELECT 1 FROM security_manager WHERE expires_at>?').get(now)
      || table(business, 'network_lease') && business.prepare('SELECT 1 FROM network_lease WHERE expires>?').get(now)
      || table(business, 'messaging_node_leases') && business.prepare('SELECT 1 FROM messaging_node_leases WHERE expires_at>?').get(now)
      || table(business, 'security_recoveries') && business.prepare("SELECT 1 FROM security_recoveries WHERE state='running'").get()
      || table(business, 'security_fences') && business.prepare("SELECT 1 FROM security_fences WHERE state NOT IN ('cleared','applied')").get()
      || table(business, 'ontology_definition_drafts') && business.prepare("SELECT 1 FROM ontology_definition_drafts WHERE status='open'").get())
      throw new Error('Stop source writers and resolve active claims, recovery, leases, fences and drafts before relocation');
    const member = members.prepare('SELECT issuer,tenant,subject FROM members WHERE id=?');
    const identity = (owner: unknown, memberId: unknown) => {
      const row = member.get(String(memberId));
      if (!row || ownerKey({ issuer: String(row.issuer), tenant: String(row.tenant), subject: String(row.subject), clientId: 'snapshot-audit', scopes: [] }) !== owner)
        throw new Error('Business and membership snapshot identities do not match');
    };
    for (const row of business.prepare("SELECT owner,member_id FROM security_subjects WHERE state='active' AND valid_until>?").iterate(now)) identity(row.owner, row.member_id);
    for (const name of ['security_grants', 'security_task_authorities']) for (const row of business.prepare('SELECT owner,member_id,body FROM ' + name + " WHERE state='active'").iterate()) {
      if (consentDeadline(JSON.parse(String(row.body)).expiresAt) > now) identity(row.owner, row.member_id);
    }
    const authority = runtimeAuthoritySchema.parse({ ...source, revision: source.revision + 1, databasePath: join(target, 'tasks.sqlite'), membershipDatabasePath: join(target, 'members.sqlite') });
    const policyDigest = String(business.prepare('SELECT digest FROM security_policy_definitions WHERE slot=1').get()?.digest);
    const policyRevision = Number(business.prepare('SELECT revision FROM security_policy WHERE slot=1').get()?.revision);
    if (!/^[a-f0-9]{64}$/.test(policyDigest) || !Number.isSafeInteger(policyRevision) || policyRevision < 1) throw new Error('Source policy identity is incomplete');
    const summary = {
      sourceAuthorityId: source.id, sourceAuthorityRevision: source.revision, sourceAuthorityDigest: runtimeAuthorityDigest(source),
      targetAuthorityDigest: runtimeAuthorityDigest(authority), authority,
      businessFileDigest: fileHash(input.businessSnapshot), membershipFileDigest: fileHash(input.membershipSnapshot),
      businessBytes: lstatSync(input.businessSnapshot).size, membershipBytes: lstatSync(input.membershipSnapshot).size,
      taskCount: Number(business.prepare('SELECT count(*) n FROM jobs').get()?.n),
      memberCount: Number(members.prepare('SELECT count(*) n FROM members').get()?.n),
      policyDigest, policyRevision, nextPolicyRevision: policyRevision + 1,
      permissionsAdded: 0, expirationsExtended: false, operationsReplayed: 0,
    };
    return { summary, sourceDigest: digest(summary) };
  } finally { business.close(); members?.close(); }
}
export function planPrimaryRelocation(input: PrimaryRelocationInput, now = Date.now()) {
  const inspected = inspect(input, now); return { version: 1, ...inspected.summary, sourceDigest: inspected.sourceDigest, applied: false };
}

/** Copy only: source stores, task bodies, immutable releases, membership,
 * consents and operation keys are retained. The one authority keeps its ID;
 * only its destination paths/revision and the corresponding policy fence move. */
export function relocatePrimarySnapshots(input: PrimaryRelocationInput, expectedSourceDigest: string, now = Date.now()) {
  const inspected = inspect(input, now);
  if (inspected.sourceDigest !== expectedSourceDigest) throw new Error('Source snapshots or destination changed after the relocation plan');
  const target = resolve(input.targetDirectory), parent = dirname(target);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || parentStat.uid !== process.getuid?.() || parentStat.mode & 0o077) throw new Error('Use an owned private relocation parent');
  const space = statfsSync(parent);
  if (space.bavail * space.bsize < inspected.summary.businessBytes + inspected.summary.membershipBytes + 64 * 1024 ** 2) throw new Error('Insufficient destination space for a separate relocation copy');
  const partial = target + '.partial-' + randomUUID();
  mkdirSync(partial, { mode: 0o700 });
  const businessPath = join(partial, 'tasks.sqlite'), memberPath = join(partial, 'members.sqlite');
  try {
    copyFileSync(input.businessSnapshot, businessPath); copyFileSync(input.membershipSnapshot, memberPath);
    for (const file of [businessPath, memberPath]) chmodSync(file, 0o600);
    if (fileHash(businessPath) !== inspected.summary.businessFileDigest || fileHash(memberPath) !== inspected.summary.membershipFileDigest
      || fileHash(input.businessSnapshot) !== inspected.summary.businessFileDigest || fileHash(input.membershipSnapshot) !== inspected.summary.membershipFileDigest)
      throw new Error('Snapshot changed while preparing the destination copy');
    const db = new DatabaseSync(businessPath);
    try {
      installRuntimeAuthority(db, inspected.summary.authority, inspected.summary.sourceAuthorityDigest);
      if (!runtimeAuthorityMatches(db, inspected.summary.authority)) throw new Error('Destination authority readback failed');
      const currentPolicy = db.prepare('SELECT revision FROM security_policy WHERE slot=1').get()?.revision;
      if (currentPolicy !== inspected.summary.nextPolicyRevision) throw new Error('Destination policy fence did not advance exactly once');
      const receipt = { version: 1, sourceDigest: inspected.sourceDigest, ...inspected.summary, copiedAt: new Date(now).toISOString() };
      db.exec("CREATE TABLE IF NOT EXISTS primary_relocation_receipts(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TRIGGER IF NOT EXISTS primary_relocation_receipts_no_update BEFORE UPDATE ON primary_relocation_receipts BEGIN SELECT RAISE(ABORT,'Relocation receipt is immutable'); END; CREATE TRIGGER IF NOT EXISTS primary_relocation_receipts_no_delete BEFORE DELETE ON primary_relocation_receipts BEGIN SELECT RAISE(ABORT,'Relocation receipt is immutable'); END;");
      db.prepare('INSERT INTO primary_relocation_receipts VALUES(?,?)').run(inspected.sourceDigest, JSON.stringify(receipt));
      if (db.prepare('PRAGMA integrity_check(1)').get()?.integrity_check !== 'ok') throw new Error('Destination business integrity failed');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE');
    } finally { db.close(); }
    if (fileHash(memberPath) !== inspected.summary.membershipFileDigest) throw new Error('Membership copy changed during relocation');
    writeFileSync(join(partial, 'authority.json'), JSON.stringify(inspected.summary.authority, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    writeFileSync(join(partial, 'relocation.json'), JSON.stringify({ sourceDigest: inspected.sourceDigest, ...inspected.summary }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    if (existsSync(target)) throw new Error('Relocation target appeared during preparation');
    renameSync(partial, target);
    return { status: 'prepared', outputDirectory: target, sourceDigest: inspected.sourceDigest, authorityId: inspected.summary.authority.id,
      authorityRevision: inspected.summary.authority.revision, permissionsAdded: 0, operationsReplayed: 0, activation: 'not_started' };
  } catch (error) { if (existsSync(partial)) rmSync(partial, { recursive: true, force: true }); throw error; }
}
