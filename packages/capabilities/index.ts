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

export function createCapabilities(db: Database, source: SourceResolver, extensions: RuntimeExtensions = {}, services: ServiceResolver = unavailableServices, stripe: StripeSandboxResolver = configuredStripeSandbox()) {
  let sources: Sources;
  const capabilities = rideCapabilities(db, source,
    new Map([...schedulingFunctions(db), ...applicationFunctions(db), ...serviceFunctions(services, () => sources), ...travelFunctions(db, source, services, () => sources), ...stripePaymentFunctions(db, stripe)]),
    new Ontology(businessDefinition).resolvedDocument.functionTypes,
    {...extensions, functions: [localEmbeddingVersion, ...(extensions.functions ?? [])]}, serviceProjections(services));
  sources = capabilities.sources;
  return capabilities;
}
