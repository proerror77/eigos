import { z } from 'zod';
import { MAX_SECURITY_LINEAGE_ITEMS, POLICY_VERSION, SECURITY_CONTRACT, securityEnvelopeSchema } from './contracts.js';
import { SecurityError, SecurityLineageLimitError } from './store.js';

export type SecurityEnvelope = z.infer<typeof securityEnvelopeSchema>;
export type Channel = SecurityEnvelope['channels'][number];
const rank = { private: 0, sensitive: 1, internal: 2 } as const;
/** Restrictions combine monotonically. Unknown/incomplete lineage never exports. */
export function combineEnvelopes(inputs: SecurityEnvelope[]): SecurityEnvelope {
  if (!inputs.length) throw new SecurityError('OUTPUT_NOT_ALLOWED');
  let ownerKey: string | undefined, submission: SecurityEnvelope['submission'];
  let classification: SecurityEnvelope['classification'] = 'private', lineageComplete = true;
  let channels: Channel[] = [];
  const markings = new Set<SecurityEnvelope['requiredMarkings'][number]>();
  const lineage = new Map<string, SecurityEnvelope['lineage'][number]>();
  for (const input of inputs) {
    if (Array.isArray(input?.lineage) && input.lineage.length > MAX_SECURITY_LINEAGE_ITEMS) throw new SecurityLineageLimitError();
    const value = securityEnvelopeSchema.parse(input);
    if (ownerKey === undefined) { ownerKey = value.ownerKey; channels = [...value.channels]; }
    else if (value.ownerKey !== ownerKey) throw new SecurityError('OUTPUT_NOT_ALLOWED');
    if (value.submission) {
      if (submission && JSON.stringify(submission) !== JSON.stringify(value.submission)) throw new SecurityError('OUTPUT_NOT_ALLOWED');
      submission = value.submission;
    }
    for (const dependency of value.lineage) {
      const key = JSON.stringify(dependency);
      if (!lineage.has(key) && lineage.size >= MAX_SECURITY_LINEAGE_ITEMS) throw new SecurityLineageLimitError();
      lineage.set(key, dependency);
    }
    for (const marking of value.requiredMarkings) markings.add(marking);
    if (rank[value.classification] > rank[classification]) classification = value.classification;
    channels = channels.filter(channel => value.channels.includes(channel));
    lineageComplete &&= value.lineageComplete;
  }
  return { version: SECURITY_CONTRACT, ownerKey: ownerKey!, policyVersion: POLICY_VERSION,
    requiredMarkings: [...markings], classification, channels, lineage: [...lineage.values()],
    lineageComplete, ...(submission ? { submission } : {}) };
}
export function requireChannel(envelope: SecurityEnvelope, channel: Channel, clearance: { classification: SecurityEnvelope['classification']; markings: SecurityEnvelope['requiredMarkings'] }) {
  const value = securityEnvelopeSchema.parse(envelope);
  if (!value.lineageComplete || !value.channels.includes(channel) || rank[value.classification] > rank[clearance.classification]
    || value.requiredMarkings.some(m => !clearance.markings.includes(m))) throw new SecurityError('OUTPUT_NOT_ALLOWED');
}
