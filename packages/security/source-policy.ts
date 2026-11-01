import { z } from 'zod';
import { nameSchema } from '../ontology/model.js';
import { grantRefSchema } from './contracts.js';

const id=z.string().min(1).max(200);
export const sourceAuthorizationSchema=z.strictObject({installationId:z.uuid(),bindingId:id,programId:id,
  programDigest:z.string().regex(/^[a-f0-9]{64}$/),operations:z.array(id).min(1).max(100),outputTypes:z.array(nameSchema).min(1).max(200),
  expiresAt:z.iso.datetime({offset:true})});
export const storedSourceSchema=sourceAuthorizationSchema.extend({parentGrant:grantRefSchema,
  readbackVersions:z.array(z.strictObject({sourceBindingId:id,programDigest:z.string().regex(/^[a-f0-9]{64}$/)})).max(32).optional()});
export type StoredSource=z.infer<typeof storedSourceSchema>;
export type ObservationSource={programId:string;programDigest:string;sourceBindingId:string};

/** The caller must already have selected current, authorized source records. */
export function sourceMatchesObservation(sources:readonly StoredSource[],origin:ObservationSource,type:string):boolean {
  return sources.some(source=>source.programId===origin.programId && source.outputTypes.includes(type)
    && (source.bindingId===origin.sourceBindingId && source.programDigest===origin.programDigest
      || source.readbackVersions?.some(version=>version.sourceBindingId===origin.sourceBindingId && version.programDigest===origin.programDigest)));
}
