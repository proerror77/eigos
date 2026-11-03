import { z } from 'zod';
import { nameSchema } from '../ontology/model.js';
import {consentDeadline,consentExpirySchema} from './consent-lifetime.js';
import { grantRefSchema } from './contracts.js';

const id=z.string().min(1).max(200);
export const legacySourceAuthorizationSchema=z.strictObject({installationId:z.uuid(),bindingId:id,programId:id,
  programDigest:z.string().regex(/^[a-f0-9]{64}$/),operations:z.array(id).min(1).max(100),outputTypes:z.array(nameSchema).min(1).max(200),
  expiresAt:z.iso.datetime({offset:true})});
export const sourceAuthorizationSchema=legacySourceAuthorizationSchema.extend({expiresAt:consentExpirySchema});
export const legacyStoredSourceSchema=legacySourceAuthorizationSchema.extend({parentGrant:grantRefSchema,
  readbackVersions:z.array(z.strictObject({sourceBindingId:id,programDigest:z.string().regex(/^[a-f0-9]{64}$/)})).max(32).optional()});
export const storedSourceSchema=legacyStoredSourceSchema.extend({expiresAt:consentExpirySchema});
export type StoredSource=z.infer<typeof storedSourceSchema>;
export type ObservationSource={programId:string;programDigest:string;sourceBindingId:string};

/** The caller selects authorized records and checks current consent upstream.
 * An explicit clock optionally checks freshness here; no policy mode is chosen. */
export function sourceMatchesObservation(sources:readonly StoredSource[],origin:ObservationSource,type:string,now?:()=>number):boolean {
  return sources.some(source=>(!now||consentDeadline(source.expiresAt)>now())&&source.programId===origin.programId && source.outputTypes.includes(type)
    && (source.bindingId===origin.sourceBindingId && source.programDigest===origin.programDigest
      || source.readbackVersions?.some(version=>version.sourceBindingId===origin.sourceBindingId && version.programDigest===origin.programDigest)));
}
