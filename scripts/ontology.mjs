import { readdirSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function syncOntology(root, write = true) {
  const { loadMcpReadModule, mcpReadModuleRef } = await import(pathToFileURL(join(root, 'dist/packages/ontology/mcp-read.js')).href);
  const source = join(root, 'packages/ontology/definitions');
  const output = join(root, 'dist/packages/ontology/definitions');
  const modules = readdirSync(source).filter(name => name.endsWith('.json')).sort().map(name => ({ name, module: loadMcpReadModule(join(source, name)) }));
  if (!modules.length) throw new Error('No independent ontology definitions found');
  if (write) {
    mkdirSync(output, { recursive: true });
    const names = new Set(modules.map(module => module.name));
    for (const name of readdirSync(output)) if (name.endsWith('.json') && !names.has(name)) rmSync(join(output, name));
    for (const { name } of modules) copyFileSync(join(source, name), join(output, name));
    // Remove only the obsolete generated location, never an editable source.
    rmSync(join(root, 'dist/ontology'), { recursive: true, force: true });
  }
  return modules.map(({ name, module }) => ({ file: 'packages/ontology/definitions/' + name, ...mcpReadModuleRef(module) }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? '--check';
  if (!['--check', '--sync'].includes(mode)) throw new Error('Use --check or --sync');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  console.log(JSON.stringify({ status: mode === '--sync' ? 'synced' : 'valid', modules: await syncOntology(root, mode === '--sync') }));
}
