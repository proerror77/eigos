import { existsSync, readdirSync, rmSync, copyFileSync, mkdirSync } from 'node:fs';
import { resolve, join, relative, dirname } from 'node:path';
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
const { PA_SKILL_DIRECTORY, PA_SKILL_FILES } = await import('../dist/packages/members/pa-onboarding.js');
for (const name of PA_SKILL_FILES) {
  const destination = resolve('dist', PA_SKILL_DIRECTORY, name);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(resolve(PA_SKILL_DIRECTORY, name), destination);
}
copyFileSync(resolve('packages/security/baseline.json'), resolve('dist/packages/security/baseline.json'));
await syncOntology(root);
