import { rmSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
rmSync('dist', { recursive: true, force: true });
execFileSync('node_modules/.bin/tsc', [], { stdio: 'inherit' });
mkdirSync('dist/packages/ontology/definitions', { recursive: true });
copyFileSync('packages/ontology/definitions/ride.json', 'dist/packages/ontology/definitions/ride.json');
const { implementationDigest } = await import('../dist/packages/runtime/implementation.js');
writeFileSync('dist/implementation.json', JSON.stringify({ digest: implementationDigest() }) + '\n');
