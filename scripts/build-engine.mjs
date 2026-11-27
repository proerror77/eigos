import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = 'dist/engine';
rmSync(out, { force: true, recursive: true });
execFileSync('node_modules/.bin/tsc', ['-p', 'tsconfig.engine.json'], { stdio: 'inherit' });
for (const path of ['packages/capabilities', 'packages/solutions', 'packages/ontology/definition.js', 'apps/gateway/app.js', 'apps/gateway/account-portal.js']) {
  if (existsSync(join(out, path))) throw new Error('Engine imports a business implementation: ' + path);
}
writeFileSync(join(out, 'package.json'), JSON.stringify({ private: true, type: 'module' }) + '\n');
const hash = createHash('sha256').update(readFileSync('package-lock.json'));
for (const file of readdirSync(out, { recursive: true }).sort()) {
  if (file.endsWith('.js')) hash.update(file).update('\0').update(readFileSync(join(out, file))).update('\0');
}
writeFileSync(join(out, 'implementation.json'), JSON.stringify({ digest: hash.digest('hex') }) + '\n');
