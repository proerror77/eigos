import { z } from 'zod';
import { sandboxAgentCapability } from './agent-profiles.js';
import { partnerRideEstimateResult, partnerRideProvider, partnerRideRoute } from './partner-rides.js';
import { objectRefSchema, type OntologyDocument } from './schema.js';
import { cancelRideInput } from './travel.js';
import { json, time } from './service-contracts.js';

const ref = objectRefSchema;
const id = z.string().regex(/^[a-f0-9]{64}$/);
const amountMinor = z.number().int().positive();
const evidence = z.literal('synthetic');
const currency = z.literal('SGD');
const name = z.string().min(1).max(100);
const approval = { confirm: z.literal(true) };
export const partnerRideQuoteLifetimeSeconds = 300;
const orderState = z.enum(['ordered', 'canceled']);
const observation = z.strictObject({ orderId: id, state: orderState, observedAt: time, evidence });


export const partnerRideTypes = {
  quote: 'PartnerRideQuote', handoff: 'PartnerRideHandoff', trialQuote: 'SyntheticPartnerRideQuote',
  order: 'SyntheticPartnerRideOrder', payment: 'SyntheticPartnerRidePayment',
} as const;
export const partnerRideLinks = {
  handoff: 'PartnerRideQuoteHandoff', order: 'SyntheticPartnerRideQuoteOrder', payment: 'SyntheticPartnerRideOrderPayment',
} as const;
const { quote, handoff, trialQuote, order, payment } = partnerRideTypes;
export const partnerRideInputs = {
  preparePartnerRideQuote: z.strictObject({ provider: partnerRideProvider, route: partnerRideRoute }),
  preparePartnerRideHandoff: z.strictObject({ quote: ref, vehicleId: z.union([z.string().min(1).max(200), z.number().int().positive()]) }),
  createSyntheticPartnerRideQuote: z.strictObject({ trialId: z.uuid(), provider: partnerRideProvider, route: partnerRideRoute }),
  bookSyntheticPartnerRide: z.strictObject({ quote: ref, amountMinor, currency, ...approval }),
  cancelSyntheticPartnerRide: cancelRideInput,
  expireSyntheticPartnerRideQuote: z.strictObject({ quote: ref }),
  observeSyntheticPartnerRide: z.strictObject({ order: ref }),
  paySyntheticPartnerRide: z.strictObject({ order: ref, amountMinor, currency, ...approval }),
};
const schemas = {
  [quote]: z.strictObject({ id, name, estimate: partnerRideEstimateResult.options[1] }),
  [handoff]: z.strictObject({ id, name, provider: partnerRideProvider, appLink: z.url().max(8192), expiresAt: time,
    orderCreated: z.literal(false), paymentInitiated: z.literal(false) }),
  [trialQuote]: z.strictObject({ id, name, evidence, provider: partnerRideProvider, route: partnerRideRoute,
    amountMinor, currency, expiresAt: time, state: z.enum(['available', 'expired']) }),
  [order]: z.strictObject({ id, name, evidence, provider: partnerRideProvider, amountMinor, currency,
    orderId: id, status: z.string(), state: orderState, independentRead: z.literal(false),
    observedAt: time, createdAt: time, canceledAt: time.nullable(), latestObservation: observation.nullable() }),
  [payment]: z.strictObject({ id, name, evidence, provider: partnerRideProvider, amountMinor, currency,
    state: z.enum(['paid']), observedAt: time }),
};

type Operation = {
  fn: keyof typeof partnerRideInputs; action: string; description: string; objects: Record<string, string>; synthetic?: true;
};
const operations: Operation[] = [
  { fn: 'preparePartnerRideQuote', action: 'PreparePartnerRideQuote', objects: {},
    description: 'Obtain a current PA-reported Uber or Grab quote and record it on the original task.' },
  { fn: 'preparePartnerRideHandoff', action: 'PreparePartnerRideHandoff', objects: { quote },
    description: 'Record a user-facing App handoff for an exact vehicle in the original quote. The user orders in the App.' },
  { fn: 'createSyntheticPartnerRideQuote', action: 'CreateSyntheticPartnerRideQuote', objects: {}, synthetic: true,
    description: 'Create a synthetic provider quote in a development trial.' },
  { fn: 'bookSyntheticPartnerRide', action: 'BookSyntheticPartnerRide', objects: { quote: trialQuote }, synthetic: true,
    description: 'Submit a synthetic order for the exact confirmed quote and fare.' },
  { fn: 'cancelSyntheticPartnerRide', action: 'CancelSyntheticPartnerRide', objects: { order }, synthetic: true,
    description: 'Cancel the exact synthetic order. Existing synthetic payment evidence is preserved.' },
  { fn: 'expireSyntheticPartnerRideQuote', action: 'ExpireSyntheticPartnerRideQuote', objects: { quote: trialQuote }, synthetic: true,
    description: 'Mark the original synthetic quote expired once its deadline has passed.' },
  { fn: 'observeSyntheticPartnerRide', action: 'ObserveSyntheticPartnerRide', objects: { order }, synthetic: true,
    description: 'Read back the original local synthetic order, retaining the latest state observation for the PA.' },
  { fn: 'paySyntheticPartnerRide', action: 'PaySyntheticPartnerRide', objects: { order }, synthetic: true,
    description: 'Record a synthetic payment for the exact confirmed fare on the original order.' },
];
const link = (apiName: string, fromType: string, from: string, toType: string, to: string): OntologyDocument['linkTypes'][number] => ({
  apiName, description: 'Relationship to the exact original partner ride record.',
  from: { type: fromType, name: from, cardinality: 'one' },
  to: { type: toType, name: to, cardinality: 'one' },
});
const developmentOnly = { typeClasses: [sandboxAgentCapability] };
const synthetic = new Set<string>([trialQuote, order, payment]);
export const partnerRideReadbacks = {
  readPartnerRideQuote: { parameters: z.strictObject({ quote: ref }), result: schemas[quote] },
  readPartnerRideHandoff: { parameters: z.strictObject({ handoff: ref }), result: schemas[handoff] },
};
const rideOrderProperties = Object.fromEntries(
  ['name', 'orderId', 'status', 'state', 'observedAt', 'independentRead', 'evidence'].map(key => [key, key]),
);
const orderInterfaces: OntologyDocument['objectTypes'][number]['interfaces'] = {
      RideOrder: { properties: rideOrderProperties, links: {}, actions: {} },
      CancelableRideOrder: { properties: rideOrderProperties, links: {}, actions: {
        cancel: { action: 'CancelSyntheticPartnerRide', parameters: { order: 'order', confirmCancellation: 'confirmCancellation', reason: 'reason' } },
      } },
    };
const quoteInterface = 'PartnerRideQuoting';
const quoteInterfaces: OntologyDocument['objectTypes'][number]['interfaces'] = {
  [quoteInterface]: { properties: {}, links: {}, actions: {
    estimate: { action: 'PreparePartnerRideQuote', parameters: { provider: 'provider', route: 'route' } },
    handoff: { action: 'PreparePartnerRideHandoff', parameters: { quote: 'quote', vehicleId: 'vehicleId' } },
  } },
};
const readScope = { objectTypes: [quote, handoff], linkTypes: [partnerRideLinks.handoff] };
const syntheticScope = { objectTypes: [trialQuote, order, payment], linkTypes: [partnerRideLinks.order, partnerRideLinks.payment] };

export const partnerRideLifecycle: Pick<OntologyDocument, 'objectTypes' | 'interfaceTypes' | 'linkTypes' | 'functionTypes' | 'actionTypes'> = {
  objectTypes: Object.entries(schemas).map<OntologyDocument['objectTypes'][number]>(([apiName, schema]) => ({
    apiName, displayName: apiName, description: 'Provider-specific ride evidence and its lifecycle records.',
    ...(synthetic.has(apiName) ? developmentOnly : {}),
    primaryKey: 'id', titleProperty: 'name', interfaces: apiName === quote ? quoteInterfaces : apiName === order ? orderInterfaces : {},
    properties: Object.fromEntries(Object.entries(schema.shape).map(([key, value]) => [key,
      { description: key, required: true, schema: json(value) }])),
  })),
  interfaceTypes: [{
    apiName: quoteInterface, description: 'Quote a partner ride and prepare the selected provider App handoff.',
    properties: {}, optionalProperties: [], links: {}, actions: {
      estimate: { parameters: json(partnerRideInputs.preparePartnerRideQuote), objectParameters: {}, required: true },
      handoff: { parameters: json(partnerRideInputs.preparePartnerRideHandoff), objectParameters: { quote: quoteInterface }, required: true },
    },
  }],
  linkTypes: [
    link(partnerRideLinks.handoff, quote, 'handoff', handoff, 'quote'),
    link(partnerRideLinks.order, trialQuote, 'order', order, 'quote'),
    link(partnerRideLinks.payment, order, 'payment', payment, 'order'),
  ],
  functionTypes: [...operations.map(({ fn, description, synthetic }) => ({
    apiName: fn, description, edits: true, parameters: json(partnerRideInputs[fn]), returns: json(ref),
    ...(synthetic ? developmentOnly : {}),
    dependencies: synthetic ? syntheticScope : {
      ...readScope, ...(fn === 'preparePartnerRideQuote' ? { functions: ['estimateUberRide', 'estimateGrabRide'] } : {}),
    },
  })), ...Object.entries(partnerRideReadbacks).map(([apiName, { parameters, result }]) => ({
    apiName, description: 'Read the original partner ride quote or App handoff record.',
    parameters: json(parameters), returns: json(result), dependencies: readScope,
  }))],
  actionTypes: operations.map(({ fn, action, description, objects, synthetic }) => ({
    apiName: action, description, parameters: json(partnerRideInputs[fn]), objectParameters: objects,
    function: fn, submissionCriteria: [], ...(synthetic ? developmentOnly : {}),
  })),
};

export const syntheticPartnerRideProcesses = {
  quote: trialQuote + 'StateLog',
  order: order + 'StateLog',
  payment: payment + 'StateLog',
} as const;

/** Save with the existing Automate save_rule operation before the synthetic trial starts. */
export const syntheticPartnerRideRules = [
  {
    name: 'Expire synthetic partner ride quotes', enabled: true,
    process: { type: syntheticPartnerRideProcesses.quote, from: null, to: 'available', dwellSeconds: partnerRideQuoteLifetimeSeconds },
    effect: { action: 'ExpireSyntheticPartnerRideQuote', input: { quote: { object: true } } },
  },
  {
    name: 'Observe synthetic partner ride order transitions', enabled: true,
    process: { type: syntheticPartnerRideProcesses.order },
    effect: { action: 'ObserveSyntheticPartnerRide', input: { order: { object: true } } },
  },
] as const;
