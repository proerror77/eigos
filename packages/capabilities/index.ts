import type { RuntimeExtensions } from '../runtime/extensions.js';
import type { Database } from '../runtime/database.js';
import { businessDefinition } from '../ontology/definition.js';
import type { SourceResolver } from './didi/functions.js';
import { rideCapabilities } from './didi/pipeline.js';
import { schedulingFunctions } from './scheduling/functions.js';

export function createCapabilities(db: Database, source: SourceResolver, extensions: RuntimeExtensions = {}) {
  return rideCapabilities(db, source, schedulingFunctions(db), businessDefinition.functionTypes, extensions);
}
