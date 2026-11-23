// Run on the PA host. Emit only the normalized readback and receipt requested by EIGOS.
import { createHash, randomUUID } from 'node:crypto';
import { readPrivateSourceFile } from '../dist/packages/core/private-source.js';
import { digest } from '../dist/packages/core/identity.js';
import { DidiMcpConnector, DidiReadError } from '../dist/packages/capabilities/didi/connector.js';
import { didiPAReadTool, didiPAReceipt } from '../dist/packages/capabilities/didi/pa-read.js';
import { didiToolInputs } from '../dist/packages/capabilities/didi/contracts.js';

const [, , toolArg, json, expectedDigest] = process.argv;
const method = didiPAReadTool.parse(toolArg);
const args = didiToolInputs[method].parse(JSON.parse(json));
if (digest(args) !== expectedDigest) throw new Error('Arguments differ from the original EIGOS request');
const keyFile = process.env.EIGOS_PA_DIDI_KEY_FILE;
const reporter = report => process.stdout.write(JSON.stringify(report) + '\n');
try {
  const key = (await readPrivateSourceFile(keyFile)).trim();
  const connector = new DidiMcpConnector({
    bindingId: 'pa-local', keyFile, keySha256: createHash('sha256').update(key).digest('hex'), environment: 'production',
  });
  const { data, receipt } = await connector.invoke({ requestId: randomUUID(), requestRevision: 1 }, method, args, AbortSignal.timeout(30_000));
  const { bindingId: _bindingId, environment: _environment, ...proof } = receipt;
  reporter({ status: 'observed', data, receipt: didiPAReceipt.parse(proof) });
} catch (error) {
  const providerDenied = error instanceof DidiReadError && ['AUTH_REJECTED', 'PRIVATE_CREDENTIAL_UNAVAILABLE'].includes(error.code);
  reporter({ status: !keyFile || providerDenied ? 'authorization_required' : 'unavailable' });
}
