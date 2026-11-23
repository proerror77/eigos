import { z } from 'zod';
import {
  cancelCommitmentInput, commitmentInput, commitmentState, confirmCommitmentInput, observedReceipt,
  tableReservationTerms, termsDigest,
} from './network-contract.js';
import {
  nativeRestaurantId, restaurantName, restaurantProperties, restaurantVenueType, restaurantVisitType,
} from './restaurant-services.js';
import { objectRefSchema, type OntologyDocument } from './schema.js';
import { json, time } from './service-contracts.js';

export const tableCheckReservationType = 'TableCheckReservation';
export const tableCheckVisitLink = 'TableCheckReservationVisit';
export const tableCheckVenueLink = 'TableCheckReservationVenue';
export const prepareTableCheckInput = z.strictObject({ visit: objectRefSchema, startsAt: time });
export const tableCheckRecord = tableReservationTerms.extend({
  id: termsDigest, name: restaurantName, state: commitmentState, termsDigest, expiresAt: time,
  startsAt: time, shopId: nativeRestaurantId, binding: termsDigest, holdExpiresAt: time.optional(),
  bookingId: nativeRestaurantId.optional(), confirmationCode: z.string().max(60).optional(),
  manageUrl: z.url({ protocol: /^https$/ }).max(2000).optional(),
  receipts: z.array(observedReceipt.extend({ evidence: z.enum(['connector_receipt', 'synthetic']) })).max(20),
});
export const tableCheckReadInput = z.strictObject({ reservation: objectRefSchema });
const tableCheckReadResult = tableCheckRecord.omit({ binding: true }).extend({ venue: objectRefSchema, visit: objectRefSchema });
const definitions = [
  ['PrepareTableCheckReservation', prepareTableCheckInput, { visit: restaurantVisitType },
    'Prepare an offer for an exact observed TableCheck time with the terms for user review.'],
  ['ConfirmTableCheckReservation', confirmCommitmentInput, { commitment: tableCheckReservationType },
    'After user approval, reserve the exact TableCheck slot and read back the same reservation.'],
  ['CancelTableCheckReservation', cancelCommitmentInput, { commitment: tableCheckReservationType },
    'After user approval, cancel the original TableCheck reservation and independently verify cancellation.'],
  ['ReconcileTableCheckReservation', commitmentInput, { commitment: tableCheckReservationType },
    'Look up the original TableCheck reservation after a lost or pending response.'],
  ['ExpireTableCheckReservation', commitmentInput, { commitment: tableCheckReservationType },
    'Record a TableCheck offer or hold reaching its deadline when no reservation was dispatched.'],
] as const;
const functionName = (action: string) => action[0]!.toLowerCase() + action.slice(1);
const deps = { objectTypes: [tableCheckReservationType, restaurantVisitType, restaurantVenueType],
  linkTypes: [tableCheckVisitLink, tableCheckVenueLink, 'RestaurantVisitVenue'] };
const body = ['state', 'termsDigest', 'expiresAt', 'receipts', ...Object.keys(tableReservationTerms.shape)];
export const tableCheckReservations: Pick<OntologyDocument, 'objectTypes' | 'interfaceTypes' | 'linkTypes' | 'actionTypes' | 'functionTypes'> = {
  interfaceTypes: [{
    apiName: 'RestaurantReservationOffer', description: 'Prepare a reservation from a dated provider availability observation.',
    properties: restaurantProperties({ name: restaurantName }), optionalProperties: [],
    links: { venue: { target: 'RestaurantVenue', cardinality: 'one', required: true },
      visit: { target: 'RestaurantVisitReview', cardinality: 'one', required: true } },
    actions: { prepare: { parameters: json(prepareTableCheckInput), objectParameters: { visit: 'RestaurantVisitReview' }, required: true } },
  }],
  objectTypes: [
    { apiName: tableCheckReservationType, displayName: 'TableCheck 餐厅订座', primaryKey: 'id', titleProperty: 'name',
      description: 'A TableCheck booking, with frozen offer terms, links and independent provider receipts.',
      properties: restaurantProperties(tableCheckRecord.shape),
      interfaces: {
        RestaurantReservationOffer: {
          properties: { name: 'name' }, links: { venue: 'venue', visit: 'visit' },
          actions: { prepare: { action: 'PrepareTableCheckReservation', parameters: { visit: 'visit', startsAt: 'startsAt' } } },
        },
        NetTableReservation: {
          properties: Object.fromEntries(body.map(name => [name, name])), links: {},
          actions: {
            confirm: { action: 'ConfirmTableCheckReservation', parameters: { commitment: 'commitment', approval: 'approval', contact: 'contact' } },
            cancel: { action: 'CancelTableCheckReservation', parameters: { commitment: 'commitment', reason: 'reason' } },
            reconcile: { action: 'ReconcileTableCheckReservation', parameters: { commitment: 'commitment' } },
          },
        },
      } },
  ],
  linkTypes: [
    { apiName: tableCheckVisitLink, description: 'The availability observation used for this offer.',
      from: { type: tableCheckReservationType, name: 'visit', cardinality: 'one' },
      to: { type: restaurantVisitType, name: 'reservations', cardinality: 'many' } },
    { apiName: tableCheckVenueLink, description: 'The source venue that owns this reservation.',
      from: { type: tableCheckReservationType, name: 'venue', cardinality: 'one' },
      to: { type: restaurantVenueType, name: 'reservations', cardinality: 'many' } },
  ],
  actionTypes: definitions.map(([apiName, schema, objectParameters, description]) => ({
    apiName, description, parameters: json(schema), objectParameters: { ...objectParameters },
    function: functionName(apiName), submissionCriteria: [],
  })),
  functionTypes: [
    ...definitions.map(([name, schema, , description]) => ({
      apiName: functionName(name), description, parameters: json(schema), returns: json(objectRefSchema), edits: true,
      ...(name !== 'ExpireTableCheckReservation' ? { source: 'TableCheck' } : {}), dependencies: deps,
    })),
    { apiName: 'readTableCheckReservation', source: 'TableCheck', description: 'Read the exact offered terms and original TableCheck booking receipts.',
      parameters: json(tableCheckReadInput), returns: json(tableCheckReadResult), dependencies: deps },
  ],
};
