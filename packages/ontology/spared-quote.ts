import { z } from 'zod';
import { sandboxAgentCapability } from './agent-profiles.js';
import type { OntologyDocument } from './schema.js';

export const quoteFunctionName = 'readSyntheticSparedQuote';
export const quoteSourceName = 'SyntheticSparedQuotes';
export const quoteSourceGrant = 'SparedQuoteFixture';
export const quoteObjectType = 'SyntheticSparedQuote';
export const quoteReceiptLink = 'SyntheticSparedQuoteReceipt';

export const quoteId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export const quoteInput = z.strictObject({ quoteId });
export const partnerQuote = z.strictObject({
  label: z.string().min(1).max(120),
  price: z.string().min(1).max(32),
});
export const normalizedQuote = z.strictObject({
  name: z.string().min(1).max(120),
  amountMinor: z.string().regex(/^(?:0|[1-9][0-9]{0,14})$/),
  currency: z.literal('CNY'),
});
export const quoteObservation = z.strictObject({
  quote: normalizedQuote,
  receipt: z.strictObject({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    bindingId: z.string().min(1),
    observedAt: z.iso.datetime(),
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  evidence: z.literal('synthetic'),
});
const json = (schema: z.ZodType) => z.toJSONSchema(schema, { target: 'draft-7', unrepresentable: 'throw' });
export const quoteDefinition = {
  apiName: quoteFunctionName,
  description: 'Read one synthetic partner quote by its fixture ID using the owner-specific spared normalizer. The result is non-bookable.',
  version: '1',
  source: quoteSourceGrant,
  typeClasses: [sandboxAgentCapability],
  parameters: json(quoteInput),
  returns: json(quoteObservation),
} satisfies OntologyDocument['functionTypes'][number];

const field = (schema: z.ZodType, description: string) => ({ schema: json(schema), description, required: true });
export function withSparedQuotePilot(document: OntologyDocument): OntologyDocument {
  return {
    ...document,
    functionTypes: [...document.functionTypes, quoteDefinition],
    objectTypes: [...document.objectTypes, {
      apiName: quoteObjectType,
      displayName: "Synthetic spared quote",
      description: 'An observed, synthetic partner quote for the local spared pilot.',
      primaryKey: 'id',
      titleProperty: 'name',
      typeClasses: [sandboxAgentCapability],
      interfaces: {},
      properties: {
        id: field(z.string().min(1), 'Observation identity'),
        name: field(normalizedQuote.shape.name, 'Normalized service label'),
        quoteId: field(quoteId, 'Partner fixture identifier'),
        amountMinor: field(normalizedQuote.shape.amountMinor, 'Exact amount in minor units'),
        currency: field(normalizedQuote.shape.currency, 'Quote currency'),
        observedAt: field(z.iso.datetime(), 'Fixture observation time'),
        evidence: field(z.literal('synthetic'), 'Evidence origin'),
      },
    }],
    linkTypes: [...document.linkTypes, {
      apiName: quoteReceiptLink,
      description: 'Links a synthetic quote observation to its source receipt.',
      from: { type: quoteObjectType, name: 'source', cardinality: 'one' },
      to: { type: 'SourceReceipt', name: 'syntheticSparedQuotes', cardinality: 'many' },
    }],
    dataSources: [...document.dataSources, {
      apiName: quoteSourceName,
      objectType: quoteObjectType,
      function: quoteFunctionName,
      properties: {
        id: 'id', name: 'name', quoteId: 'quoteId', amountMinor: 'amountMinor',
        currency: 'currency', observedAt: 'observedAt', evidence: 'evidence',
      },
    }],
  };
}
