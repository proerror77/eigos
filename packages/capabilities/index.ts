import { configuredFlightradar24 } from './flight/flightradar24.js';
import { flightFunctions } from './flight/functions.js';
import { configuredVariFlight } from './flight/variflight.js';
import { calendarJourneyFunctions } from './journey/functions.js';
import { configuredAmap } from './amap/client.js';
import { amapFunctions } from './amap/functions.js';
import { resolveTaskLocation } from './location.js';
import { luckinFunctions } from './luckin/functions.js';
import { paotuiFunctions } from './meituan/paotui.js';
import { waimaiFunctions } from './meituan/waimai.js';
import {localEmbeddingVersion} from '../runtime/local-embeddings.js';
import {Ontology} from '../ontology/model.js';
import {applicationFunctions} from '../runtime/applications.js';
import type { RuntimeExtensions } from '../runtime/extensions.js';
import type { Database } from '../runtime/database.js';
import { businessDefinition } from '../ontology/definition.js';
import type { SourceResolver } from './didi/functions.js';
import { rideCapabilities } from './didi/pipeline.js';
import { schedulingFunctions } from './scheduling/functions.js';
import { serviceFunctions, serviceProjections } from './services/functions.js';
import { unavailableServices, type ServiceResolver } from './services/sources.js';
import type { Sources } from '../runtime/sources.js';
import { travelFunctions } from './travel/functions.js';
import { stripePaymentFunctions } from './payments/functions.js';
import { configuredStripeSandbox, type StripeSandboxResolver } from './payments/stripe-sandbox.js';

export function createCapabilities(
  db: Database,
  source: SourceResolver,
  extensions: RuntimeExtensions = {},
  services: ServiceResolver = unavailableServices,
  stripe: StripeSandboxResolver = configuredStripeSandbox(),
  connections: { paotui?: string; waimai?: string; amap?: string; amapFetch?: typeof fetch; variFlight?: string; variFlightFetch?: typeof fetch; fr24?: string; fr24Entrypoint?: string } = {},
) {
  let sources: Sources;
  const amap = configuredAmap(connections.amap, connections.amapFetch);
  const getFunctions = () => capabilities.functions;
  const handlers = new Map([
    ...schedulingFunctions(db),
    ...applicationFunctions(db),
    ...serviceFunctions(services, () => sources),
    ...travelFunctions(db, source, services, () => sources),
    ...calendarJourneyFunctions(db, getFunctions, amap),
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
    { ...extensions, functions: [localEmbeddingVersion, ...(extensions.functions ?? [])] }, serviceProjections(services));
  sources = capabilities.sources;
  return capabilities;
}
