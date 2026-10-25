import { existsSync, readdirSync, rmSync, copyFileSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { syncOntology } from './ontology.mjs';
const root = process.cwd();
// TypeScript does not remove outputs for deleted sources. Prune only orphaned build files.
function prune(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) { prune(file); if (!readdirSync(file).length) rmSync(file, { recursive: true }); }
    else if (entry.name.endsWith('.js') && !existsSync(join(root, relative(resolve('dist'), file).replace(/\.js$/, '.ts')))) rmSync(file);
  }
}
if (existsSync('dist')) prune(resolve('dist'));
execFileSync(resolve('node_modules/.bin/tsc'), [], { stdio: 'inherit' });
copyFileSync(resolve('packages/security/baseline.json'), resolve('dist/packages/security/baseline.json'));
await syncOntology(root);
