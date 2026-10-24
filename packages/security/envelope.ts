import { z } from 'zod';
import { POLICY_VERSION, SECURITY_CONTRACT, securityEnvelopeSchema } from './contracts.js';
import { SecurityError } from './store.js';

export type SecurityEnvelope = z.infer<typeof securityEnvelopeSchema>;
export type Channel = SecurityEnvelope['channels'][number];
const rank = { private: 0, sensitive: 1, internal: 2 } as const;
/** Restrictions combine monotonically. Unknown/incomplete lineage never exports. */
export function combineEnvelopes(inputs: SecurityEnvelope[]): SecurityEnvelope {
  if (!inputs.length) throw new SecurityError('OUTPUT_NOT_ALLOWED');
  const values = inputs.map(v => securityEnvelopeSchema.parse(v)), first = values[0]!;
  if (values.some(v => v.ownerKey !== first.ownerKey)) throw new SecurityError('OUTPUT_NOT_ALLOWED');
  const lineage = [...new Map(values.flatMap(v => v.lineage).map(v => [JSON.stringify(v), v])).values()];
  const submissions=[...new Map(values.flatMap(v=>v.submission?[v.submission]:[]).map(v=>[JSON.stringify(v),v])).values()];
  if (submissions.length>1) throw new SecurityError('OUTPUT_NOT_ALLOWED');
  if (lineage.length > 200) throw new SecurityError('OUTPUT_NOT_ALLOWED');
  return { version: SECURITY_CONTRACT, ownerKey: first.ownerKey, policyVersion: POLICY_VERSION,
    requiredMarkings: [...new Set(values.flatMap(v => v.requiredMarkings))],
    classification: values.reduce((a, b) => rank[a] > rank[b.classification] ? a : b.classification, first.classification),
    channels: first.channels.filter(c => values.every(v => v.channels.includes(c))), lineage,
    lineageComplete: values.every(v => v.lineageComplete), ...(submissions[0]?{submission:submissions[0]}:{}) };
}
export function requireChannel(envelope: SecurityEnvelope, channel: Channel, clearance: { classification: SecurityEnvelope['classification']; markings: SecurityEnvelope['requiredMarkings'] }) {
  const value = securityEnvelopeSchema.parse(envelope);
  if (!value.lineageComplete || !value.channels.includes(channel) || rank[value.classification] > rank[clearance.classification]
    || value.requiredMarkings.some(m => !clearance.markings.includes(m))) throw new SecurityError('OUTPUT_NOT_ALLOWED');
}
