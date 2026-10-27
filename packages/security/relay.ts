import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { DomainError, ownerKey, TASK_SCOPES, type Principal } from '../core/domain.js';
import { agentIdSchema } from '../relay/contracts.js';
import { accessContextSchema } from './contracts.js';
import { SecurityError, type SecurityStore } from './store.js';

const boundPrincipalSchema = z.strictObject({
  issuer: z.string(), tenant: z.string(), subject: z.string(), clientId: z.string(),
  scopes: z.array(z.enum(TASK_SCOPES)), access: accessContextSchema,
});

/** Public-key routing in the existing authority database. No OAuth or source secrets. */
export class RelayAuthority {
  constructor(private db: DatabaseSync, private security: SecurityStore, readOnly: boolean) {
    if (!readOnly) db.exec(`
      CREATE TABLE IF NOT EXISTS security_relay_identities (
        agent_id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, owner TEXT NOT NULL,
        principal TEXT NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS security_relay_proofs (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS security_relay_requests (id TEXT PRIMARY KEY, input_digest TEXT NOT NULL);
    `);
  }

  /** Called only after bearer authentication and verification of this node's DPoP proof. */
  bind(principal: Principal, agentId: string, expiresAt: number, proof: { jti: string; expiresAt: number }) {
    agentIdSchema.parse(agentId);
    if (!this.security.enabled) throw new SecurityError('AUTHORIZATION_REQUIRED');
    return this.security.atomic(() => {
      const actor = this.security.agentContext(principal), now = this.security.now();
      const parent = this.security.agentGrant(actor.installationId);
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 900000
        || expiresAt > Date.parse(parent.expiresAt) || proof.expiresAt <= now) throw new SecurityError('AUTHORIZATION_REQUIRED');
      const previous = this.db.prepare('SELECT installation_id,owner FROM security_relay_identities WHERE agent_id=?').get(agentId);
      if (previous && (previous.installation_id !== actor.installationId || previous.owner !== actor.ownerKey)) throw new SecurityError('AUTHORIZATION_REQUIRED');
      this.db.prepare('DELETE FROM security_relay_proofs WHERE expires_at<=?').run(now);
      if (this.db.prepare('SELECT 1 FROM security_relay_proofs WHERE id=?').get(proof.jti)) throw new SecurityError('ACCESS_REVOKED');
      const scopes = TASK_SCOPES.filter(scope => principal.scopes.includes(scope));
      if (!scopes.includes('services:read') || !scopes.some(s => s === 'tasks:read' || s === 'tasks:write')) throw new SecurityError('AUTHORIZATION_REQUIRED');
      const bound = boundPrincipalSchema.parse({ ...principal, scopes, access: { ...actor, tokenScopes: scopes } });
      this.db.prepare('INSERT INTO security_relay_proofs VALUES(?,?)').run(proof.jti, proof.expiresAt);
      this.db.prepare(`INSERT INTO security_relay_identities VALUES(?,?,?,?,?,'active')
        ON CONFLICT(agent_id) DO UPDATE SET principal=excluded.principal,expires_at=excluded.expires_at,state='active'`)
        .run(agentId, actor.installationId, actor.ownerKey, JSON.stringify(bound), expiresAt);
      return { agentId, installationId: actor.installationId, expiresAt };
    });
  }

  principal(agentId: string): Principal {
    if (!this.security.enabled) throw new SecurityError('AUTHORIZATION_REQUIRED');
    const row = this.db.prepare("SELECT * FROM security_relay_identities WHERE agent_id=? AND state='active' AND expires_at>?")
      .get(agentIdSchema.parse(agentId), this.security.now());
    if (!row) throw new SecurityError('AUTHORIZATION_REQUIRED');
    const principal = boundPrincipalSchema.parse(JSON.parse(String(row.principal)));
    const actor = this.security.agentContext(principal);
    if (actor.installationId !== row.installation_id || ownerKey(principal) !== row.owner) throw new SecurityError('AUTHORIZATION_REQUIRED');
    return principal;
  }

  revoke(principal: Principal, agentId: string) {
    const actor = this.security.agentContext(principal);
    const row = this.db.prepare('SELECT installation_id,owner FROM security_relay_identities WHERE agent_id=?').get(agentIdSchema.parse(agentId));
    if (!row || row.installation_id !== actor.installationId || row.owner !== actor.ownerKey) throw new SecurityError('AUTHORIZATION_REQUIRED');
    this.db.prepare("UPDATE security_relay_identities SET state='revoked' WHERE agent_id=?").run(agentId);
  }

  consumeProof(proof: { jti: string; expiresAt: number }) {
    this.security.atomic(() => {
      const now = this.security.now();
      if (proof.expiresAt <= now) throw new SecurityError('ACCESS_REVOKED');
      this.db.prepare('DELETE FROM security_relay_proofs WHERE expires_at<=?').run(now);
      if (this.db.prepare('SELECT 1 FROM security_relay_proofs WHERE id=?').get(proof.jti)) throw new SecurityError('ACCESS_REVOKED');
      this.db.prepare('INSERT INTO security_relay_proofs VALUES(?,?)').run(z.uuid().parse(proof.jti), proof.expiresAt);
    });
  }

  /** Namespace idempotency by installation, never by an untrusted owner field. */
  requestId(agentId: string, requestId: string): string {
    const p = this.principal(agentId), actor = this.security.agentContext(p);
    return `relay:${digest([actor.installationId, z.uuid().parse(requestId)])}`;
  }
  command(agentId: string, requestId: string, inputDigest: string): string {
    const id = this.requestId(agentId, requestId);
    z.string().regex(/^[a-f0-9]{64}$/).parse(inputDigest);
    return this.security.atomic(() => {
      const old = this.db.prepare('SELECT input_digest FROM security_relay_requests WHERE id=?').get(id);
      if (old && old.input_digest !== inputDigest) throw new DomainError('CONFLICT', 'Relay request ID is already bound to another command');
      this.db.prepare('INSERT OR IGNORE INTO security_relay_requests VALUES(?,?)').run(id, inputDigest);
      return id;
    });
  }
}
