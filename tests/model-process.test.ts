import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModelProcessFiles } from '../packages/capabilities/model-process.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'eigos-process-config-'));
  const codexHome = join(root, 'native'), userHome = join(root, 'user'), adminSkillsRoot = join(root, 'admin-skills'), run = join(root, 'run');
  for (const path of [codexHome, userHome, adminSkillsRoot, run]) await mkdir(path, { recursive: true, mode: 0o700 });
  await writeFile(join(codexHome, 'auth.json'), 'SYNTHETIC_AUTH_REFERENCE', { mode: 0o600 });
  await writeFile(join(codexHome, 'AGENTS.md'), 'UNRELATED_HOST_RULE');
  await writeFile(join(codexHome, 'config.toml'), 'developer_instructions = "UNRELATED_HOST_RULE"');
  const skill = join(userHome, '.agents', 'skills', 'unrelated');
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, 'SKILL.md'), '---\nname: unrelated\ndescription: Unrelated host workflow\n---\n');
  return { root, run, skill, host: { codexHome, userHome, adminSkillsRoot }, close: () => rm(root, { recursive: true, force: true }) };
}

test('model configuration isolates host instructions and skill catalogs while preserving the private auth reference', async () => {
  const f = await fixture();
  try {
    const files = await createModelProcessFiles(f.run, 'BOUNDED_BUSINESS_INSTRUCTIONS', f.host);
    const config = await readFile(files.configPath, 'utf8');
    assert.equal(await readFile(files.instructionsPath, 'utf8'), 'BOUNDED_BUSINESS_INSTRUCTIONS');
    assert(!config.includes('UNRELATED_HOST_RULE'));
    assert(config.includes(JSON.stringify(await realpath(join(f.skill, 'SKILL.md')))) && config.includes('enabled = false'));
    assert.equal((await lstat(files.codexHome)).mode & 0o077, 0);
    for (const path of [files.configPath, files.instructionsPath]) assert.equal((await lstat(path)).mode & 0o077, 0);
    assert((await lstat(join(files.codexHome, 'auth.json'))).isSymbolicLink());
    assert.equal(await readlink(join(files.codexHome, 'auth.json')), join(f.host.codexHome, 'auth.json'));
    await rm(f.run, { recursive: true });
    assert.equal(await readFile(join(f.host.codexHome, 'auth.json'), 'utf8'), 'SYNTHETIC_AUTH_REFERENCE');
    assert.equal(await readFile(join(f.skill, 'SKILL.md'), 'utf8'), '---\nname: unrelated\ndescription: Unrelated host workflow\n---\n');
  } finally { await f.close(); }
});

test('skill discovery handles directory cycles and dangling links without changing the host tree', async () => {
  const f = await fixture();
  try {
    await symlink(join(f.host.userHome, '.agents', 'skills'), join(f.skill, 'cycle'));
    await symlink(join(f.root, 'missing'), join(f.skill, 'dangling'));
    const files = await createModelProcessFiles(f.run, 'BOUNDED', f.host);
    assert((await readFile(files.configPath, 'utf8')).includes(JSON.stringify(await realpath(join(f.skill, 'SKILL.md')))));
    assert((await lstat(join(f.skill, 'cycle'))).isSymbolicLink());
  } finally { await f.close(); }
});

for (const mode of ['public', 'symlink'] as const) test(`model configuration rejects a ${mode} native auth store`, async () => {
  const f = await fixture(), auth = join(f.host.codexHome, 'auth.json');
  try {
    if (mode === 'public') await chmod(auth, 0o644);
    else { await rm(auth); await writeFile(join(f.root, 'auth-target'), 'SYNTHETIC_AUTH_REFERENCE', { mode: 0o600 }); await symlink(join(f.root, 'auth-target'), auth); }
    await assert.rejects(createModelProcessFiles(f.run, 'BOUNDED', f.host), /authentication store is not private/);
  } finally { await f.close(); }
});
