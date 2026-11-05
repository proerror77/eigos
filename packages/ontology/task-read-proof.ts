import { z } from 'zod';
import type { Job } from '../core/domain.js';
import { digest } from '../core/delegation.js';
import { ontologyReleaseRefSchema, type OntologyReleaseRef } from './definition-contracts.js';

export const taskReadProofSchema = z.strictObject({ version: z.literal(1), sourceAuthority: z.string().min(1).max(200),
  taskId: z.uuid(), owner: z.string().min(1).max(2000), backend: z.string().min(1), original: ontologyReleaseRefSchema,
  requestDigest: z.string().length(64), artifactDigest: z.string().length(64), target: ontologyReleaseRefSchema,
  verifiedObjectCount: z.number().int().nonnegative(), factDigest: z.string().length(64), createdAt: z.iso.datetime() });

/** Validate the immutable witness against the exact owned task. */
export function validateTaskReadProjection(owner: string, job: Job, body: string, expectedDigest: string): OntologyReleaseRef {
  const proof = taskReadProofSchema.parse(JSON.parse(body));
  if (digest(proof) !== expectedDigest || proof.owner !== owner || proof.taskId !== job.id || proof.backend !== job.delegation?.backendVersion
    || digest(proof.original) !== digest(job.delegation?.ontologyRelease ?? null) || proof.requestDigest !== digest(job.delegation?.request)
    || proof.artifactDigest !== digest(job.artifact ?? null)) throw new Error('Historical read projection no longer matches its source task');
  return proof.target;
}
