// Builds function.wasm: compiles src/function.ts, then makes it a component of the EIGOS world without HTTP or fetch.
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { componentize } from '@bytecodealliance/componentize-js';
import { _setPreopens } from '@bytecodealliance/preview2-shim/filesystem';

// preview2-shim starts with nothing opened, so ComponentizeJS could read no file. This runs on the author's machine.
_setPreopens({ [process.cwd()]: process.cwd(), '/tmp': '/tmp' });
execFileSync('node_modules/.bin/tsc', ['-p', 'tsconfig.json'], { stdio: 'inherit' });
const { component } = await componentize(await readFile('dist/function.js', 'utf8'), {
  witPath: `${process.cwd()}/wit`,
  worldName: 'handler',
  disableFeatures: ['http', 'fetch-event'],
});
await writeFile('function.wasm', component);
console.log(`function.wasm: ${component.byteLength} bytes`);
