// Run on the user's own PA host after EIGOS registration and official Meituan
// authorization. This is explicit credential transfer, never part of npm test.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { AgentConnector } from '../packages/agent-client/client.js';

const exec = promisify(execFile);
try {
  const baseUrl = process.env.PUBLIC_URL, path = process.env.EIGOS_AGENT_CREDENTIAL_PATH;
  if (!baseUrl || !path) throw new Error('configuration_required');
  const pa = await AgentConnector.open({ baseUrl, credentialPath: resolve(path), displayName: 'Personal Agent' });
  const response = await pa.fetch('/sources/meituan-paotui');
  if (!response.ok) throw new Error('source_scope_or_membership_required');
  const status = await response.json();
  if (!Number.isSafeInteger(status.revision) || status.revision < 0) throw new Error('invalid_source_status');
  const result = await pa.connectSource({ requestId: randomUUID(), expectedRevision: status.revision, loadCredential: async () => {
    // stdout stays in memory. No token arguments, files, logs or model context.
    const result = await exec('pt-passport', ['get-token', '--client_id', 'ac76c22d257c4c6d9164719eea64ed4b'], { timeout: 10000, maxBuffer: 65536 });
    const token = result.stdout.trim().split('\n').at(-1);
    if (!token || token.length < 16 || token.length > 16384 || /\s/.test(token)) throw new Error('provider_authorization_required_on_pa_host');
    return { token, expiresAt: new Date(Date.now() + 3600000).toISOString() };
  } });
  console.log(JSON.stringify(result));
} catch {
  // CLI and network exceptions can embed secrets; never print their messages.
  console.error('Source connection failed. Check EIGOS membership/source consent and the user\'s official Meituan authorization on this PA host, then inspect connection status.');
  process.exitCode = 1;
}
