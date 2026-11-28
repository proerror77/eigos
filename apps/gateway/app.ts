import { completeWithActionRequestSchema } from '../../packages/ontology/invocation.js';
import { SHOPIFY_AGENT_PROFILE_PATH, shopifyCatalogProfile } from '../../packages/capabilities/shopify/read-only.js';
import type { RuntimeExtensions } from '../../packages/runtime/extensions.js';
import { restaurantSearchInput, restaurantVenueType, restaurantVenueRecord, visitInput } from '../../packages/ontology/restaurant-services.js';
import { HotelWorkflows } from '../../packages/capabilities/services/hotel-workflows.js';
import { amendMapPlace } from '../../packages/capabilities/amap/task-correction.js';
import { configuredCapabilities } from '../../packages/capabilities/index.js';
import type { SourceResolver } from '../../packages/capabilities/didi/functions.js';
import { z } from 'zod';
import { Conflict, InvalidInput, PermissionDenied, requireScope, type Principal } from '../../packages/core/identity.js';
import type { Config } from '../../packages/core/config.js';
import { Access } from '../../packages/runtime/access.js';
import { Objects } from '../../packages/runtime/objects.js';
import type { Metadata, PublishedOntology } from '../../packages/runtime/metadata.js';
import type { Database } from '../../packages/runtime/database.js';
import { Tasks, taskPlaceAmendmentSchema, placeSelectionSchema, taskInputAnswerSchema, submitSchema, routeInputSchema } from '../../packages/runtime/tasks.js';
import { withoutExternalDispatch } from '../../packages/runtime/external-operations.js';
import { mountWorkbench } from './workbench.js';
import { mountAccountPortal, type auth0AccountLogin } from './account-portal.js';
import { auth0Management, type Auth0Management } from './auth0-management.js';
import { verifier, type VerifyToken } from './auth.js';
import { createHostApp, type BusinessAdapter, type HostAppOptions } from './host.js';
import { eigosAgentCard, mountA2AProtectedResourceMetadata } from './a2a-eigos.js';
import { mountBuilderMcp, registerConsumerMcpTools } from './mcp-consumer.js';

const rideQuoteRequestSchema = completeWithActionRequestSchema.pick({ requestId: true }).extend({
  ontology: z.literal('Eigos').optional(),
  action: z.strictObject({
    interface: z.strictObject({ type: z.literal('RideInquiry'), action: z.literal('estimate'), implementation: z.literal('RideRequest') }),
    input: routeInputSchema,
  }),
  read: z.strictObject({ function: z.literal('readRideEstimates'), resultParameter: z.literal('request') }),
});
const rideQuoteInstructions = 'For fare-only queries with a known city and confirmed pickup and destination, call complete_with_action directly in the current conversation and deliver the quote as soon as it returns. Pass the confirmed venue names. If the Action needs a more specific place, ask for it before retrying. Use submit_task for general or incomplete travel requests.';

const paTravelInstructions = [
  'For user-authorized travel reminders, keep the object reference from StartCalendarJourney or StartFlightWatch.',
  'Use your own PA notification capability and the channel selected by the user. EIGOS owns travel scheduling and computes notices.',
  'When EIGOS sends a travel_reminder event, use its authoritative reference, version, and operation. Keep only the newest version and withdraw pending notices on withdraw.',
  'Use readCalendarJourney, readFlightWatch or readDidiRideWatch via evaluate_ontology for independent readback with the original typed reference.',
  'If EIGOS requests calendar.journey.read, respond to the original taskId and requestId with only the required source fields.',
  'Withdraw pending notifications when the current reminder or alert is null. Discard expired calendar timing using validUntil.',
  'Report notification delivery only after your PA channel confirms it.',
].join(' ');

export function createApp(config: Config, db: Database, source: SourceResolver, verify: VerifyToken = verifier(config), extensions: RuntimeExtensions = {},
  providerFetch: { amapFetch?: typeof fetch; variFlightFetch?: typeof fetch; calendarFetch?: typeof fetch; travelPAFetch?: typeof fetch;
    dianpingFetch?: typeof fetch; tableCheckFetch?: typeof fetch; marketplaceFetch?: typeof fetch; localDeliveryFetch?: typeof fetch;
    accountLogin?: ReturnType<typeof auth0AccountLogin>; management?: Auth0Management } = {},
  options?: HostAppOptions) {
  const { accountLogin, management, ...fetchers } = providerFetch;
  const capabilities = configuredCapabilities(db, config, extensions, source, fetchers);
  const result = buildEigosApp(config, db, capabilities, verify, accountLogin, management, options);
  return { ...result, capabilities };
}

export function eigosApp(config: Config, db: Database, capabilities: import('../../packages/runtime/installation.js').InstalledRuntime,
  options?: HostAppOptions) {
  return buildEigosApp(config, db, capabilities, verifier(config), undefined, undefined, options);
}

function buildEigosApp(config: Config, db: Database, capabilities: import('../../packages/runtime/installation.js').InstalledRuntime,
  verify = verifier(config), accountLogin?: ReturnType<typeof auth0AccountLogin>, management?: Auth0Management, options?: HostAppOptions) {
  const amendPlace = (tasks: Tasks, metadata: Metadata, p: Principal, id: string, raw: unknown) => {
    const input = taskPlaceAmendmentSchema.parse(raw);
    return 'source' in input ? amendMapPlace(tasks, metadata, capabilities.functions, p, id, input) : tasks.amendPlace(p, id, input);
  };
  const adapter: BusinessAdapter = {
    instructions(member, quoteOnly) {
      const taskInstructions = member ? `The five shared Beta queries are ready without supplier setup. Discover authorized business Actions with describe_ontology. Keep the original task ID. When it is waiting for your PA, use respond_to_task with its exact request ID and response schema. For didi.authorize, check the user's own DiDi MCP connection. If it is missing, present input.authorizationUrl as a clickable link and keep the original request pending until the user returns. Keep all supplier keys in the PA's private configuration. For didi.read, use the requested tool and return the normalized observation and receipt. For ride.confirm_immediate_order, get human confirmation of the exact current fare and vehicle. For didi.place_order, use the PA's durable DiDi runner for the approved request. Present pa_reported results as received by the PA. ${paTravelInstructions}` : paTravelInstructions;
      return [quoteOnly ? rideQuoteInstructions : '', taskInstructions].filter(Boolean).join(' ');
    },
    card: eigosAgentCard(config.PUBLIC_URL, capabilities),
    profile(app) {
      app.get(SHOPIFY_AGENT_PROFILE_PATH, (_req, res) => res.json(shopifyCatalogProfile()));
      mountA2AProtectedResourceMetadata(app, config);
    },
    mountPortal: (app, members) => mountAccountPortal(app, config, members, accountLogin, management ?? auth0Management(config)),
    mountWorkbench: app => mountWorkbench(app, config, verify),
    submitDescription: 'Submit a natural-language goal. To batch rapid messages, pass the same conversationId from your chat host and a distinct, stable requestId per message. Set learnHotelWorkflow when asked to learn and save a hotel itinerary, or replayHotelWorkflow with a saved ID and new date when asked to reuse one. Forward the goal without proposing tool steps. PA information requests resume on the original task.',
    validateQuote(model, selected) {
      const action = model.action(selected);
      if (selected !== 'EstimateRide' || action.function !== 'prepareRideInquiry' || action.rules?.length || action.effects?.length)
        throw new PermissionDenied('The published quote-only Action is unavailable');
    },
    taskRead: name => ['readCalendarJourney', 'readFlightWatch', 'readDidiRideWatch'].includes(name),
    mountTasks(app, tasks, metadata, principal, publicTask) {
      const hotelWorkflows = new HotelWorkflows(db, metadata, capabilities.functions);
      app.post('/tasks/:id/hotel-simulation-approval', async (req, res) => {
        res.json(await hotelWorkflows.approve(principal(req), { ...req.body, taskId: req.params.id }));
      });
      app.post('/tasks/:id/places', async (req, res) => res.json(publicTask(await tasks.selectPlaces(principal(req), String(req.params.id), req.body))));
      app.post('/tasks/:id/input', async (req, res) =>
        res.json(publicTask(await tasks.answerInput(principal(req), String(req.params.id), req.body))));
      app.post('/tasks/:id/place-amendment', async (req, res) =>
        res.json(publicTask(await amendPlace(tasks, metadata, principal(req), String(req.params.id), req.body))));
      mountBuilderMcp(app, config, db, metadata, capabilities, principal);
    },
    registerTools({ server, tasks, metadata, p, member, quoteOnly, response, publicTask, authorize, completeQuote }) {
      if (quoteOnly) server.registerTool('complete_with_action', {
        description: 'Return a DiDi fare estimate in one call when both venues and the city are known. This call uses RideInquiry.estimate and reads its verified result.',
        inputSchema: rideQuoteRequestSchema,
      }, input => response(() => completeQuote(input)));
      if (member) {
        registerConsumerMcpTools({ server, db, tasks, metadata, capabilities, p, response, authorize, publicTask });
        server.registerTool('select_task_places', {
          description: 'Confirm the original task’s current place candidates after the user has reviewed them.',
          inputSchema: z.strictObject({ taskId: z.uuid(), places: placeSelectionSchema }),
        }, ({ taskId, places }) => response(async () => publicTask(await tasks.selectPlaces(p, taskId, places))));
        server.registerTool('supply_task_input', {
          description: 'Supply a requested city or endpoint, or retry a supplier read when the original task permits it.',
          inputSchema: z.strictObject({ taskId: z.uuid(), answer: taskInputAnswerSchema }),
        }, ({ taskId, answer }) => response(async () => publicTask(await tasks.answerInput(p, taskId, answer))));
      } else {
        const hotelWorkflows = new HotelWorkflows(db, metadata, capabilities.functions);
        server.registerTool('list_learned_hotel_workflows', {
          description: 'Find previously saved hotel itinerary workflows for the signed-in owner. To reuse, submit a task with the workflow ID and the new check-in date. Every proposal needs separate approval in EIGOS.',
          inputSchema: z.strictObject({}),
        }, () => response(() => hotelWorkflows.list(p)));
        server.registerTool('select_task_places', { description: 'Confirm endpoints from the original task’s current candidates. Present their formal names and addresses to the user. A PA may select a previously confirmed address; if uncertain it must ask the user.', inputSchema: z.strictObject({ taskId: z.uuid(), places: placeSelectionSchema }) }, input => response(async () => publicTask(await tasks.selectPlaces(p, input.taskId, input.places))));
        server.registerTool('supply_task_input', {
          description: 'Supply the city, pickup or destination requested by the original Action. Retry only when the task explicitly returns retry-source.',
          inputSchema: z.strictObject({ taskId: z.uuid(), answer: taskInputAnswerSchema }),
        }, input => response(async () => publicTask(await tasks.answerInput(p, input.taskId, input.answer))));
        server.registerTool('amend_task_place', {
          description: 'Continue the original task with a user-confirmed endpoint. For ride Actions use an address or landmark and pass keep if the unchanged side has multiple candidates. For an older Amap clarification use the confirmed Amap place ID, a fresh request ID and the original task updatedAt. Restore a canceled task only with specific user authorization.',
          inputSchema: z.strictObject({ taskId: z.uuid(), amendment: taskPlaceAmendmentSchema }),
        }, input => response(async () => publicTask(await amendPlace(tasks, metadata, p, input.taskId, input.amendment))));
      }
      const restaurantAccess = async (provider: 'Amap' | 'TableCheck') => {
        requireScope(p, 'tasks:read');
        requireScope(p, 'tasks:write');
        const access = await Access.load(db, p), model = await metadata.active('Eigos');
        access.source(model, provider);
        return { access, model };
      };
      const completeRestaurantRead = async (access: Access, model: PublishedOntology, requestId: string,
        operation: 'search' | 'availability', input: Record<string, unknown>) => {
        const contract = operation === 'search'
          ? { type: 'RestaurantDiscovery', action: 'search', implementation: 'RestaurantSearchResult',
              actionName: 'FindRestaurants', function: 'findRestaurants', read: 'readRestaurantSearch', resultParameter: 'search' }
          : { type: 'RestaurantVisitReview', action: 'review', implementation: 'RestaurantVisitOption',
              actionName: 'ReviewRestaurantVisit', function: 'reviewRestaurantVisit', read: 'readRestaurantVisit', resultParameter: 'visit' };
        const { type, action, implementation } = contract;
        const selected = capabilities.actions.resolve(access, model, { interface: { type, action, implementation }, input });
        const definition = model.action(selected.action);
        if (selected.action !== contract.actionName || definition.function !== contract.function || definition.effects?.length)
          throw new Conflict('The published restaurant query is unavailable');
        const result = await withoutExternalDispatch(() => capabilities.actions.complete(access, model, selected, requestId,
          { function: contract.read, resultParameter: contract.resultParameter }, undefined, AbortSignal.timeout(30000),
          member ? { authorize: authorize } : {}));
        if (!await access.canReturn(access.dataRequirements())) throw new PermissionDenied('Result permissions changed');
        return result;
      };
      server.registerTool('search_restaurants', {
        description: member ? 'Find Amap restaurant listings and addresses by city and keyword.' :
          'Find Amap restaurant listings or TableCheck venues by city and keyword. Amap is the default. Preserve the returned TableCheck venue ID for an availability query.',
        inputSchema: restaurantSearchInput.pick({ city: true, query: true, limit: true })
          .extend({ requestId: submitSchema.shape.requestId, provider: (member ? z.literal('Amap') : z.enum(['Amap', 'TableCheck'])).optional() }),
      }, ({ requestId, provider = 'Amap', ...input }) => response(async () => {
        const { access, model } = await restaurantAccess(provider);
        if (provider === 'Amap') access.function(model, 'searchMapPlaces');
        return completeRestaurantRead(access, model, requestId, 'search', { ...input, providers: [provider] });
      }));
      if (!member) server.registerTool('check_restaurant_availability', {
        description: 'Read TableCheck availability for a venue returned by search_restaurants, on an exact local date and for a specified party size. Reuse the same request ID to read the original result.',
        inputSchema: visitInput.pick({ date: true, partySize: true })
          .extend({ venueId: z.string().regex(/^[a-f0-9]{64}$/), requestId: submitSchema.shape.requestId }),
      }, ({ requestId, venueId, ...input }) => response(async () => {
        const { access, model } = await restaurantAccess('TableCheck');
        const venue = { type: restaurantVenueType, id: venueId };
        const snapshot = await new Objects(db, model, access).read(venue);
        if (restaurantVenueRecord.parse(snapshot.properties).provider !== 'TableCheck')
          throw new InvalidInput('Use the venue ID returned from a TableCheck search');
        return completeRestaurantRead(access, model, requestId, 'availability', { ...input, venue, channel: 'provider' });
      }));
    },
  };
  return createHostApp(config, db, capabilities, 'Eigos', verify, adapter, options);
}
