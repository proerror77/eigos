import type { Installation, InstalledRuntime } from './installation.js';
import { implementationDigest } from './implementation.js';
import { Database } from './database.js';
import { Metadata } from './metadata.js';

export function openInstallation(installation: Installation) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const db = new Database(process.env.DATABASE_URL, process.env.EIGOS_PG_SCHEMA,
    installation.runtimeId(implementationDigest()), process.env.QUERY_DATABASE_URL);
  return { installation, db, metadata: new Metadata(db, installation.model.document.id) };
}

export async function checkInstallation(installation: Installation, metadata: Metadata, runtime: InstalledRuntime) {
  const active = await metadata.active();
  if (installation.expectedDefinition && active.digest !== installation.expectedDefinition)
    throw new Error('Activate the definition selected in the installation manifest before starting this role');
  metadata.checkBindings(active, runtime);
}
