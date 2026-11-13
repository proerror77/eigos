import {localEmbeddingVersion} from '../runtime/local-embeddings.js';
import {Ontology} from '../ontology/model.js';
import {applicationFunctions} from '../runtime/applications.js';
import type { RuntimeExtensions } from '../runtime/extensions.js';
import type { Database } from '../runtime/database.js';
import { businessDefinition } from '../ontology/definition.js';
import type { SourceResolver } from './didi/functions.js';
import { rideCapabilities } from './didi/pipeline.js';
import { schedulingFunctions } from './scheduling/functions.js';

export function createCapabilities(db: Database, source: SourceResolver, extensions: RuntimeExtensions = {}) {
  return rideCapabilities(db, source, new Map([...schedulingFunctions(db),...applicationFunctions(db)]), new Ontology(businessDefinition).resolvedDocument.functionTypes, {...extensions,functions:[localEmbeddingVersion,...(extensions.functions??[])]});
}
