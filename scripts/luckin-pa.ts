import { createInterface } from 'node:readline/promises';
import { z } from 'zod';
import { OntologyClient } from '../packages/sdk/client.js';
import { LuckinMcp } from '../packages/sdk/luckin-mcp.js';
import { LuckinPA } from '../packages/sdk/luckin-pa.js';
import { proofHash } from '../packages/ontology/luckin.js';

const taskId = z.uuid().parse(process.argv[2]);
const submit = process.argv[3] === '--confirm-order';
if (process.argv.slice(3).some(argument => argument !== '--confirm-order')) throw new Error('Unexpected arguments');
if (submit && (!process.stdin.isTTY || !process.stderr.isTTY)) throw new Error('Order confirmation requires the PA user’s terminal');
const config = z.object({
  EIGOS_PA_URL: z.url(), EIGOS_PA_TOKEN: z.string().min(16), EIGOS_LUCKIN_PA_CONNECTION: proofHash,
  EIGOS_LUCKIN_PA_DIRECTORY: z.string().min(1), LUCKIN_MCP_TOKEN: z.string().min(16),
}).parse(process.env);
const url = new URL(config.EIGOS_PA_URL);
if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))
  throw new Error('Use HTTPS for the PA’s remote EIGOS connection');
const pa = new LuckinPA({
  ontology: new OntologyClient({ baseUrl: url.href, token: config.EIGOS_PA_TOKEN }),
  provider: new LuckinMcp(config.LUCKIN_MCP_TOKEN),
  localConnectionId: config.EIGOS_LUCKIN_PA_CONNECTION, privateDirectory: config.EIGOS_LUCKIN_PA_DIRECTORY,
  confirm: submit ? async ({ quote, expiresAt }, signal) => {
    const terminal = createInterface({ input: process.stdin, output: process.stderr });
    const lines = quote.items.map(item => `${item.quantity} × ${item.name}${item.optionsLabel ? `（${item.optionsLabel}）` : ''}`);
    const payable = (quote.totalMinor / 100).toFixed(2);
    try {
      const answer = await terminal.question([
        '瑞幸到店自取', `${quote.shop.name} · ${quote.shop.address}`, ...lines,
        `应付 ¥${payable} · 有效至 ${new Date(expiresAt).toLocaleTimeString('zh-CN')}`,
        '确认创建此订单，请输入「确认下单」\n',
      ].join('\n'), { signal });
      return answer.trim() === '确认下单';
    } finally { terminal.close(); }
  } : undefined,
});

const result = await pa.answer(taskId, AbortSignal.timeout(120000), submit ? 'submit' : 'read');
console.log(JSON.stringify(result));
