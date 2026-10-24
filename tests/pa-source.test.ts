import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { resolvePaOwner }: { resolvePaOwner(source: string, owner: string | undefined, record: string): string } = await import(new URL('../scripts/pa-source.mjs', import.meta.url).href);

test('PA build source may use an owned worktree while unrelated repositories and owner substitutions fail closed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigos-pa-source-'));
  const owner = join(directory, 'owner'), source = join(directory, 'source'), other = join(directory, 'other'), ownership = join(directory, 'owner.json');
  const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  try {
    for (const path of [owner, other]) {
      mkdirSync(path); git(path, ['init']); git(path, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'Synthetic setup fixture']);
    }
    git(owner, ['worktree', 'add', '--detach', source, 'HEAD']);
    writeFileSync(ownership, JSON.stringify({ sourceRoot: owner }));
    assert.equal(resolvePaOwner(source, owner, ownership), owner);
    assert.equal(resolvePaOwner(owner, undefined, ownership), owner);
    assert.throws(() => resolvePaOwner(other, owner, ownership), /existing runtime owner/);
    assert.throws(() => resolvePaOwner(source, other, ownership), /existing runtime owner/);
    assert.throws(() => resolvePaOwner(source, owner, join(directory, 'missing.json')), /existing runtime owner/);
    assert.equal(JSON.parse(readFileSync(ownership, 'utf8')).sourceRoot, owner);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
