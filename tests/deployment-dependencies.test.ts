import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { installReleaseDependencies } from '../packages/deployment/dependencies.js';
import { releaseFiles } from '../packages/deployment/files.js';

test('immutable release retains JSON assets required by relocated runtime imports', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eigos-release-assets-')), source = join(dir, 'source'), release = join(dir, 'release');
  const put = (path: string, content: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
  try {
    put(join(source, 'apps/gateway/main.ts'), "import value from '../../packages/ontology/history/seed.json' with { type: 'json' }; console.log(value.version);");
    put(join(source, 'packages/ontology/history/seed.json'), '{"version":15}');
    put(join(source, 'ontology/didi-readonly.json'), '{"version":"1"}');
    put(join(source, 'dist/ontology/didi-readonly.json'), '{"version":"1"}');
    put(join(source, 'dist/apps/gateway/main.js'), "import value from '../../packages/ontology/history/seed.json' with { type: 'json' }; console.log(value.version);");
    put(join(source, 'dist/packages/ontology/history/seed.json'), '{"version":15}');
    put(join(source, 'package.json'), '{"type":"module"}');
    put(join(source, 'package-lock.json'), '{}');
    put(join(source, 'scripts/run-local.mjs'), '');
    put(join(source, 'integrations/grok/eigos-native/client.mjs'), 'console.log("A2A transport fixture");');
    put(join(source, 'dist/apps/gateway/orphan.js'), 'throw new Error("not a current source");');
    const files = releaseFiles(source);
    assert(files.includes('dist/ontology/didi-readonly.json'));
    assert(!files.some(path => path.endsWith('/orphan.js')));
    for (const path of files) { mkdirSync(dirname(join(release, path)), { recursive: true }); cpSync(join(source, path), join(release, path)); }
    rmSync(source, { recursive: true });
    assert.equal(execFileSync(process.execPath, ['dist/apps/gateway/main.js'], { cwd: release, encoding: 'utf8' }).trim(), '15');
    assert.equal(execFileSync(process.execPath, ['integrations/grok/eigos-native/client.mjs'], { cwd: release, encoding: 'utf8' }).trim(), 'A2A transport fixture');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('immutable release resolves transitive ESM imports from its relocated dependency cache', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eigos-dependency-layout-')), source = join(dir, 'source'), runtime = join(dir, 'runtime'), release = join(runtime, 'release');
  try {
    mkdirSync(release, { recursive: true }); mkdirSync(join(source, 'node_modules', 'parent'), { recursive: true }); mkdirSync(join(source, 'node_modules', 'child'));
    writeFileSync(join(source, 'package-lock.json'), '{}');
    for (const name of ['parent', 'child']) writeFileSync(join(source, 'node_modules', name, 'package.json'), JSON.stringify({ name, type: 'module', exports: './index.js' }));
    writeFileSync(join(source, 'node_modules', 'parent', 'index.js'), "export {value} from 'child';"); writeFileSync(join(source, 'node_modules', 'child', 'index.js'), 'export const value = 42;');
    const cache = installReleaseDependencies(source, runtime, release);
    assert(cache.endsWith('/node_modules')); assert.equal(installReleaseDependencies(source, runtime, release), cache);
    assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', "console.log((await import('parent')).value)"], { cwd: release, encoding: 'utf8' }).trim(), '42');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('deployment refuses to replace a release dependency link owned by another directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eigos-dependency-owner-')), source = join(dir, 'source'), release = join(dir, 'release'), other = join(dir, 'other');
  try { mkdirSync(source); mkdirSync(release); mkdirSync(other); writeFileSync(join(source, 'package-lock.json'), '{}'); symlinkSync(other, join(release, 'node_modules')); assert.throws(() => installReleaseDependencies(source, dir, release), /not owned/); assert.equal(readlinkSync(join(release, 'node_modules')), other); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
