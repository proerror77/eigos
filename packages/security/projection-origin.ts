import { z } from 'zod';
import { digest } from '../core/delegation.js';
import { securityEnvelopeSchema } from './contracts.js';
import { combineEnvelopes, type SecurityEnvelope } from './envelope.js';
import { SecurityError } from './store.js';

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const projectionOriginSchema = z.strictObject({ version: z.literal(1), contentDigest: sha, linksDigest: sha, inputDigest: sha });
export type ProjectionOrigin = z.infer<typeof projectionOriginSchema>;

export function assertProjectionOrigin(ownerKey: string, envelope: SecurityEnvelope | undefined, value: ProjectionOrigin | undefined,
  content?: { definitionDigest: string; body: unknown }): ProjectionOrigin | undefined {
  if (!value) return;
  const origin = projectionOriginSchema.parse(value);
  if (!envelope || envelope.ownerKey !== ownerKey || origin.inputDigest !== digest(envelope)
    || content && origin.contentDigest !== digest([content.definitionDigest, content.body])) throw new SecurityError('POLICY_CHANGED');
  return origin;
}

/** An unchanged task-control record is not a new model output. Retain the
 * evidence that produced that record; subsequent reads remain in the audit
 * and model lineage without becoming its inputs retroactively.
 *
 * This is provenance only. The caller still computes current fields/labels,
 * and every read separately checks membership, grants and source authority.
 * Business outputs and assessments never use this reuse path. */
export function taskProjectionEvidence(input: {
  ownerKey: string;
  revision: number;
  definitionDigest: string;
  body: unknown;
  links: readonly unknown[];
  previous?: { revision: number; inputEnvelope?: SecurityEnvelope; projectionOrigin?: ProjectionOrigin };
  current: () => SecurityEnvelope;
}): { inputEnvelope: SecurityEnvelope; projectionOrigin: ProjectionOrigin } {
  const snapshot = {
    version: 1, contentDigest: digest([input.definitionDigest, input.body]), linksDigest: digest(input.links),
  } as const;
  const previous = input.previous;
  const old = previous?.inputEnvelope && securityEnvelopeSchema.parse(previous.inputEnvelope);
  if (old && old.ownerKey !== input.ownerKey || previous && previous.revision > input.revision) throw new SecurityError('POLICY_CHANGED');
  if (previous?.projectionOrigin) {
    if (!old) throw new SecurityError('POLICY_CHANGED');
    const origin = assertProjectionOrigin(input.ownerKey, old, previous.projectionOrigin)!;
    if (previous.revision === input.revision) {
      if (origin.contentDigest !== snapshot.contentDigest) throw new SecurityError('POLICY_CHANGED');
      if (origin.linksDigest === snapshot.linksDigest) return { inputEnvelope: old, projectionOrigin: { ...snapshot, inputDigest: origin.inputDigest } };
    }
  }
  const current = securityEnvelopeSchema.parse(input.current());
  if (current.ownerKey !== input.ownerKey) throw new SecurityError('POLICY_CHANGED');
  // Keep all known restrictions when a legacy binding is first sealed or a
  // record/relationship changes. Never prune existing historical evidence.
  const inputEnvelope = old ? combineEnvelopes([old, current]) : current;
  return { inputEnvelope, projectionOrigin: { ...snapshot, inputDigest: digest(inputEnvelope) } };
}
