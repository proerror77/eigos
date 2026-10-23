import { readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function syncOntology(root, write = true) {
  const { loadMcpReadModule, mcpReadModuleRef } = await import(pathToFileURL(join(root, 'dist/packages/ontology/mcp-read.js')).href);
  const modules = readdirSync(join(root, 'ontology')).filter(name => name.endsWith('.json')).sort().map(name => ({ name, module: loadMcpReadModule(join(root, 'ontology', name)) }));
  if (!modules.length) throw new Error('No independent ontology definitions found');
  if (write) {
    mkdirSync(join(root, 'dist/ontology'), { recursive: true });
    for (const { name } of modules) copyFileSync(join(root, 'ontology', name), join(root, 'dist/ontology', name));
  }
  return modules.map(({ name, module }) => ({ file: 'ontology/' + name, ...mcpReadModuleRef(module) }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? '--check';
  if (!['--check', '--sync'].includes(mode)) throw new Error('Use --check or --sync');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  console.log(JSON.stringify({ status: mode === '--sync' ? 'synced' : 'valid', modules: await syncOntology(root, mode === '--sync') }));
}
