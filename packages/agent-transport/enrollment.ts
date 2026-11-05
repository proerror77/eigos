import { consentDeadline } from '../security/consent-lifetime.js';
import { importJWK, SignJWT, decodeJwt } from 'jose';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { digest } from '../core/delegation.js';
import type { Principal } from '../core/domain.js';
import { readPrivateJson } from '../relay/files.js';
import { agentIdSchema } from '../relay/contracts.js';
import { SecurityError, type SecurityStore } from '../security/store.js';

export interface RelayEnrollmentAuthority {
  now():number;
  withEnrollmentAdmission<T>(principal:Principal,action:(admission:{ownerKey:string;installationId:string;expiresAt:number})=>Promise<T>):Promise<T>;
}

export const RELAY_ENROLLMENT_CLIENT = 'eigos-primary-relay-enrollment';
const keySchema = z.strictObject({ kty: z.literal('OKP'), crv: z.literal('Ed25519'),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/), d: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });

/** A minute-long, node-bound transport assertion from an authenticated current member installation. */
export class RelayEnrollmentIssuer {
  #key;
  #publicKey;
  #kid: string;
  #authority: RelayEnrollmentAuthority;
  constructor(key:string|z.infer<typeof keySchema>,private issuer:string,private audience:string,security:SecurityStore|RelayEnrollmentAuthority){
    this.#authority='withEnrollmentAdmission'in security?security:{now:()=>security.now(),withEnrollmentAdmission:async(principal,action)=>{
      const actor=security.agentContext(principal),parent=security.agentGrant(actor.installationId);
      const result=await action({ownerKey:actor.ownerKey,installationId:actor.installationId,expiresAt:consentDeadline(parent.expiresAt)});security.agentContext(principal);return result;
    }};
    this.#key=keySchema.parse(typeof key==='string'?readPrivateJson(key,4096):key);
    this.#publicKey = { kty: this.#key.kty, crv: this.#key.crv, x: this.#key.x };
    this.#kid = digest(this.#publicKey);
  }
  jwks() { return { keys: [{ ...this.#publicKey, kid: this.#kid, alg: 'EdDSA', use: 'sig' }] }; }
  /** Internal transport enrollment for an explicitly approved service-custodied communication endpoint.
   * The caller rechecks current membership, installation and the separate controller communication grant. */
  async issueCommunication(ownerKey: string, tenant: string, agentId: string, grantExpiresAt: number) {
    agentIdSchema.parse(agentId);
    const now = this.#authority.now(), expiresAt = Math.floor(Math.min(now + 60000, grantExpiresAt) / 1000);
    if (!ownerKey || !tenant || !Number.isFinite(grantExpiresAt) || expiresAt * 1000 <= now) throw new SecurityError('AUTHORIZATION_REQUIRED');
    const assertion = await new SignJWT({ tenant_id: tenant, client_id: RELAY_ENROLLMENT_CLIENT, scope: 'relay:enroll', eigos_agent_id: agentId })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid: this.#kid }).setIssuer(this.issuer).setAudience(this.audience)
      .setSubject(digest(ownerKey)).setIssuedAt(Math.floor(now / 1000)).setExpirationTime(expiresAt).setJti(randomUUID())
      .sign(await importJWK(this.#key, 'EdDSA'));
    if(expiresAt*1000<=this.#authority.now())throw new SecurityError('AUTHORIZATION_REQUIRED');
    return { accessToken: assertion, expiresAt: expiresAt * 1000, agentId };
  }
  async issue(principal: Principal, bearer: string, agentId: string) {
    agentIdSchema.parse(agentId);
    if(!principal.scopes.includes('services:read'))throw new SecurityError('AUTHORIZATION_REQUIRED');
    return this.#authority.withEnrollmentAdmission(structuredClone(principal),async admission=>{
      const now=this.#authority.now(),expiresAt=Math.floor(Math.min(now+60000,admission.expiresAt,z.number().int().parse(decodeJwt(bearer).exp)*1000)/1000);
      if(expiresAt*1000<=now)throw new SecurityError('AUTHORIZATION_REQUIRED');
      const assertion=await new SignJWT({tenant_id:principal.tenant,client_id:RELAY_ENROLLMENT_CLIENT,scope:'relay:enroll',eigos_agent_id:agentId})
        .setProtectedHeader({alg:'EdDSA',typ:'at+jwt',kid:this.#kid}).setIssuer(this.issuer).setAudience(this.audience)
        .setSubject(digest(admission.ownerKey)).setIssuedAt(Math.floor(now/1000)).setExpirationTime(expiresAt).setJti(randomUUID()).sign(await importJWK(this.#key,'EdDSA'));
      if(expiresAt*1000<=this.#authority.now())throw new SecurityError('AUTHORIZATION_REQUIRED');
      return {accessToken:assertion,expiresAt:expiresAt*1000,agentId};
    });
  }
}
