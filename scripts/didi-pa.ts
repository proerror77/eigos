import { createHash } from 'node:crypto';
import { z } from 'zod';
import { digest } from '../packages/core/identity.js';
import { readPrivateSourceFile } from '../packages/core/private-source.js';
import { DidiMcpConnector } from '../packages/capabilities/didi/connector.js';
import { DidiOperations } from '../packages/capabilities/didi/operations.js';
import { OntologyClient } from '../packages/sdk/client.js';
import { DidiPA, type DidiPAOptions } from '../packages/sdk/didi-pa.js';

const taskId = z.uuid().parse(process.argv[2]);
const permitDispatch = process.argv[3] === '--dispatch-approved-order';
if (process.argv.length > (permitDispatch ? 4 : 3)) throw new Error('Unexpected argument');
const config = z.object({
  EIGOS_PA_URL: z.url(), EIGOS_PA_TOKEN: z.string().min(16),
  EIGOS_PA_DIDI_KEY_FILE: z.string().min(1).optional(),
  EIGOS_PA_DIDI_DIRECTORY: z.string().min(1),
  EIGOS_PA_DIDI_CONNECTION: z.string().regex(/^[a-f0-9]{64}$/),
}).parse(process.env);
const url = new URL(config.EIGOS_PA_URL);
if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/')
  throw new Error('Use the HTTPS origin of the original EIGOS connection');
const keyFile = config.EIGOS_PA_DIDI_KEY_FILE;
let connection: DidiPAOptions['connection'];
if (keyFile) {
  const secret = await readPrivateSourceFile(keyFile).then(value => value.trim()).catch(() => undefined);
  if (secret) {
    const keySha256 = createHash('sha256').update(secret).digest('hex');
    const reference = digest([config.EIGOS_PA_DIDI_CONNECTION, keySha256]);
    const binding = { bindingId: reference, keyFile, keySha256, environment: 'production' as const };
    connection = { reference, reads: new DidiMcpConnector(binding), orders: new DidiOperations(binding, true) };
  }
}
const pa = new DidiPA({
  ontology: new OntologyClient({ baseUrl: url.origin, token: config.EIGOS_PA_TOKEN,
    fetch: (target, init) => fetch(target, { ...init, redirect: 'error' }) }),
  privateDirectory: config.EIGOS_PA_DIDI_DIRECTORY, connection,
});
console.log(JSON.stringify(await pa.answer(taskId, AbortSignal.timeout(110000), permitDispatch)));
