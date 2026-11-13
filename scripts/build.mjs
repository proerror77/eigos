import { rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
rmSync('dist', { recursive: true, force: true });
execFileSync('node_modules/.bin/tsc', [], { stdio: 'inherit' });
mkdirSync('dist/packages/ontology/definitions', { recursive: true });
copyFileSync('packages/ontology/definitions/ride.json', 'dist/packages/ontology/definitions/ride.json');
