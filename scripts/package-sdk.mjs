import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { generateOntologyTypes } from '../dist/packages/sdk/generate.js';
import { Ontology } from '../dist/packages/ontology/model.js';
import { businessDefinition } from '../dist/packages/solutions/eigos/definition.js';

const out = resolve(process.argv[2] ?? 'dist/sdk-packages');
await mkdir(out, { recursive: true });
const lock = JSON.parse(await readFile('vendor/mdn-foundry/manifest.json', 'utf8'));
const client = 'mdn-foundry-sdk-' + lock.version + '.tgz';
const bytes = await readFile('vendor/mdn-foundry/' + client);
if (createHash('sha256').update(bytes).digest('hex') !== lock.artifacts[client])
  throw new Error('SDK release digest mismatch');
await writeFile(resolve(out, client), bytes);
const pack = (path) =>
  execFileSync('npm', ['pack', '--silent', '--ignore-scripts', '--pack-destination', out], {
    cwd: path,
    encoding: 'utf8',
  }).trim();
const model = new Ontology(businessDefinition);
const bindings = 'dist/eigos-bindings';
await mkdir(bindings, { recursive: true });
const publication = { id: model.document.id, version: model.document.version, digest: model.digest };
const generated = generateOntologyTypes(model.resolvedDocument).split('\n');
const declaration = generated.map((line) =>
  line.startsWith('export const publication =')
    ? 'export declare const publication: ' + JSON.stringify(publication) + ';'
    : line,
);
await writeFile(bindings + '/index.d.ts', declaration.join('\n'));
await writeFile(
  bindings + '/index.js',
  'export const publication = Object.freeze(' + JSON.stringify(publication) + ');\n',
);
await writeFile(
  bindings + '/package.json',
  JSON.stringify(
    {
      name: '@mdn-foundry/eigos',
      version: '0.1.0-def.' + model.digest.slice(0, 12),
      type: 'module',
      exports: { '.': { types: './index.d.ts', import: './index.js' } },
      files: ['index.js', 'index.d.ts'],
    },
    null,
    2,
  ) + '\n',
);
console.log(JSON.stringify({ client, bindings: pack(bindings), publication }));
