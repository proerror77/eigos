import { fliggyHandoffFunctions } from './fliggy/travel-handoff.js';
import { configuredSource, type ConnectionConfig } from '../core/config.js';
import { evaluateCalendarJourneyRelease } from './journey/release-checks.js';
import { registerDocumentFunction } from '../ontology/documents.js';
import { registerSchedulePlanDocument } from './documents.js';
import { dianpingFunctions } from './dining/dianping.js';
import { diningResearch } from './dining/research.js';
import { diningReservationFunctions } from './dining/reservations.js';
import { configuredFlightradar24 } from './flight/flightradar24.js';
import { fliggyHotelFunctions } from './fliggy/hotel-booking.js';
import { fliggyFlightBookingFunctions } from './fliggy/flight-booking.js';
import { configuredFliggyFlight, configuredFliggyHotel } from './fliggy/top.js';
import { flightFunctions } from './flight/functions.js';
import { configuredVariFlight } from './flight/variflight.js';
import { calendarJourneyFunctions } from './journey/functions.js';
import { configuredJourneyCalendar } from './journey/calendar-source.js';
import { configuredTravelNotifications } from './pa/travel-notifications.js';
import { configuredAmap } from './amap/client.js';
import { amapFunctions } from './amap/functions.js';
import { prepareMapCorrectionPrompt } from './amap/task-correction.js';
import { hotelTaskWorkflow, publicHotelTaskResult } from './services/hotel-workflows.js';
import { resolveTaskLocation } from './location.js';
import { luckinFunctions } from './luckin/functions.js';
import { marketplaceFunctions } from './marketplace/functions.js';
import { paotuiFunctions } from './meituan/paotui.js';
import { waimaiFunctions } from './meituan/waimai.js';
import {localEmbeddingVersion} from '../runtime/local-embeddings.js';
import {Ontology} from '../ontology/model.js';
import {applicationFunctions} from '../runtime/applications.js';
import type { RuntimeExtensions } from '../runtime/extensions.js';
import type { Database } from '../runtime/database.js';
import { businessDefinition } from '../ontology/definition.js';
import type { SourceResolver } from './didi/functions.js';
import { didiRideWatchFunctions } from './didi/ride-watch.js';
import { petRideFunctions } from './didi/pet-ride.js';
import { rideCapabilities } from './didi/pipeline.js';
import { schedulingFunctions } from './scheduling/functions.js';
import { transferDecisionFunctions, transferDecisionSupport, transferObservationProjection } from './scheduling/transfer-decisions.js';
import { transferObservationSource } from '../ontology/hotel-transfer-decisions.js';
import { serviceFunctions, serviceProjections } from './services/functions.js';
import { configuredServices, unavailableServices, type ServiceResolver } from './services/sources.js';
import type { Sources } from '../runtime/sources.js';
import { travelFunctions } from './travel/functions.js';
import { stripePaymentFunctions } from './payments/functions.js';
import { configuredStripeSandbox, type StripeSandboxResolver } from './payments/stripe-sandbox.js';

type ProviderFetch = {
  amapFetch?: typeof fetch; variFlightFetch?: typeof fetch; calendarFetch?: typeof fetch; travelPAFetch?: typeof fetch;
  dianpingFetch?: typeof fetch; marketplaceFetch?: typeof fetch;
};

export function configuredCapabilities(db: Database, config: ConnectionConfig, extensions: RuntimeExtensions,
  source = configuredSource(config.EIGOS_DIDI_CONNECTION_FILE, config.EIGOS_DIDI_WATCH_SANDBOX_CONNECTION_FILE),
  { marketplaceFetch, ...fetchers }: ProviderFetch = {}) {
  return createCapabilities(db, source, extensions,
    configuredServices(config.EIGOS_SERVICE_CONNECTION_FILE, undefined, marketplaceFetch),
    configuredStripeSandbox(config.EIGOS_STRIPE_SANDBOX_CONNECTION_FILE), {
      fliggyFlight: config.EIGOS_FLIGGY_FLIGHT_CONNECTION_FILE,
      fliggyHotel: config.EIGOS_FLIGGY_HOTEL_CONNECTION_FILE,
      paotui: config.EIGOS_PAOTUI_CONNECTION_FILE,
      waimai: config.EIGOS_WAIMAI_CONNECTION_FILE,
      amap: config.EIGOS_AMAP_CONNECTION_FILE,
      xiaohongshu: config.EIGOS_XIAOHONGSHU_CONNECTION_FILE,
      variFlight: config.EIGOS_VARIFLIGHT_CONNECTION_FILE,
      dianping: config.EIGOS_DIANPING_CONNECTION_FILE,
      diningWeb: config.EIGOS_DINING_WEB_CONNECTION_FILE,
      diningMiniProgram: config.EIGOS_DINING_MINIPROGRAM_CONNECTION_FILE,
      fr24: config.EIGOS_FR24_CONNECTION_FILE,
      fr24Entrypoint: config.EIGOS_FR24_MCP_ENTRYPOINT,
      calendar: config.EIGOS_JOURNEY_CALENDAR_CONNECTION_FILE,
      travelPA: config.EIGOS_TRAVEL_PA_CONNECTION_FILE,
      ...fetchers,
    });
}

export function createCapabilities(
  db: Database,
  source: SourceResolver,
  extensions: RuntimeExtensions = {},
  services: ServiceResolver = unavailableServices,
  stripe: StripeSandboxResolver = configuredStripeSandbox(),
  connections: { paotui?: string; waimai?: string; amap?: string; amapFetch?: typeof fetch; variFlight?: string; variFlightFetch?: typeof fetch;
    fr24?: string; fr24Entrypoint?: string; calendar?: string; calendarFetch?: typeof fetch; travelPA?: string; travelPAFetch?: typeof fetch;
    xiaohongshu?: string; xiaohongshuFetch?: typeof fetch; dianping?: string; dianpingFetch?: typeof fetch; diningWeb?: string; diningMiniProgram?: string;
    fliggyHotel?: string; fliggyHotelFetch?: typeof fetch; fliggyFlight?: string; fliggyFlightFetch?: typeof fetch } = {},
) {
  let sources: Sources;
  const amap = configuredAmap(connections.amap, connections.amapFetch);
  const getFunctions = () => capabilities.functions;
  const notifications = configuredTravelNotifications(db, getFunctions, connections.travelPA, connections.travelPAFetch);
  const handlers = new Map([
    ...schedulingFunctions(db),
    ...transferDecisionFunctions(),
    ...diningResearch(connections.xiaohongshu, connections.xiaohongshuFetch),
    ...dianpingFunctions(connections.dianping, connections.dianpingFetch),
    ...diningReservationFunctions(db, connections.diningWeb, connections.diningMiniProgram),
    ...applicationFunctions(db),
    [registerDocumentFunction, registerSchedulePlanDocument],
    ...serviceFunctions(db, services, () => sources),
    ...marketplaceFunctions(services),
    ...fliggyHandoffFunctions(services),
    ...fliggyFlightBookingFunctions(db, configuredFliggyFlight(connections.fliggyFlight, connections.fliggyFlightFetch)),
    ...fliggyHotelFunctions(db, configuredFliggyHotel(connections.fliggyHotel, connections.fliggyHotelFetch)),
    ...travelFunctions(db, source, services, () => sources),
    ...didiRideWatchFunctions(db, source),
    ...petRideFunctions(db),
    ...calendarJourneyFunctions(db, getFunctions, amap, configuredJourneyCalendar(connections.calendar, connections.calendarFetch)),
    ...flightFunctions(db, getFunctions, configuredVariFlight(connections.variFlight, connections.variFlightFetch),
      configuredFlightradar24(connections.fr24, connections.fr24Entrypoint)),
    ...stripePaymentFunctions(db, stripe),
    ...paotuiFunctions(connections.paotui),
    ...waimaiFunctions(connections.waimai, fetch, connections.amap ? amap : undefined),
    ...amapFunctions(amap),
    ...luckinFunctions(),
    ['resolveTaskLocation', resolveTaskLocation],
  ]);
  const capabilities = rideCapabilities(db, source, handlers, new Ontology(businessDefinition).resolvedDocument.functionTypes,
    { functions: [localEmbeddingVersion, ...(extensions.functions ?? [])],
      effects: new Map([...(extensions.effects ?? []), ...notifications.handlers]) },
    new Map([...serviceProjections(services), [transferObservationSource, transferObservationProjection]]), notifications.committed);
  sources = capabilities.sources;
  return { ...capabilities, evaluateRelease: evaluateCalendarJourneyRelease,
    scenarioDecisions: db.sandboxEnabled ? transferDecisionSupport(db) : undefined,
    taskWorkflow: hotelTaskWorkflow(capabilities.functions), taskPrompt: prepareMapCorrectionPrompt,
    projectTaskResult: publicHotelTaskResult };
}
