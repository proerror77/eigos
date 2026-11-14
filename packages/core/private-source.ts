import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export async function readPrivateSourceFile(path: string) {
  if (!isAbsolute(path)) throw new Error('Source configuration requires a private absolute path');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > 64 * 1024 || stat.uid !== process.getuid?.())
      throw new Error('Source configuration must be an owned private file');
    return await file.readFile('utf8');
  } finally { await file.close(); }
}

export function yuanToFen(value: unknown) {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+(?:\.\d{1,2})?$/.test(String(value)))
    throw new Error('Provider amount is missing or invalid');
  const [yuan, fraction = ''] = String(value).split('.');
  const result = Number(yuan) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(result)) throw new Error('Provider amount exceeds the supported range');
  return result;
}
