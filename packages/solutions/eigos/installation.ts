import { businessDefinition } from './definition.js';
import { Ontology } from '../../ontology/model.js';
import { configuredCapabilities } from '../../capabilities/index.js';
import { connectionConfigSchema } from '../../core/config.js';
import { HarnessAgent } from '../../runtime/harness.js';
import { loadExtensions } from '../../runtime/extensions.js';
import { syncAccountGrantsAfterActivation } from '../../runtime/access.js';
import type { Installation } from '../../runtime/installation.js';

export async function eigosInstallation(): Promise<Installation> {
  const config = connectionConfigSchema.parse(process.env);
  const extensions = await loadExtensions(process.env.EIGOS_EXTENSION_MODULE);
  return {
    model: new Ontology(businessDefinition), afterActivation: syncAccountGrantsAfterActivation, runtimeId: core => core,
    assemble: db => configuredCapabilities(db, config, extensions),
    driver() {
      const binary = process.env.EIGOS_HARNESS_BIN, credentialFile = process.env.EIGOS_HARNESS_CREDENTIAL_FILE;
      if (!binary || !credentialFile) throw new Error('Worker requires its cloud model runtime and credential file');
      return new HarnessAgent({ binary, credentialFile, model: process.env.EIGOS_HARNESS_MODEL ?? 'gpt-6.1-sol',
        reasoningEffort: process.env.EIGOS_HARNESS_REASONING_EFFORT ?? 'low' });
    },
  };
}
