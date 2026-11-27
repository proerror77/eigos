import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, realpath, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export async function inventory(root) {
  const files = {};
  async function visit(directory) {
    for (const item of (await readdir(join(root, directory), { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const file = join(directory, item.name);
      if (item.isDirectory()) await visit(file);
      else if (item.isFile()) files[file] = sha256(await readFile(join(root, file)));
      else throw new Error('Unsupported release entry: ' + file);
    }
  }
  await visit('');
  return files;
}
export const treeDigest = (files) =>
  sha256(JSON.stringify(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))));

// Compose the two immutable payloads in an unoccupied installation directory.
async function install(target) {
  if (!target) throw new Error('Usage: node install.mjs <fresh installation directory>');
  const root = dirname(fileURLToPath(import.meta.url));
  const release = JSON.parse(await readFile(join(root, 'release.json'), 'utf8'));
  if (release.format !== 'eigos-vm-v1') throw new Error('Unsupported release');
  if (release.native && release.platform !== process.platform + '-' + process.arch)
    throw new Error('Native release targets ' + release.platform);
  const dest = resolve(target);
  await mkdir(dirname(dest), { recursive: true });
  const stage = await mkdtemp(join(dirname(dest), '.install-'));
  try {
    const installed = new Set();
    for (const part of ['engine', 'solution']) {
      const files = await inventory(join(root, part));
      if (treeDigest(files) !== release[part]) throw new Error(part + ' payload checksum mismatch');
      for (const [file, expected] of Object.entries(files)) {
        if (installed.has(file) || file === 'release.json') throw new Error('Package collision: ' + file);
        installed.add(file);
        await mkdir(dirname(join(stage, file)), { recursive: true });
        await cp(join(root, part, file), join(stage, file));
        if (sha256(await readFile(join(stage, file))) !== expected) throw new Error('Copy changed: ' + file);
      }
    }
    await writeFile(join(stage, 'release.json'), JSON.stringify(release) + '\n');
    await rename(stage, dest);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
if (process.argv[1] && (await realpath(process.argv[1])) === fileURLToPath(import.meta.url))
  await install(process.argv[2]);
