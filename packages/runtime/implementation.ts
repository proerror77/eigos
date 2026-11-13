import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | undefined;
/** Identity of the shipped implementation inputs, identical in source and built execution. */
export function implementationDigest(): string {
  if (cached) return cached;
  let root = fileURLToPath(new URL('../../', import.meta.url));
  const artifact = join(root, 'implementation.json');
  if (existsSync(artifact)) return cached = JSON.parse(readFileSync(artifact, 'utf8')).digest as string;
  if (!existsSync(join(root, 'package.json'))) root = dirname(root);
  const paths: string[] = ['package.json', 'package-lock.json', 'tsconfig.json'];
  const visit = (path: string) => { for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name); if (entry.isDirectory()) visit(child); else if (/\.(ts|json|js|css|html)$/.test(entry.name)) paths.push(relative(root, child));
  } };
  visit(join(root, 'apps')); visit(join(root, 'packages'));
  const hash = createHash('sha256');
  for (const path of paths.sort()) { hash.update(path); hash.update('\0'); hash.update(readFileSync(join(root, path))); hash.update('\0'); }
  return cached = hash.digest('hex');
}
