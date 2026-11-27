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
import type { PublishedOntology } from '../../packages/runtime/metadata.js';
import type { Database } from '../../packages/runtime/database.js';
import { submitSchema } from '../../packages/runtime/tasks.js';
import { withoutExternalDispatch } from '../../packages/runtime/external-operations.js';
import { mountWorkbench } from './workbench.js';
import { mountAccountPortal, type auth0AccountLogin } from './account-portal.js';
import { auth0Management, type Auth0Management } from './auth0-management.js';
import { verifier, type VerifyToken } from './auth.js';
import { createHostApp, type BusinessAdapter } from './host.js';
import { agentCard } from './a2a.js';

export function createApp(config: Config, db: Database, source: SourceResolver, verify: VerifyToken = verifier(config), extensions: RuntimeExtensions = {},
  providerFetch: { amapFetch?: typeof fetch; variFlightFetch?: typeof fetch; calendarFetch?: typeof fetch; travelPAFetch?: typeof fetch;
    dianpingFetch?: typeof fetch; tableCheckFetch?: typeof fetch; marketplaceFetch?: typeof fetch; localDeliveryFetch?: typeof fetch;
    accountLogin?: ReturnType<typeof auth0AccountLogin>; management?: Auth0Management } = {}) {
  const { accountLogin, management, ...fetchers } = providerFetch;
  const capabilities = configuredCapabilities(db, config, extensions, source, fetchers);
  const result = eigosApp(config, db, capabilities, verify, accountLogin, management);
  return { ...result, capabilities };
}

export function eigosApp(config: Config, db: Database, capabilities: import('../../packages/runtime/installation.js').InstalledRuntime,
  verify = verifier(config), accountLogin?: ReturnType<typeof auth0AccountLogin>, management?: Auth0Management) {
  const adapter: BusinessAdapter = {
    card: agentCard(config.PUBLIC_URL),
    profile(app) { app.get(SHOPIFY_AGENT_PROFILE_PATH, (_req, res) => res.json(shopifyCatalogProfile())); },
    mountPortal: (app, members) => mountAccountPortal(app, config, members, accountLogin, management ?? auth0Management(config)),
    mountWorkbench: app => mountWorkbench(app, config, verify),
    hotels: (metadata) => new HotelWorkflows(db, metadata, capabilities.functions),
    amend: (tasks, metadata, principal, id, input) => amendMapPlace(tasks, metadata, capabilities.functions, principal, id, input),
    restaurants(server, metadata, p, member, response, authorize) {
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
  return createHostApp(config, db, capabilities, 'Eigos', verify, adapter);
}
