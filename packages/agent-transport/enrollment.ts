import { importJWK, SignJWT, decodeJwt } from 'jose';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { digest } from '../core/delegation.js';
import type { Principal } from '../core/domain.js';
import { readPrivateJson } from '../relay/files.js';
import { agentIdSchema } from '../relay/contracts.js';
import { SecurityError, type SecurityStore } from '../security/store.js';

export const RELAY_ENROLLMENT_CLIENT = 'eigos-primary-relay-enrollment';
const keySchema = z.strictObject({ kty: z.literal('OKP'), crv: z.literal('Ed25519'),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/), d: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });

/** A minute-long, node-bound transport assertion from an authenticated current member installation. */
export class RelayEnrollmentIssuer {
  #key;
  #publicKey;
  #kid: string;
  #security: SecurityStore;
  constructor(path: string, private issuer: string, private audience: string, security: SecurityStore) {
    this.#security = security;
    this.#key = keySchema.parse(readPrivateJson(path, 4096));
    this.#publicKey = { kty: this.#key.kty, crv: this.#key.crv, x: this.#key.x };
    this.#kid = digest(this.#publicKey);
  }
  jwks() { return { keys: [{ ...this.#publicKey, kid: this.#kid, alg: 'EdDSA', use: 'sig' }] }; }
  async issue(principal: Principal, bearer: string, agentId: string) {
    agentIdSchema.parse(agentId);
    const actor = this.#security.agentContext(principal), parent = this.#security.agentGrant(actor.installationId), now = this.#security.now();
    if (!principal.scopes.includes('services:read')) throw new SecurityError('AUTHORIZATION_REQUIRED');
    const expiresAt = Math.floor(Math.min(now + 60000, Date.parse(parent.expiresAt), z.number().int().parse(decodeJwt(bearer).exp) * 1000) / 1000);
    if (expiresAt * 1000 <= now) throw new SecurityError('AUTHORIZATION_REQUIRED');
    const assertion = await new SignJWT({ tenant_id: principal.tenant, client_id: RELAY_ENROLLMENT_CLIENT, scope: 'relay:enroll', eigos_agent_id: agentId })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid: this.#kid }).setIssuer(this.issuer).setAudience(this.audience)
      .setSubject(digest(actor.ownerKey)).setIssuedAt(Math.floor(now / 1000)).setExpirationTime(expiresAt).setJti(randomUUID())
      .sign(await importJWK(this.#key, 'EdDSA'));
    this.#security.agentContext(principal);
    return { accessToken: assertion, expiresAt: expiresAt * 1000, agentId };
  }
}
