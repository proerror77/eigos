import type { Database } from '../runtime/database.js';
import { businessDefinition } from '../ontology/definition.js';
import type { SourceResolver } from './didi/functions.js';
import { rideCapabilities } from './didi/pipeline.js';
import { schedulingFunctions } from './scheduling/functions.js';
import { serviceFunctions, serviceProjections } from './services/functions.js';
import { unavailableServices, type ServiceResolver } from './services/sources.js';
import type { Sources } from '../runtime/sources.js';
import { travelFunctions } from './travel/functions.js';

export function createCapabilities(db: Database, source: SourceResolver, services: ServiceResolver = unavailableServices) {
  let sources: Sources;
  const capabilities = rideCapabilities(db, source, new Map([...schedulingFunctions(db), ...serviceFunctions(services, () => sources), ...travelFunctions(db,source,services,()=>sources)]), businessDefinition.functionTypes, serviceProjections(services));
  sources = capabilities.sources;
  return capabilities;
}
