import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { changedFiles, scopeFromGit, selectScope, shardFiles, testFiles } from '../scripts/test-scope.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const runner = resolve(root, 'scripts/test.mjs');
const subprocessEnv = { ...process.env };
delete subprocessEnv.NODE_TEST_CONTEXT;
delete subprocessEnv.GITHUB_OUTPUT;
delete subprocessEnv.GITHUB_STEP_SUMMARY;
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-ci-scope-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const put = (file, content) => { mkdirSync(dirname(join(directory, file)), { recursive: true }); writeFileSync(join(directory, file), content); };
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  put('package.json', '{"type":"module"}');
  put('packages/leaf.ts', 'export const value = 1; export interface Shape { value: number }');
  put('packages/barrel.ts', "export { value } from './leaf.js';");
  put('packages/other.ts', 'export const value = 2;');
  put('packages/orphan.ts', 'export const value = 3;');
  put('apps/child.ts', "import {value} from '../packages/barrel.js'; console.log(value);");
  put('tests/leaf.test.ts', "import {value} from '../packages/barrel.js'; console.log(value);");
  put('tests/other.test.ts', "import {value} from '../packages/other.js'; console.log(value);");
  put('tests/types.test.ts', "import type {Shape} from '../packages/leaf.js'; const shape: Shape = {value: 1}; console.log(shape);");
  put('tests/dynamic.test.ts', "console.log(await import('../packages/leaf.js'));");
  put('tests/fixtures/shared.ts', "export {value} from '../../packages/leaf.js';");
  put('tests/shared.test.ts', "import {value} from './fixtures/shared.js'; console.log(value);");
  put('tests/process.test.ts', "const source = true; console.log(new URL(`../apps/child.${source ? 'ts' : 'js'}`, import.meta.url));");
  put('tests/e2e/process.test.ts', "console.log('dist/apps/child.js');");
  put('docs/guide.md', 'Fixture documentation');
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=CI Fixture', '-c', 'user.email=ci@example.invalid', 'commit', '-qm', 'fixture');
  return { directory, put, git, select: changed => selectScope({ root: directory, changed }) };
}

test('documentation does not select runtime checks, including on main', async t => {
  const f = fixture(t);
  for (const main of [false, true]) {
    const scope = await selectScope({ root: f.directory, changed: ['README.md', 'AGENTS.md', 'docs/guide.md', 'packages/ontology/README.md'], main });
    assert.equal(scope.mode, 'docs'); assert.equal(scope.verify, false);
    assert.deepEqual(scope.unit, []); assert.deepEqual(scope.e2e, []);
  }
});

test('a test-only edit selects that test without process E2E', async t => {
  const f = fixture(t), scope = await f.select(['tests/leaf.test.ts']);
  assert.equal(scope.mode, 'affected'); assert.equal(scope.verify, true);
  assert.deepEqual(scope.unit, ['tests/leaf.test.ts']); assert.deepEqual(scope.e2e, []);
});

test('source edits follow re-exports, fixtures, dynamic imports and process paths', async t => {
  const f = fixture(t), scope = await f.select(['packages/leaf.ts']);
  assert.equal(scope.mode, 'affected');
  assert.deepEqual(scope.unit, ['tests/dynamic.test.ts', 'tests/leaf.test.ts', 'tests/process.test.ts', 'tests/shared.test.ts']);
  assert.deepEqual(scope.e2e, ['tests/e2e/process.test.ts']);
});

test('a shared fixture edit includes its consumers and process coverage', async t => {
  const f = fixture(t), scope = await f.select(['tests/fixtures/shared.ts']);
  assert.equal(scope.mode, 'affected'); assert.deepEqual(scope.unit, ['tests/shared.test.ts']);
  assert.equal(scope.e2e.length, 1);
});

test('E2E-only edits do not select unrelated unit tests', async t => {
  const f = fixture(t), scope = await f.select(['tests/e2e/process.test.ts']);
  assert.equal(scope.mode, 'affected'); assert.deepEqual(scope.unit, []);
  assert.deepEqual(scope.e2e, ['tests/e2e/process.test.ts']);
});

test('cycles terminate and retain transitive consumers', async t => {
  const f = fixture(t);
  f.put('packages/leaf.ts', "export {other} from './cycle.js'; export const value = 1;");
  f.put('packages/cycle.ts', "import {value} from './leaf.js'; export const other = () => value;");
  const scope = await f.select(['packages/cycle.ts']);
  assert.equal(scope.mode, 'affected'); assert(scope.unit.includes('tests/leaf.test.ts'));
});

test('CLI imports of generated dist files resolve to source before a build exists', async t => {
  const f = fixture(t);
  f.put('scripts/cli.mjs', "import {value} from '../dist/packages/leaf.js'; console.log(value);");
  f.put('tests/cli.test.ts', "console.log('scripts/cli.mjs');");
  const scope = await f.select(['packages/leaf.ts']);
  assert.equal(scope.mode, 'affected'); assert(scope.unit.includes('tests/cli.test.ts'));
});

test('configuration, definitions, unknown paths and deleted source require full regression', async t => {
  const f = fixture(t);
  for (const file of ['package.json', 'package-lock.json', 'tsconfig.json', '.github/workflows/ci.yml', 'scripts/test.mjs',
    'packages/ontology/definitions/provider.json', 'packages/security/baseline.json', 'integrations/agent/SKILL.md', 'docs/input.json', 'packages/deleted.ts']) {
    const scope = await f.select([file]);
    assert.equal(scope.mode, 'full', file); assert.deepEqual(scope.unit, testFiles(f.directory)); assert.equal(scope.e2e.length, 1);
  }
});

test('unmapped source and broken dependency resolution fall back to full regression', async t => {
  const f = fixture(t);
  assert.equal((await f.select(['packages/orphan.ts'])).mode, 'full');
  f.put('packages/leaf.ts', "import './missing.js';");
  const scope = await f.select(['packages/leaf.ts']);
  assert.equal(scope.mode, 'full'); assert.match(scope.reason, /could not be resolved/);
});

test('main and explicit full runs retain the entire suite', async t => {
  const f = fixture(t);
  assert.equal((await selectScope({ root: f.directory, changed: ['tests/leaf.test.ts'], main: true })).mode, 'full');
  assert.equal((await selectScope({ root: f.directory, changed: ['README.md'], full: true })).mode, 'full');
});

test('Git comparison includes the entire branch plus staged, unstaged and new files', async t => {
  const f = fixture(t), base = f.git('rev-parse', 'HEAD');
  f.put('tests/leaf.test.ts', 'console.log("committed");');
  f.git('add', '.'); f.git('-c', 'user.name=CI Fixture', '-c', 'user.email=ci@example.invalid', 'commit', '-qm', 'branch change');
  f.put('tests/other.test.ts', 'console.log("staged");'); f.git('add', 'tests/other.test.ts');
  f.put('docs/guide.md', 'Unstaged documentation'); f.put('tests/new space.test.ts', 'console.log("new");');
  assert.deepEqual(changedFiles(f.directory, base), ['docs/guide.md', 'tests/leaf.test.ts', 'tests/new space.test.ts', 'tests/other.test.ts']);
});

test('renames preserve the removed path and cannot silently lose old dependants', async t => {
  const f = fixture(t), base = f.git('rev-parse', 'HEAD');
  renameSync(join(f.directory, 'packages/leaf.ts'), join(f.directory, 'packages/moved.ts')); f.git('add', '.');
  assert.deepEqual(changedFiles(f.directory, base), ['packages/leaf.ts', 'packages/moved.ts']);
  assert.equal((await scopeFromGit({ root: f.directory, base })).mode, 'full');
});

test('an unstaged reversal does not hide a different staged version', t => {
  const f = fixture(t), base = f.git('rev-parse', 'HEAD');
  f.put('packages/other.ts', 'export const value = 42;'); f.git('add', 'packages/other.ts');
  f.put('packages/other.ts', 'export const value = 2;');
  assert.deepEqual(changedFiles(f.directory, base), ['packages/other.ts']);
});

test('an unavailable base never becomes a successful empty scope', async t => {
  const f = fixture(t), scope = await scopeFromGit({ root: f.directory, base: 'missing-base' });
  assert.equal(scope.mode, 'full'); assert.match(scope.reason, /base unavailable/);
});

test('CI emits the same selected files as local scope and manual runs force full', t => {
  const f = fixture(t), base = f.git('rev-parse', 'HEAD'), output = join(f.directory, '.git/ci-outputs');
  f.put('docs/guide.md', 'Changed documentation');
  for (const event of ['pull_request', 'workflow_dispatch']) {
    writeFileSync(output, '');
    const result = spawnSync(process.execPath, [resolve(root, 'scripts/test-scope.mjs'), '--ci'], {
      cwd: f.directory, encoding: 'utf8', env: { ...subprocessEnv, GITHUB_EVENT_NAME: event, CI_BASE_SHA: base, GITHUB_OUTPUT: output },
    });
    assert.equal(result.status, 0, result.stderr);
    const scope = JSON.parse(result.stdout);
    assert.equal(scope.mode, event === 'pull_request' ? 'docs' : 'full');
    const outputs = Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(line => {
      const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)];
    }));
    assert.deepEqual(Object.values(JSON.parse(outputs.shards)).flat().sort(), [...scope.unit].sort());
    assert.deepEqual(JSON.parse(outputs.e2e), scope.e2e);
  }
});

test('shards cover each selected file exactly once, including small and empty scopes', () => {
  for (const files of [[], ['tests/one.test.ts'], testFiles(root)]) {
    const shards = shardFiles(files), combined = Object.values(shards).flat();
    assert.equal(Object.keys(shards).length, 8); assert.deepEqual(combined.sort(), [...files].sort());
    assert.equal(new Set(combined).size, files.length);
  }
});

test('an empty selection never falls through to automatic Node test discovery', t => {
  const f = fixture(t);
  f.put('tests/should-not-run.test.mjs', 'process.exit(99);');
  const run = spawnSync(process.execPath, [runner], { cwd: f.directory, encoding: 'utf8', env: { ...subprocessEnv, EIGOS_TEST_FILES: '[]' } });
  assert.equal(run.status, 0, run.stderr); assert.match(run.stdout, /test discovery was not invoked/);
});

test('explicit file selection excludes unrelated tests and propagates failures', t => {
  const f = fixture(t);
  symlinkSync(resolve(root, 'node_modules'), join(f.directory, 'node_modules'), 'dir');
  f.put('tests/fail.test.mjs', 'process.exit(7);');
  f.put('tests/pass.test.mjs', "console.log('ONLY_SELECTED_FILE');");
  for (const [file, succeeds] of [['pass', true], ['fail', false]]) {
    const run = spawnSync(process.execPath, [runner], { cwd: root, encoding: 'utf8', env: { ...subprocessEnv,
      EIGOS_TEST_FILES: JSON.stringify([`../${file}.test.mjs`]) } });
    assert.notEqual(run.status, 0); assert.match(run.stderr, /distinct current test files/);
    const result = spawnSync(process.execPath, [runner], { cwd: f.directory, encoding: 'utf8', env: { ...subprocessEnv,
      EIGOS_TEST_FILES: JSON.stringify([`tests/${file}.test.mjs`]) } });
    assert.equal(result.status === 0, succeeds, result.stderr);
    if (succeeds) assert.match(result.stdout, /ONLY_SELECTED_FILE/);
  }
});
