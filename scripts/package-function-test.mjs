import { copyFileSync, cpSync, mkdirSync, rmSync } from 'node:fs';

// The generic harness and native client come from the checksummed Foundry SDK.
const source = 'packages/function-test';
const output = 'dist/function-test-package';
rmSync(output, { recursive: true, force: true });
mkdirSync(output + '/function-test', { recursive: true });
for (const name of ['index.js', 'index.d.ts']) copyFileSync(source + '/' + name, output + '/function-test/' + name);
for (const name of ['package.json', 'README.md']) copyFileSync(source + '/' + name, output + '/' + name);
cpSync('packages/function-host', output + '/function-host', {
  recursive: true, filter: path => !path.endsWith('.ts') || path.endsWith('.d.ts'),
});
