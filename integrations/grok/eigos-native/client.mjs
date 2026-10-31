#!/usr/bin/env node
// PA-side A2A and optional encrypted Relay transports. OAuth credentials stay in an owned private file and are
// refreshed by the existing installation-bound AgentConnector, never the model.
import { readFileSync, writeFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { AgentConnector, AgentConnectorError } from '../../../dist/packages/agent-client/client.js';
import { TaskRelayClient, TaskRelayError } from '../../../dist/packages/agent-client/relay.js';
import { RelayClient } from '../../../dist/packages/agent-transport/client.js';
import { taskRelayMetadataSchema, taskRelayProfileSchema } from '../../../dist/packages/agent-transport/task-contracts.js';
import { z } from 'zod';
import { prepareA2ATaskRequest, AgentTaskInputError } from '../../../dist/packages/agent-client/task-input.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  profile: { type: 'string' }, input: { type: 'string' }, output: { type: 'string' },
} });
const command = positionals[0];
let pendingRelayReceipt;
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
  if (!values.profile || !['discover', 'login', 'status', 'a2a', 'relay', 'relay-enroll', 'relay-renew', 'relay-bind'].includes(command) || positionals.length !== 1) throw new Error('invalid_arguments');
  const profilePath = resolve(values.profile), stat = statSync(profilePath);
  if ((stat.mode & 0o077) || stat.uid !== process.getuid()) throw new Error('private_profile_required');
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  if (typeof profile.baseUrl !== 'string' || new URL(profile.baseUrl).protocol !== 'https:' || new URL(profile.baseUrl).origin !== profile.baseUrl
    || typeof profile.credentialPath !== 'string' || !profile.credentialPath.startsWith('/') || typeof profile.displayName !== 'string') throw new Error('invalid_profile');
  let a2aRequest;
  if (command === 'a2a') {
    if (!values.input) throw new AgentTaskInputError(['input']);
    const bytes = readFileSync(resolve(values.input));
    if (bytes.length > 60000) throw new AgentTaskInputError(['input']);
    let input;
    try { input = JSON.parse(bytes.toString('utf8')); } catch { throw new AgentTaskInputError(['input']); }
    a2aRequest = prepareA2ATaskRequest(input);
  }
  if (command === 'discover') {
    const read = async path => {
      const r = await fetch(profile.baseUrl + path, { redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('discovery_failed'); return r.json();
    };
    const [runtime, agentCard] = await Promise.all([read('/health'), read('/.well-known/agent-card.json')]);
    if (runtime.instance !== profile.baseUrl || !agentCard.supportedInterfaces?.some(i => i.protocolBinding === 'JSONRPC' && i.protocolVersion === '1.0' && i.url === profile.baseUrl + '/a2a')) throw new Error('deployment_mismatch');
    let taskRelay;
    if (profile.relay) {
      const settings = taskRelayProfileSchema.parse(profile.relay);
      taskRelay = taskRelayMetadataSchema.parse(await read('/.well-known/eigos-task-relay'));
      if (taskRelay.gatewayOrigin !== profile.baseUrl || taskRelay.relayUrl !== settings.baseUrl || taskRelay.authorityId !== settings.authorityId || taskRelay.gatewayAgentId !== settings.gatewayAgentId) throw new Error('relay_authority_mismatch');
    }
    emit({ baseUrl: profile.baseUrl, runtime, agentCard, ...(taskRelay ? { taskRelay } : {}) });
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
    else if (command.startsWith('relay')) {
      const settings = taskRelayProfileSchema.parse(profile.relay);
      const metadataResponse = await agent.fetch('/.well-known/eigos-task-relay', { signal: AbortSignal.timeout(15000) });
      if (!metadataResponse.ok) throw new Error('relay_metadata_unavailable');
      const metadata = taskRelayMetadataSchema.parse(await metadataResponse.json());
      if (metadata.authorityId !== settings.authorityId || metadata.gatewayAgentId !== settings.gatewayAgentId || metadata.gatewayOrigin !== profile.baseUrl || metadata.relayUrl !== settings.baseUrl) throw new Error('relay_authority_mismatch');
      const node = await RelayClient.open({ baseUrl: settings.baseUrl, credentialPath: settings.credentialPath, displayName: profile.displayName });
      try {
        if (command === 'relay-enroll' || command === 'relay-renew') {
          const renewal = command === 'relay-renew' ? z.strictObject({ requestId: z.uuid() }).parse(JSON.parse(readFileSync(resolve(values.input ?? ''), 'utf8'))) : undefined;
          emit(await agent.enrollTaskRelay(node, { renew: !!renewal, requestId: renewal?.requestId }));
        }
        else {
          const pa = new TaskRelayClient(node, agent, settings), binding = await pa.bind();
          if (command === 'relay-bind') emit(binding);
          else {
            if (!values.input) throw new Error('input_required');
            const bytes = readFileSync(resolve(values.input)); if (bytes.length > 30000) throw new Error('request_too_large');
            const request = JSON.parse(bytes.toString('utf8')), signal = AbortSignal.timeout(60000);
            const sent = await pa.send(request, { signal });
            pendingRelayReceipt = { protocol: metadata.protocol, authorityId: binding.authorityId, requestId: sent.requestId, messageId: sent.messageId, transportReceipt: sent.receipt };
            emit({ ...pendingRelayReceipt, task: await pa.receive(sent.requestId, signal) });
          }
        }
      } finally { node.close(); }
    }
    else {
      const request = a2aRequest;
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
  const result = { error: error instanceof AgentConnectorError || error instanceof TaskRelayError || error instanceof AgentTaskInputError ? error.code : 'eigos_client_operation_failed', ...(error instanceof AgentTaskInputError ? { fields: error.fields } : {}), ...(error instanceof AgentConnectorError && error.admission ? { admission: error.admission } : {}), ...(pendingRelayReceipt ? { relay: pendingRelayReceipt } : {}) };
  if (pendingRelayReceipt || error instanceof AgentTaskInputError) emit(result); else process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = 1;
}
