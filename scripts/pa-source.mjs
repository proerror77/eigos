import { readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// An alternate checkout must belong to the existing runtime's owning repository.
// This selects build inputs; it never changes the runtime owner or credentials.
export function resolvePaOwner(sourceRoot, requestedOwner, ownershipFile) {
  if (!requestedOwner) return sourceRoot;
  try {
    const owner = realpathSync(requestedOwner), recorded = JSON.parse(readFileSync(ownershipFile, 'utf8'));
    if (realpathSync(recorded.sourceRoot) !== owner) throw new Error();
    const common = cwd => realpathSync(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    if (common(sourceRoot) !== common(owner)) throw new Error();
    return recorded.sourceRoot;
  } catch { throw new Error('Alternate PA build source must be a worktree of the existing runtime owner'); }
}
