import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { sparedQuotePilot } from './pilot.js';

const file = process.env.EIGOS_SPARED_QUOTE_CONFIG_FILE;
if (!file || !isAbsolute(file)) throw new Error('The spared quote pilot requires an absolute synthetic fixture config path');

export const { functions, sources } = sparedQuotePilot(JSON.parse(await readFile(file, 'utf8')));
