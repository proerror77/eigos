import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { betaFeishuConfig, FeishuBetaReview } from '../packages/capabilities/feishu/beta-review.js';
import { readPrivateSourceFile } from '../packages/core/private-source.js';
import { BetaReview } from '../packages/runtime/beta-review.js';
import { Database } from '../packages/runtime/database.js';

const env = z.object({
  DATABASE_URL: z.string().min(1), EIGOS_PG_SCHEMA: z.string().optional(),
  EIGOS_SIGNUP: z.literal('invite').default('invite'), EIGOS_BETA_FEISHU_FILE: z.string().min(1),
}).parse(process.env);
const once = process.argv[2] === '--once';
if (process.argv.length > (once ? 3 : 2)) throw new Error('Use beta-feishu-review with no arguments or --once');
const config = betaFeishuConfig.parse(JSON.parse(await readPrivateSourceFile(env.EIGOS_BETA_FEISHU_FILE)));
const database = new Database(env.DATABASE_URL, env.EIGOS_PG_SCHEMA);
const review = new BetaReview(database, new FeishuBetaReview(config));
const stopping = new AbortController();
process.once('SIGINT', () => stopping.abort());
process.once('SIGTERM', () => stopping.abort());
try {
  do {
    const result = await review.poll().catch(() => ({ reviewed: 0, failures: 1 }));
    if (once || result.failures) console.log(JSON.stringify({ event: 'beta_feishu_review', ...result }));
    if (once) {
      if (result.failures) process.exitCode = 1;
      break;
    }
    await setTimeout(15_000, undefined, { signal: stopping.signal }).catch(error => {
      if (!stopping.signal.aborted) throw error;
    });
  } while (!stopping.signal.aborted);
} finally { await database.close(); }
