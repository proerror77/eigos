import { z } from 'zod';

const text = z.string().min(1).max(500), sha = z.string().regex(/^[a-f0-9]{64}$/);
const money = z.strictObject({ minor: z.string().regex(/^(0|[1-9]\d{0,17})$/), currency: z.string().regex(/^[A-Z]{3}$/) });

/** Exact nonfinancial authority for one provider draft. This cannot authorize
 * an order, reservation commitment, payment, customer data, or a later edit. */
export const externalDraftScopeSchema = z.strictObject({
  version: z.literal('1'), resource: z.literal('unpaid_checkout'),
  providerId: text, merchant: z.strictObject({ id: text, name: text, domain: z.string().regex(/^[a-z0-9.-]+$/).max(253) }),
  items: z.array(z.strictObject({ id: text, title: z.string().min(1).max(1000), quantity: z.number().int().min(1).max(1000), unitPrice: money })).min(1).max(20),
  inputDigest: sha, sourceDigest: sha, sourceExpiresAt: z.iso.datetime({ offset: true }), maximumCreates: z.literal(1),
  orderAllowed: z.literal(false), paymentAllowed: z.literal(false), buyerDataAllowed: z.literal(false),
});
export type ExternalDraftScope = z.infer<typeof externalDraftScopeSchema>;

export const externalDraftPermitSchema = z.strictObject({
  action: z.literal('approve_external_draft'), requestId: z.string().min(1).max(128), planDigest: sha,
  draft: externalDraftScopeSchema, expiresAt: z.iso.datetime({ offset: true }), environment: z.literal('live'),
});
