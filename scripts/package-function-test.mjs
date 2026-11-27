import { copyFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const source = 'packages/function-test';
const output = 'dist/function-test-package';
rmSync(output, { recursive: true, force: true });
execFileSync('node_modules/.bin/tsc', ['-p', source + '/tsconfig.json'], { stdio: 'inherit' });
for (const file of ['package.json', 'README.md']) copyFileSync(source + '/' + file, output + '/' + file);
