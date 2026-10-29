import { lstat, mkdir, readdir, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';

/** One policy for both bounded model transports. Gateway/provider credentials
 * never enter a model subprocess. Codex owns its existing authentication. */
export const modelFeatureArgs = Object.freeze(['shell_tool', 'apps', 'plugins', 'hooks', 'memories', 'multi_agent', 'multi_agent_v2', 'computer_use', 'browser_use', 'browser_use_external', 'in_app_browser', 'image_generation', 'code_mode', 'goals', 'sleep_tool', 'view_image', 'skill_search', 'tool_suggest', 'workspace_dependencies'].flatMap(name => ['--disable', name]));
export function modelEnvironment() {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'CODEX_HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE']) if (process.env[key]) env[key] = process.env[key];
  return env;
}

async function localSkillFiles(roots: string[]): Promise<string[]> {
  const pending = [...roots], visited = new Set<string>(), files = new Set<string>();
  while (pending.length) {
    const path = pending.pop()!;
    let canonical: string;
    try { canonical = await realpath(path); }
    catch (error) { if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) continue; throw error; }
    if (visited.has(canonical)) continue;
    visited.add(canonical);
    if (visited.size > 4096) throw new Error('Host skill discovery exceeds the bounded model configuration limit');
    for (const entry of await readdir(canonical, { withFileTypes: true })) {
      const child = join(canonical, entry.name);
      let kind: Pick<typeof entry, 'isFile' | 'isDirectory'> = entry;
      if (entry.isSymbolicLink()) {
        try { kind = await stat(child); }
        catch (error) { if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) continue; throw error; }
      }
      if (entry.name.toLowerCase() === 'skill.md' && kind.isFile()) {
        files.add(child); files.add(join(path, entry.name)); files.add(await realpath(child));
      } else if (!['.git', 'node_modules', '.tgrep', '__pycache__'].includes(entry.name)
        && kind.isDirectory()) pending.push(child);
    }
  }
  return [...files];
}

/** Each model process gets only its own instructions/configuration and a
 * reference to Codex's existing private auth store. Host AGENTS.md, plugins
 * and unrelated local skills are not part of a business task's authority. */
export async function createModelProcessFiles(directory: string, instructions: string,
  host: { codexHome?: string; userHome?: string; adminSkillsRoot?: string } = {}) {
  const sourceHome = host.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const auth = join(sourceHome, 'auth.json'), root = await realpath(directory), codexHome = join(root, 'codex');
  await mkdir(codexHome, { mode: 0o700 });
  try {
    const info = await lstat(auth);
    if (!info.isFile() || info.mode & 0o077 || process.getuid && info.uid !== process.getuid()) throw new Error('Native Codex authentication store is not private');
    await symlink(auth, join(codexHome, 'auth.json'));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

  const hostSkills = await localSkillFiles([join(host.userHome ?? homedir(), '.agents', 'skills'), host.adminSkillsRoot ?? '/etc/codex/skills']);
  let sourceSystem: string | undefined;
  try { sourceSystem = await realpath(join(sourceHome, 'skills', '.system')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const systemSkills = sourceSystem ? (await localSkillFiles([sourceSystem])).flatMap(path => {
    const local = relative(sourceSystem, path);
    return local.startsWith('..') || isAbsolute(local) ? [] : [join(codexHome, 'skills', '.system', local)];
  }) : [];
  for (const name of ['imagegen', 'openai-docs', 'skill-creator', 'skill-installer']) systemSkills.push(join(codexHome, 'skills', '.system', name, 'SKILL.md'));
  const disabled = [...new Set([...hostSkills, ...systemSkills].flatMap(path => [path, dirname(path)]))].sort();
  const instructionsPath = join(root, 'model-instructions.md'), configPath = join(codexHome, 'config.toml');
  await writeFile(instructionsPath, instructions, { mode: 0o600 });
  await writeFile(configPath, [
    `model_instructions_file = ${JSON.stringify(instructionsPath)}`,
    'skills.max_context_tokens = 1',
    ...disabled.map(path => `[[skills.config]]\npath = ${JSON.stringify(path)}\nenabled = false`),
    '',
  ].join('\n'), { mode: 0o600 });
  return { codexHome, configPath, instructionsPath };
}
