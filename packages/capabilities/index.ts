import { tableCheckReservationFunctions } from './dining/tablecheck-reservations.js';
import { restaurantFunctions } from './dining/restaurant-services.js';
import { scheduleJourneyFunctions } from './scheduling/schedule-journey.js';
import { itineraryContinuityFunctions } from './scheduling/itinerary-continuity.js';
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
import { configuredAmap, configuredAmapRide } from './amap/client.js';
import { amapRideFunctions } from './amap/ride.js';
import { withDidiPAReads } from './didi/pa-read.js';
import { amapFunctions } from './amap/functions.js';
import { amapObservationFunctions } from './amap/observations.js';
import { prepareMapCorrectionPrompt } from './amap/task-correction.js';
import { hotelTaskWorkflow, publicHotelTaskResult } from './services/hotel-workflows.js';
import { resolveTaskLocation } from './location.js';
import { luckinFunctions } from './luckin/functions.js';
import type { DeliveryConnectionPaths } from './local-delivery/mcp.js';
import { deliveryAddressFunctions } from './local-delivery/addresses.js';
import { savePersonalPlace } from './personal-places.js';
import { personalPlaceEdit } from '../ontology/personal-places.js';
import { localDeliveryFunctions } from './local-delivery/functions.js';
import { localDeliveryTradeFunctions } from './local-delivery/trade-functions.js';
import { marketplaceFunctions } from './marketplace/functions.js';
import { paotuiFunctions } from './meituan/paotui.js';
import { waimaiFunctions } from './meituan/waimai.js';
import {localEmbeddingVersion} from '../runtime/local-embeddings.js';
import {Ontology} from '../ontology/model.js';
import {applicationFunctions} from '../runtime/applications.js';
import type { RuntimeExtensions } from '../runtime/extensions.js';
import type { Database } from '../runtime/database.js';
import { hasBetaReadAccess } from '../runtime/accounts.js';
import { businessDefinition } from '../ontology/definition.js';
import type { SourceResolver } from './didi/functions.js';
import { closeRideWatchSchedule } from './didi/watch-schedule-status.js';
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
  amapFetch?: typeof fetch; amapRideFetch?: typeof fetch; variFlightFetch?: typeof fetch; calendarFetch?: typeof fetch; travelPAFetch?: typeof fetch;
  dianpingFetch?: typeof fetch; tableCheckFetch?: typeof fetch; meituanDiningFetch?: typeof fetch; marketplaceFetch?: typeof fetch; localDeliveryFetch?: typeof fetch;
};

export function configuredCapabilities(db: Database, config: ConnectionConfig, extensions: RuntimeExtensions,
  source = configuredSource(config.EIGOS_DIDI_CONNECTION_FILE, config.EIGOS_DIDI_WATCH_SANDBOX_CONNECTION_FILE),
  { marketplaceFetch, ...fetchers }: ProviderFetch = {}) {
  const eligible = (owner: string) => hasBetaReadAccess(db, owner);
  const trialUntil = config.EIGOS_BETA_FLYAI_TRIAL_UNTIL;
  const didi = config.EIGOS_DIDI_PA_READS_ENABLED === 'true'
    ? withDidiPAReads(source, config.EIGOS_DIDI_PA_ORDERS_ENABLED === 'true') : source;
  return createCapabilities(db, didi, extensions,
    configuredServices(config.EIGOS_SERVICE_CONNECTION_FILE, undefined, marketplaceFetch, config,
      trialUntil ? { eligible, trialUntil } : undefined),
    configuredStripeSandbox(config.EIGOS_STRIPE_SANDBOX_CONNECTION_FILE), {
      fliggyFlight: config.EIGOS_FLIGGY_FLIGHT_CONNECTION_FILE,
      fliggyHotel: config.EIGOS_FLIGGY_HOTEL_CONNECTION_FILE,
      paotui: config.EIGOS_PAOTUI_CONNECTION_FILE,
      waimai: config.EIGOS_WAIMAI_CONNECTION_FILE,
      localDelivery: {
        TaobaoInstantDelivery: config.EIGOS_TAOBAO_INSTANT_DELIVERY_CONNECTION_FILE,
        Hema: config.EIGOS_HEMA_CONNECTION_FILE,
      },
      amap: config.EIGOS_AMAP_CONNECTION_FILE,
      amapRide: config.EIGOS_AMAP_RIDE_CONNECTION_FILE,
      betaAmap: config.EIGOS_BETA_AMAP_CONNECTION_FILE ? { path: config.EIGOS_BETA_AMAP_CONNECTION_FILE, eligible } : undefined,
      xiaohongshu: config.EIGOS_XIAOHONGSHU_CONNECTION_FILE,
      variFlight: config.EIGOS_VARIFLIGHT_CONNECTION_FILE,
      dianping: config.EIGOS_DIANPING_CONNECTION_FILE,
      tableCheck: config.EIGOS_TABLECHECK_CONNECTION_FILE,
      meituanDining: config.EIGOS_MEITUAN_DINING_CONNECTION_FILE,
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
  connections: { paotui?: string; waimai?: string; localDelivery?: DeliveryConnectionPaths; localDeliveryFetch?: typeof fetch; amap?: string; amapFetch?: typeof fetch;
    amapRide?: string; amapRideFetch?: typeof fetch; betaAmap?: Parameters<typeof configuredAmap>[2]; variFlight?: string; variFlightFetch?: typeof fetch;
    fr24?: string; fr24Entrypoint?: string; calendar?: string; calendarFetch?: typeof fetch; travelPA?: string; travelPAFetch?: typeof fetch;
    xiaohongshu?: string; xiaohongshuFetch?: typeof fetch; dianping?: string; dianpingFetch?: typeof fetch; diningWeb?: string; diningMiniProgram?: string;
    tableCheck?: string; meituanDining?: string; tableCheckFetch?: typeof fetch; meituanDiningFetch?: typeof fetch;
    fliggyHotel?: string; fliggyHotelFetch?: typeof fetch; fliggyFlight?: string; fliggyFlightFetch?: typeof fetch } = {},
) {
  let sources: Sources;
  const amap = configuredAmap(connections.amap, connections.amapFetch);
  const sharedAmap = configuredAmap(connections.amap, connections.amapFetch, connections.betaAmap);
  const getFunctions = () => capabilities.functions;
  const notifications = configuredTravelNotifications(db, getFunctions, connections.travelPA, connections.travelPAFetch);
  const handlers = new Map([
    ...schedulingFunctions(db),
    ...itineraryContinuityFunctions(db, () => capabilities.actions),
    ...scheduleJourneyFunctions,
    ...transferDecisionFunctions(),
    ...diningResearch(connections.xiaohongshu, connections.xiaohongshuFetch),
    ...dianpingFunctions(connections.dianping, connections.dianpingFetch),
    ...restaurantFunctions(getFunctions, {
      tableCheck: connections.tableCheck, meituan: connections.meituanDining,
      tableCheckFetch: connections.tableCheckFetch, meituanFetch: connections.meituanDiningFetch,
      amapMock: Boolean(connections.amapFetch),
    }),
    ...tableCheckReservationFunctions(db, connections.tableCheck, connections.tableCheckFetch),
    ...diningReservationFunctions(db, connections.diningWeb, connections.diningMiniProgram),
    ...applicationFunctions(db),
    [registerDocumentFunction, registerSchedulePlanDocument],
    ...serviceFunctions(db, services, () => sources),
    ...marketplaceFunctions(services),
    [personalPlaceEdit, savePersonalPlace],
    ...deliveryAddressFunctions(connections.localDelivery ?? {}, connections.localDeliveryFetch),
    ...localDeliveryFunctions(connections.localDelivery ?? {}, connections.localDeliveryFetch),
    ...localDeliveryTradeFunctions(db, connections.localDelivery ?? {}, connections.localDeliveryFetch),
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
    ...amapFunctions(amap, sharedAmap),
    ...amapObservationFunctions(sharedAmap),
    ...amapRideFunctions(configuredAmapRide(connections.amapRide, connections.amapRideFetch), Boolean(connections.amapRideFetch)),
    ...luckinFunctions(),
    ['resolveTaskLocation', resolveTaskLocation],
  ]);
  const capabilities = rideCapabilities(db, source, handlers, new Ontology(businessDefinition).resolvedDocument.functionTypes,
    { functions: [localEmbeddingVersion, ...(extensions.functions ?? [])],
      effects: new Map([...(extensions.effects ?? []), ...notifications.handlers]), sources: extensions.sources },
    new Map([...serviceProjections(services), [transferObservationSource, transferObservationProjection]]), notifications.committed);
  sources = capabilities.sources;
  return { ...capabilities, scheduledTerminals: new Map([['CheckDidiRideWatch', closeRideWatchSchedule]]), evaluateRelease: evaluateCalendarJourneyRelease,
    scenarioDecisions: db.sandboxEnabled ? transferDecisionSupport(db) : undefined,
    taskWorkflow: hotelTaskWorkflow(capabilities.functions), taskPrompt: prepareMapCorrectionPrompt,
    projectTaskResult: publicHotelTaskResult };
}
