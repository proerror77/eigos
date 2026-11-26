// PROTOTYPE: transpiles invoke.ts, then componentizes it for the EIGOS world without HTTP or fetch.
import { _setPreopens } from '@bytecodealliance/preview2-shim/filesystem';
import { componentize } from '@bytecodealliance/componentize-js';
// preview2-shim 0.31 starts with no preopens, so the splicer could read no file. This build step runs on the author's
// machine, so it may see the working directory.
_setPreopens({ [process.cwd()]: process.cwd(), '/tmp': '/tmp' });
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
execFileSync(process.argv[2], ['invoke.ts', '--ignoreConfig', '--target', 'es2022', '--module', 'es2022', '--outDir', 'dist'], { stdio: 'inherit' });
await mkdir('wit', { recursive: true });
await copyFile('../wit/handler.wit', 'wit/handler.wit');
const started = performance.now();
const { component } = await componentize(await readFile('dist/invoke.js', 'utf8'), {
  // The splicer sees only the working directory, so the world is copied next to the source.
  witPath: process.cwd() + '/wit/handler.wit', worldName: 'handler', disableFeatures: ['http', 'fetch-event'],
});
await writeFile('invoke.wasm', component);
console.log(JSON.stringify({ step: 'componentize', ms: Math.round(performance.now() - started), bytes: component.byteLength }));
