import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installReleaseDependencies } from '../packages/deployment/dependencies.js';

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
