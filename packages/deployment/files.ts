import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Keep runtime source assets in the same immutable manifest as emitted code. */
export function releaseFiles(root: string): string[] {
  const scan = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return scan(path);
    if (!entry.isFile() || (!entry.name.endsWith('.ts') && !entry.name.endsWith('.json'))) return [];
    return ['dist/' + relative(root, path).replace(/\.ts$/, '.js')];
  });
  return [...scan(join(root, 'apps')), ...scan(join(root, 'packages'))].sort()
    .concat(['scripts/run-local.mjs', 'scripts/agent-request.mjs', 'scripts/agent-enroll.mjs',
      'integrations/grok/eigos-native/client.mjs', 'integrations/grok/eigos-delegate/scripts/eigos_a2a.py', 'package.json', 'package-lock.json']);
}
