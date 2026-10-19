import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Node resolves transitive imports from real paths, so the cache must retain a node_modules directory. */
export function installReleaseDependencies(sourceRoot: string, runtime: string, release: string): string {
  const lockHash = createHash('sha256').update(readFileSync(join(sourceRoot, 'package-lock.json'))).digest('hex');
  const dependencies = join(runtime, 'dependency-cache-v2', lockHash, 'node_modules'), link = join(release, 'node_modules');
  let existing: ReturnType<typeof lstatSync> | undefined;
  try { existing = lstatSync(link); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  if (existing && (!existing.isSymbolicLink() || resolve(release, readlinkSync(link)) !== dependencies)) throw new Error('Release dependency link is not owned by this deployment');
  if (!existsSync(dependencies)) { mkdirSync(join(runtime, 'dependency-cache-v2', lockHash), { recursive: true, mode: 0o700 }); cpSync(join(sourceRoot, 'node_modules'), dependencies, { recursive: true }); }
  if (!existing) symlinkSync(dependencies, link);
  return dependencies;
}
