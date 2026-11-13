import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { VersionedFunction } from './functions.js';
import type { EffectHandler } from './effects.js';

export interface RuntimeExtensions { functions?: readonly VersionedFunction[]; effects?: ReadonlyMap<string,EffectHandler> }
/** Operator-configured, trusted deployment code. Never accepts a request-supplied module path. */
export async function loadExtensions(path?: string): Promise<RuntimeExtensions> {
  if (!path) return {};
  if (!isAbsolute(path)) throw new Error('Extension module requires an absolute deployment path');
  const module=await import(pathToFileURL(path).href);
  if (module.functions !== undefined && !Array.isArray(module.functions)) throw new Error('Extension functions must be a version registry');
  if (module.effects !== undefined && !(module.effects instanceof Map)) throw new Error('Extension effects must be a named handler Map');
  for (const handler of module.effects?.values() ?? []) if(typeof handler!=='function')throw new Error('Invalid effect handler');
  return {functions:module.functions,effects:module.effects};
}
