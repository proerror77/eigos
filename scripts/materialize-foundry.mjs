import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const vendor = join(root, 'vendor/mdn-foundry');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Install the locked upstream artifacts at the module paths consumed by existing EIGOS solutions. */
export function materialize(target = root, { native = false, engineOnly = false } = {}) {
  const lock = JSON.parse(readFileSync(join(vendor, 'manifest.json'), 'utf8'));
  const tmp = mkdtempSync(join(tmpdir(), 'mdn-release-'));
  const stamp = join(target, '.foundry-inventory.json');
  const previous = existsSync(stamp) ? JSON.parse(readFileSync(stamp, 'utf8')) : {};
  const next = {};
  const pending = new Map();
  try {
    for (const [name, checksum] of Object.entries(lock.artifacts)) {
      const engine = name.startsWith('mdn-foundry-engine-'),
        source = name.startsWith('mdn-foundry-native-src-');
      if ((engineOnly && !engine) || (source && !native)) continue;
      const archive = join(vendor, name);
      if (hash(readFileSync(archive)) !== checksum) throw new Error('Foundry package checksum mismatch: ' + name);
      const dir = join(tmp, name);
      mkdirSync(dir);
      execFileSync('tar', ['-xzf', archive, '-C', dir]);
      const base = source ? dir : join(dir, 'package');
      for (const entry of readdirSync(base, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const path = join(entry.parentPath, entry.name).slice(base.length + 1);
        if (!engineOnly && (path === 'implementation.json' || path === 'package.json')) continue;
        const relative = join(engine || source ? '' : 'packages', path);
        const file = join(target, relative),
          origin = join(base, path),
          expected = hash(readFileSync(origin));
        if (next[relative] && next[relative] !== expected)
          throw new Error('Foundry packages disagree on ' + relative);
        next[relative] = expected;
        if (existsSync(file)) {
          const present = hash(readFileSync(file));
          if (present === expected) continue;
          if (present !== previous[relative])
            throw new Error('Preserve modified file before installing Foundry: ' + file);
        }
        pending.set(file, origin);
      }
    }
    for (const [relative, expected] of Object.entries(previous)) {
      if (relative in next) continue;
      const file = join(target, relative);
      if (existsSync(file) && hash(readFileSync(file)) !== expected)
        throw new Error('Obsolete Foundry file was modified: ' + file);
    }
    for (const [file, origin] of pending) {
      mkdirSync(dirname(file), { recursive: true });
      const scratch = file + '.foundry-' + process.pid;
      cpSync(origin, scratch);
      renameSync(scratch, file);
    }
    for (const relative of Object.keys(previous))
      if (!(relative in next)) rmSync(join(target, relative), { force: true });
    if (!engineOnly) {
      writeFileSync(stamp + '.' + process.pid, JSON.stringify(next));
      renameSync(stamp + '.' + process.pid, stamp);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  materialize(root, { native: true });
