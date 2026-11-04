/** PA-local CLI. No order/payment command is offered or executed. */
import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { checkAlipayWallet, prepareTaobaoShopping, prepareAlipayRehearsal } from '../packages/pa/alipay-agent-pay.js';

function privateInput(path: string) {
  if (!isAbsolute(path)) throw new Error('Use an absolute PA-private input file');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || info.mode & 0o077 || info.size > 65536) {
      throw new Error('Input must be an owner-only regular file under 64 KiB');
    }
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    input: { type: 'string' }, executable: { type: 'string' }, sha256: { type: 'string' },
  } });
  if (positionals.length !== 1) throw new Error('Choose prepare or wallet-status; no order/payment command exists');
  if (positionals[0] === 'prepare') {
    if (!values.input || values.executable || values.sha256) throw new Error('prepare requires only --input');
    const raw = privateInput(values.input);
    const result = raw.order === undefined ? prepareTaobaoShopping(raw.catalogRead, raw.authority)
      : prepareAlipayRehearsal(raw.catalogRead, raw.authority, raw.order, raw.sessionId).preparation;
    console.log(JSON.stringify(result));
  } else if (positionals[0] === 'wallet-status') {
    if (!values.executable || !values.sha256 || values.input) throw new Error('wallet-status requires --executable and --sha256');
    process.stdout.write(await checkAlipayWallet({ executable: values.executable, sha256: values.sha256 }));
  } else throw new Error('Real Taobao orders and Alipay payment submission are disabled; use prepare');
}
main().catch(() => { console.error('PA preparation unavailable: check the private input, exact order/authority and pinned CLI. No real order or payment was submitted.'); process.exitCode = 1; });
