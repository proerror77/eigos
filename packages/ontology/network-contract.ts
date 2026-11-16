import { z } from 'zod';
import { objectRefSchema, type OntologyDocument } from './schema.js';
import { json, time } from './service-contracts.js';

/**
 * Draft network contract shared by EIGOS, merchant agents and connectors. It is published as its
 * own versioned Ontology document and pinned by consumers through `imports` with its digest and a
 * namespace. The business definition does not import it yet. See docs/architecture/network-contract.md.
 */

export const termsDigest = z.string().regex(/^[a-f0-9]{64}$/);
// The dining pilot uses the same field constraints, so its stored terms satisfy the contract as they are.
const venueName = z.string().trim().min(1).max(160);
const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const commitmentState = z.enum(['offered', 'held', 'confirmed', 'fulfilled', 'canceled', 'expired', 'unknown']);
const receiptFacts = {
  step: z.enum(['hold', 'confirm', 'cancel', 'fulfill']),
  merchantRef: z.string().trim().min(1).max(120),
  termsDigest,
  observedAt: time,
};
/** The merchant agent signed this step with the key published alongside its Agent Card. */
export const merchantSignedReceipt = z.strictObject({ ...receiptFacts, evidence: z.literal('merchant_signed'), signature: z.string().min(1).max(4000) });
/** EIGOS observed this step through a hosted merchant console, a connector, the user's PA or a synthetic run. */
export const observedReceipt = z.strictObject({
  ...receiptFacts, evidence: z.enum(['merchant_confirmed', 'connector_receipt', 'pa_reported', 'synthetic']),
});
// anyOf lets an implementation narrow its receipts to one evidence class; publication cannot prove a oneOf of objects.
export const commitmentReceipt = z.union([merchantSignedReceipt, observedReceipt]);

export const commitmentInput = z.strictObject({ commitment: objectRefSchema });
/** The user approved exactly these terms. Phase 3 replaces this with an AP2 closed Checkout Mandate. */
export const commitmentApproval = z.strictObject({ termsDigest, approvedAt: time });
/** Disclosed only on confirmation. EIGOS may pass a relay number instead of the user's own. */
export const commitmentContact = z.strictObject({ name: z.string().trim().min(1).max(40), phone: z.string().trim().min(1).max(40) });
export const confirmCommitmentInput = commitmentInput.extend({ approval: commitmentApproval, contact: commitmentContact });
export const cancelCommitmentInput = commitmentInput.extend({ reason: z.string().trim().min(1).max(200) });

export const tableReservationTerms = z.strictObject({
  restaurant: venueName,
  city: venueName,
  branch: venueName.optional(),
  date: z.iso.date(),
  time: localTime,
  partySize: z.number().int().min(1).max(20),
  seating: z.enum(['hall', 'private_room']).optional(),
});

type Properties = OntologyDocument['interfaceTypes'][number]['properties'];
const properties = (shape: Record<string, z.ZodType>, descriptions: Record<string, string>): Properties =>
  Object.fromEntries(Object.entries(shape).map(([name, schema]) => schema instanceof z.ZodOptional
    ? [name, { description: descriptions[name]!, required: false, schema: json(schema.unwrap() as z.ZodType) }]
    : [name, { description: descriptions[name]!, required: true, schema: json(schema) }]));
const optional = (shape: Record<string, z.ZodType>) =>
  Object.entries(shape).filter(([, schema]) => schema instanceof z.ZodOptional).map(([name]) => name);
const action = (input: z.ZodType, required = true) => ({ parameters: json(input), objectParameters: { commitment: 'Commitment' }, required });

const commitment = { state: commitmentState, termsDigest, expiresAt: time.optional(), receipts: z.array(commitmentReceipt).max(20) };

export const networkContract: OntologyDocument = {
  id: 'EigosNetwork',
  version: '1',
  interfaceTypes: [
    {
      apiName: 'Commitment',
      description: 'A merchant commitment to exact terms. Each step that changes it returns a receipt for those terms.',
      properties: properties(commitment, {
        state: 'Lifecycle state of the commitment.',
        termsDigest: 'Digest of the exact terms that approvals and receipts bind.',
        expiresAt: 'When an offer or hold lapses.',
        receipts: 'Receipts for each step, oldest first.',
      }),
      optionalProperties: optional(commitment),
      links: {},
      actions: {
        // Optional: many merchants confirm directly without holding a table first.
        hold: action(commitmentInput, false),
        confirm: action(confirmCommitmentInput),
        cancel: action(cancelCommitmentInput),
        // After a lost reply, read the original order by its reference. Never submit again.
        reconcile: action(commitmentInput),
      },
    },
    {
      apiName: 'TableReservation',
      extends: ['Commitment'],
      description: 'A restaurant table for an exact venue, date, time and party size.',
      properties: properties(tableReservationTerms.shape, {
        restaurant: 'Restaurant name.',
        city: 'City of the restaurant.',
        branch: 'Branch, when the restaurant has several.',
        date: 'Local date of the reservation.',
        time: 'Local time of the reservation.',
        partySize: 'Number of guests.',
        seating: 'Hall or private room, when requested.',
      }),
      optionalProperties: optional(tableReservationTerms.shape),
      links: {},
      actions: {},
    },
  ],
  objectTypes: [],
  linkTypes: [],
  functionTypes: [],
  actionTypes: [],
  dataSources: [],
};
