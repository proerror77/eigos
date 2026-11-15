import { z } from 'zod';
import { readPrivateSourceFile } from '../packages/core/private-source.js';
import { androidDiningMiniProgram, androidDiningReader } from '../packages/sdk/android-dining-miniprogram.js';
import { OntologyClient } from '../packages/sdk/client.js';
import { DiningMiniProgramPA, diningMiniProgramPASandbox } from '../packages/sdk/dining-miniprogram-pa.js';

const taskId = z.uuid().parse(process.argv[2]);
const env = z.object({
  EIGOS_PA_URL: z.url(), EIGOS_PA_TOKEN: z.string().min(16), EIGOS_DINING_MINIPROGRAM_PA_FILE: z.string().min(1),
}).parse(process.env);
const url = new URL(env.EIGOS_PA_URL);
if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1'))
  throw new Error('Use HTTPS for the PA connection or a local test Gateway');
const config = z.strictObject({ android: androidDiningMiniProgram.optional(), sandbox: diningMiniProgramPASandbox.optional() })
  .parse(JSON.parse(await readPrivateSourceFile(env.EIGOS_DINING_MINIPROGRAM_PA_FILE)));
const pa = new DiningMiniProgramPA({
  ontology: new OntologyClient({ baseUrl: url.href, token: env.EIGOS_PA_TOKEN }),
  readAvailability: config.android && androidDiningReader(config.android), sandbox: config.sandbox,
});
const continuation = await pa.answer(taskId, AbortSignal.timeout(90000));
console.log(JSON.stringify(continuation));
