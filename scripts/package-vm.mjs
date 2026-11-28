import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, writeFile, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { inventory, treeDigest, sha256 } from '../deploy/vm/install.mjs';
import { Ontology } from '../dist/packages/ontology/model.js';
import { businessDefinition } from '../dist/packages/solutions/eigos/definition.js';

const [destination, definitionFile] = process.argv.slice(2);
const root = resolve(destination ?? 'dist/vm');
await mkdir(root); // Fresh output only.
const core = join(root, 'engine'),
  solution = join(root, 'solution');
await cp('dist/engine', core, { recursive: true });
for (const name of ['package.json', 'package-lock.json', '.npmrc']) await cp(name, join(core, name));
// The installed VM already contains its locked compiled modules.
const runtimePackage = JSON.parse(await readFile(join(core,'package.json'),'utf8'));
delete runtimePackage.scripts.postinstall;
await writeFile(join(core,'package.json'),JSON.stringify(runtimePackage)+'\n');
const common = await inventory(core);
for (const dir of ['apps', 'packages']) {
  // The compiled EIGOS entry and trusted connectors resolve shared modules in the installed Engine.
  for (const entry of await readdir('dist/' + dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name).slice('dist/'.length);
    if (path in common) {
      if (sha256(await readFile(join('dist', path))) !== common[path])
        throw new Error('Business build differs from shared Engine: ' + path);
      continue;
    }
    if (path.startsWith('packages/function-test/')) continue;
    await mkdir(dirname(join(solution, path)), { recursive: true });
    await cp(join('dist', path), join(solution, path));
  }
}
const model = new Ontology(
  definitionFile ? JSON.parse(await readFile(definitionFile, 'utf8')) : businessDefinition,
);
if (model.document.id !== 'Eigos') throw new Error('EIGOS registration requires its Eigos definition');
await writeFile(join(solution, 'ontology.json'), JSON.stringify(model.document) + '\n');
const native = {};
async function functionHostProtocol() {
  const source = await readFile('function-host/src/main.rs', 'utf8');
  const version = /^const PROTOCOL: u32 = ([0-9]+);$/m.exec(source);
  if (!version) throw new Error('Missing protocol declaration in the pinned function host source');
  return Number(version[1]);
}
for (const [name, variable] of [
  ['kernel', 'EIGOS_KERNEL_BIN'],
  ['function-host', 'EIGOS_FUNCTION_HOST_BIN'],
]) {
  const binary = process.env[variable];
  if (binary) {
    await mkdir(join(core, 'bin'), { recursive: true });
    await cp(binary, join(core, 'bin', name));
    await chmod(join(core, 'bin', name), 0o755);
    native[name] = {
      sha256: sha256(await readFile(binary)),
      protocol: name === 'function-host' ? await functionHostProtocol() : 2,
      ...(name === 'function-host' ? { world: 'eigos:function/handler@0.2.0' } : {}),
    };
  }
}
if (Object.keys(native).length === 1) throw new Error('Supply both native binaries for the native VM profile');
const release = {
  format: 'eigos-vm-v1',
  solutionVersion: runtimePackage.version,
  foundry: JSON.parse(await readFile('vendor/mdn-foundry/manifest.json', 'utf8')),
  source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  platform: process.platform + '-' + process.arch,
  native: Object.keys(native).length ? native : null,
  engine: treeDigest(await inventory(core)),
  solution: treeDigest(await inventory(solution)),
  ontology: { id: model.document.id, version: model.document.version, digest: model.digest },
};
await writeFile(join(root, 'release.json'), JSON.stringify(release, null, 2) + '\n');
await cp('deploy/vm/install.mjs', join(root, 'install.mjs'));
await cp('deploy/vm/eigos@.service', join(root, 'eigos@.service'));
await cp('docs/guides/installed-engine.md', join(root, 'INSTALL.md'));
console.log(JSON.stringify(release));
