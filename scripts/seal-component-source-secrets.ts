import { readFile } from 'node:fs/promises';
import { sealSourceSecrets } from '../packages/runtime/component-source-secrets.js';

const keyFile = process.argv[2];
if (!keyFile) throw new Error('Pass the path to a 32-byte Source secret key');
const key = await readFile(keyFile);
try {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += (chunk as Buffer).length;
    if (bytes > 1 << 20) throw new Error('Source secrets input is too large');
    chunks.push(chunk as Buffer);
  }
  let raw: unknown;
  try { raw = JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw new Error('Source secrets must be a JSON record'); }
  try { console.log(JSON.stringify(sealSourceSecrets(raw, key))); }
  catch { throw new Error('Could not seal the Source secrets bundle'); }
} finally { key.fill(0); }
