import { historicalAgentSandboxResources, sandboxAgentCapability } from './agent-profiles.js';
import type { Ontology } from './model.js';

const sandboxActions = new Set(historicalAgentSandboxResources.actions);
const sandboxFunctions = new Set(historicalAgentSandboxResources.actions.map(name => name[0]!.toLowerCase() + name.slice(1)));
sandboxFunctions.add('readDiningReservation');
const sandboxObjects = new Set(historicalAgentSandboxResources.objects);

/** Published tags carry forward through resource renames. API names protect older definitions. */
export function isSandboxResource(model: Ontology, kind: string, name: string): boolean {
  const definition = kind === 'action' ? model.actions.get(name)
    : kind === 'function' ? model.functions.get(name) : kind === 'object' ? model.objects.get(name) : undefined;
  if (definition?.typeClasses?.some(tag => tag.kind === sandboxAgentCapability.kind && tag.name === sandboxAgentCapability.name))
    return true;
  if (kind === 'action') {
    const backing = model.actions.get(name)?.function;
    return sandboxActions.has(name) || Boolean(backing && isSandboxResource(model, 'function', backing));
  }
  return kind === 'function' ? sandboxFunctions.has(name) : kind === 'object' && sandboxObjects.has(name);
}
