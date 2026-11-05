import type {Client} from 'pg';
import {z} from 'zod';
import {ownerIdentitySchema} from '../security/contracts.js';
const sha=z.string().regex(/^[a-f0-9]{64}$/);
const pinnedGrant=z.strictObject({id:z.uuid(),revision:z.number().int().positive(),bodyDigest:sha});
export const postgresTaskGrantReferenceSchema=pinnedGrant.extend({taskId:z.uuid(),requestRevision:z.number().int().positive()});
export type PostgresTaskGrantReference=z.infer<typeof postgresTaskGrantReferenceSchema>;
/** Server-captured identity and original manager continuity. This is internal
 * evidence to inspect current eligibility; it conveys no data or action grant. */
export const postgresEligibilityReferenceSchema=z.strictObject({
  ownerKey:ownerIdentitySchema,memberId:z.uuid(),installationId:z.uuid(),clientId:z.string().min(1).max(2000),
  authEpoch:z.number().int().positive(),policyRevision:z.number().int().positive(),policyDigest:sha,
  managerTokenDigest:sha,parentGrant:pinnedGrant,
  taskGrant:postgresTaskGrantReferenceSchema.optional(),
});
export type PostgresEligibilityReference=z.infer<typeof postgresEligibilityReferenceSchema>;
export type PostgresEligibilityInspector=(reference:PostgresEligibilityReference)=>Promise<{validUntil:number}>;

export type PostgresEligibilityEgress=(client:Client,references:readonly PostgresEligibilityReference[],token:object)=>Promise<PostgresEligibilityReference[]>;
