import { constants, accessSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Config } from '../core/config.js';
import { runtimeAuthorityMatches } from '../core/runtime-authority.js';
import { CODEX_SECURITY_CHANNEL_ID } from '../capabilities/executor.js';
import { harnessSecurityChannel } from '../capabilities/harness-executor.js';
import { SecurityStore } from '../security/store.js';
import { currentKernelImplementation } from '../ontology/definition-store.js';

export function privateDeploymentFile(path: string): void {
  if (!isAbsolute(path)) throw new Error('Deployment files require absolute paths');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077)
    throw new Error('Deployment files must be owned private regular files');
}
export function resolveDeploymentBinary(name: string, path = process.env.PATH ?? ''): string {
  const candidates = isAbsolute(name) ? [name] : path.split(':').filter(isAbsolute).map(directory => join(directory, name));
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); if (lstatSync(realpathSync(candidate)).isFile()) return realpathSync(candidate); }
    catch { /* Try the next exact PATH entry. */ }
  }
  throw new Error('The configured model executable is unavailable');
}

/** Inspection never opens a writing store, migrates a schema, adopts an
 * authority, changes a policy or creates a missing membership database. */
export function assertPrimaryStores(config: Config, runtime: string, now = Date.now()): void {
  const authority = config.authority;
  if (!authority || config.EIGOS_SECURITY_MODE !== 'foundation' || config.EIGOS_AUTH_MODE !== 'jwt')
    throw new Error('Primary deployment requires its existing Foundation/JWT authority');
  for (const path of [authority.databasePath, authority.membershipDatabasePath]) {
    privateDeploymentFile(path);
    const within = relative(realpathSync(runtime), realpathSync(path));
    if (!within || within.startsWith('..') || isAbsolute(within)) throw new Error('Primary stores must live in the owned primary runtime');
  }
  const business = new DatabaseSync(authority.databasePath, { readOnly: true });
  try {
    if (!runtimeAuthorityMatches(business, authority)) throw new Error('The database does not match the reviewed runtime authority');
    const settings = business.prepare('SELECT mode,version FROM security_settings WHERE slot=1').get();
    if (settings?.mode !== 'foundation' || settings.version !== 2)
      throw new Error('The persisted business store is not Foundation');
    if (business.prepare('PRAGMA quick_check(1)').get()?.quick_check !== 'ok') throw new Error('Business database integrity check failed');
    const security = new SecurityStore(business, 'foundation', () => now, true, currentKernelImplementation());
    if (config.EIGOS_EXECUTOR !== 'disabled') {
      const id = config.EIGOS_EXECUTOR === 'harness' ? harnessSecurityChannel(config.EIGOS_HARNESS_CREDENTIAL_KIND) : CODEX_SECURITY_CHANNEL_ID;
      try { security.policies.modelChannel(id); }
      catch (error) { throw new Error('The selected model recipient has no current channel qualification', { cause: error }); }
    }
  } finally { business.close(); }
  const members = new DatabaseSync(authority.membershipDatabasePath, { readOnly: true });
  try {
    for (const name of ['members', 'agent_registrations']) if (!members.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))
      throw new Error('The existing membership store is incomplete');
    if (members.prepare('PRAGMA quick_check(1)').get()?.quick_check !== 'ok') throw new Error('Membership database integrity check failed');
  } finally { members.close(); }
}
