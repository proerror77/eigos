import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { releaseFiles } from '../../packages/deployment/files.js';

test('the actual semantic CLI loads a relocated runtime without source, credentials, model or database', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), 'eigos-semantic-runtime-'));
  try {
    for (const path of releaseFiles(root)) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      cpSync(join(root, path), join(directory, path));
    }
    symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
    assert.equal(existsSync(join(directory, 'packages')), false);
    const run = (...args: string[]) => spawnSync(process.execPath, ['scripts/semantic-catalog.mjs', ...args], {
      cwd: directory, env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 30000,
    });
    const help = run('--help');
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Use model\|init\|index\|search/);
    const refused = run('search', '--model-dir', join(directory, 'absent-model'), '--binding', join(directory, 'absent-binding.json'));
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /Invalid owned PostgreSQL binding file/);
    assert.doesNotMatch(refused.stderr, /ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION/);
    assert.equal(existsSync(join(directory, 'absent-model')), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
