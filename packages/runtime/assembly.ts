import type { Ontology } from '../ontology/model.js';
import type { OntologyDocument } from '../ontology/schema.js';
import { Actions, type CommittedEffects } from './actions.js';
import { ComponentFunctions } from './component-functions.js';
import { configuredComponentSources } from './component-source-egress.js';
import type { Database } from './database.js';
import { Effects } from './effects.js';
import type { RuntimeExtensions } from './extensions.js';
import { Functions, type FunctionHandler } from './functions.js';
import { ProviderBudgets } from './provider-budgets.js';
import { Sources, type SourceProjection } from './sources.js';

export function assembleRuntime(
  db: Database, definitions: OntologyDocument['functionTypes'], handlers: ReadonlyMap<string, FunctionHandler>,
  projections: ReadonlyMap<string, SourceProjection> = new Map(), extensions: RuntimeExtensions = {},
  committedEffects?: CommittedEffects,
) {
  const registered = new Map(projections);
  for (const [name, projection] of extensions.sources ?? []) {
    if (registered.has(name)) throw new Error('Source projection is already registered: ' + name);
    registered.set(name, projection);
  }
  const functions = new Functions(handlers, definitions, extensions.functions, new ComponentFunctions(db, undefined, extensions.componentSources ?? configuredComponentSources()), new ProviderBudgets(db));
  const sources = new Sources(db, functions, registered);
  const effects = new Effects(db, extensions.effects ?? new Map());
  const actions = new Actions(db, functions, effects, committedEffects);
  return {
    functions, sources, effects, actions,
    describe(model: Ontology) {
      effects.check(model.resolvedDocument.actionTypes.flatMap(action => action.effects?.map(effect => effect.handler) ?? []));
      return { functions: functions.bindings(model), sources: sources.bindings(model) };
    },
    checkRelease: (model: Ontology) => functions.checkRelease(model),
  };
}
