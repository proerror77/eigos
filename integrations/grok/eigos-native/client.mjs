#!/usr/bin/env node
// PA-side A2A transport. OAuth credentials stay in an owned private file and are
// refreshed by the existing installation-bound AgentConnector, never the model.
import { readFileSync, writeFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { AgentConnector, AgentConnectorError } from '../../../dist/packages/agent-client/client.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  profile: { type: 'string' }, input: { type: 'string' }, output: { type: 'string' },
} });
const command = positionals[0];
const emit = value => {
  const text = JSON.stringify(value, null, 2) + '\n';
  if (values.output) {
    const path = resolve(values.output); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = path + '.' + randomUUID() + '.tmp';
    writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' }); renameSync(temporary, path);
  }
  process.stdout.write(text);
};
try {
  if (!values.profile || !['discover', 'login', 'status', 'a2a'].includes(command) || positionals.length !== 1) throw new Error('invalid_arguments');
  const profilePath = resolve(values.profile), stat = statSync(profilePath);
  if ((stat.mode & 0o077) || stat.uid !== process.getuid()) throw new Error('private_profile_required');
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  if (typeof profile.baseUrl !== 'string' || new URL(profile.baseUrl).protocol !== 'https:' || new URL(profile.baseUrl).origin !== profile.baseUrl
    || typeof profile.credentialPath !== 'string' || !profile.credentialPath.startsWith('/') || typeof profile.displayName !== 'string') throw new Error('invalid_profile');
  if (command === 'discover') {
    const read = async path => {
      const r = await fetch(profile.baseUrl + path, { redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('discovery_failed'); return r.json();
    };
    const [runtime, agentCard] = await Promise.all([read('/health'), read('/.well-known/agent-card.json')]);
    if (runtime.instance !== profile.baseUrl || !agentCard.supportedInterfaces?.some(i => i.protocolBinding === 'JSONRPC' && i.protocolVersion === '1.0' && i.url === profile.baseUrl + '/a2a')) throw new Error('deployment_mismatch');
    emit({ baseUrl: profile.baseUrl, runtime, agentCard });
  } else {
    const agent = await AgentConnector.open(profile);
    if (command === 'login') {
      const status = await agent.status();
      if (['active','foundation_ready'].includes(status.status)) { await agent.accessToken(); emit({ status: status.status, registrationId: agent.registrationId }); }
      else {
        const authorization = await agent.beginAuthorization();
        process.stdout.write(JSON.stringify({ status: 'authorization_required', ...authorization }) + '\n');
        emit(await agent.finishAuthorization());
      }
    } else if (command === 'status') emit(await agent.status());
    else {
      if (!values.input) throw new Error('input_required');
      const bytes = readFileSync(resolve(values.input));
      if (bytes.length > 60000) throw new Error('request_too_large');
      const request = JSON.parse(bytes.toString('utf8'));
      if (request.jsonrpc !== '2.0' || !['SendMessage', 'GetTask', 'ListTasks', 'CancelTask'].includes(request.method)
        || !['string', 'number'].includes(typeof request.id) || !request.params || typeof request.params !== 'object'
        || (request.method === 'SendMessage' && !request.params.message?.messageId)) throw new Error('invalid_a2a_request');
      const response = await agent.fetch('/a2a', { method: 'POST', signal: AbortSignal.timeout(60000),
        headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' }, body: JSON.stringify(request) });
      if (!response.ok) { emit({ error: 'a2a_http_rejected', httpStatus: response.status }); process.exitCode = 1; }
      else {
        const result = await response.json();
        if (result.jsonrpc !== '2.0' || result.id !== request.id) throw new Error('a2a_response_mismatch');
        emit(result); if (result.error) process.exitCode = 1;
      }
    }
  }
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error instanceof AgentConnectorError ? error.code : 'eigos_client_operation_failed', ...(error instanceof AgentConnectorError && error.admission ? { admission: error.admission } : {}) }) + '\n');
  process.exitCode = 1;
}
