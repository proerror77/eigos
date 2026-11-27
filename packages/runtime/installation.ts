import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { digest } from '../core/identity.js';
import { Ontology } from '../ontology/model.js';
import { ontologyPackageSchema } from './ontology-packages.js';
import { assembleRuntime } from './assembly.js';
import type { Database } from './database.js';
import type { FunctionHandler } from './functions.js';
import type { RuntimeExtensions } from './extensions.js';
import type { AgentDriver, Capabilities } from './agent.js';
import type { ScheduleTerminal } from './scheduled-actions.js';
import type { TaskResultProjection } from './tasks.js';
import type { ScenarioDecisionSupport } from './scenarios.js';
import { PARequests } from './pa.js';

export interface InstalledRuntime extends Capabilities {
  registerServices?: import('./services.js').RegisterServices;
  effects: ReturnType<typeof assembleRuntime>['effects'];
  projectTaskResult: TaskResultProjection;
  scheduledTerminals?: ReadonlyMap<string, ScheduleTerminal>;
  scenarioDecisions?: ScenarioDecisionSupport;
}

export interface Installation {
  model: Ontology;
  /** Includes the identity of the implementation actually loaded by every role. */
  runtimeId(core: string): string;
  assemble(db: Database): InstalledRuntime;
  afterActivation?(db: Database, model: Ontology): Promise<void>;
  driver(): AgentDriver;
}
const file = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
export const installationManifest = z.strictObject({
  format: z.literal('ontology-installation-v1'),
  definition: file,
  definitionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  implementation: z.strictObject({ file, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
});
export interface Registration extends RuntimeExtensions {
  handlers?: ReadonlyMap<string, FunctionHandler>;
  driver?: () => AgentDriver;
}
export const deterministicDriver: AgentDriver = {
  model: 'unconfigured', async run() { throw new Error('This installation requires an AgentDriver for model tasks'); },
};

/** The manifest is selected by the operator. Modules are trusted, self-contained deployment artifacts. */
export async function loadInstallation(path: string): Promise<Installation> {
  if (!isAbsolute(path)) throw new Error('Use an absolute installation manifest path');
  const manifest = installationManifest.parse(JSON.parse(await readFile(path, 'utf8')));
  const root = dirname(path);
  const bundle = ontologyPackageSchema.parse(JSON.parse(await readFile(resolve(root, manifest.definition), 'utf8')));
  const model = new Ontology(bundle.document);
  if (bundle.ontology !== model.document.id || bundle.version !== model.document.version ||
      bundle.digest !== model.digest || manifest.definitionDigest !== model.digest)
    throw new Error('Ontology package identity differs from its manifest');
  let registration: Registration = {};
  if (manifest.implementation) {
    const bytes = await readFile(resolve(root, manifest.implementation.file));
    if (createHash('sha256').update(bytes).digest('hex') !== manifest.implementation.sha256)
      throw new Error('Implementation digest differs from its manifest');
    const module = await import('data:text/javascript;base64,' + bytes.toString('base64'));
    if (typeof module.register !== 'function') throw new Error('Implementation must export register');
    registration = await module.register({ PARequests });
  }
  return {
    model, runtimeId: core => digest([core, manifest.implementation?.sha256 ?? null]),
    assemble: db => ({ ...assembleRuntime(db, model.resolvedDocument.functionTypes, registration.handlers ?? new Map(),
      undefined, registration), projectTaskResult: result => result }),
    driver: registration.driver ?? (() => deterministicDriver),
  };
}
