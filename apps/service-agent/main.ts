import { setTimeout as delay } from 'node:timers/promises';
import { RelayClient } from '../../packages/agent-transport/client.js';
import { DidiRelayService, didiServiceConfigSchema } from '../../packages/agent-transport/didi-service.js';
import { readPrivateJson } from '../../packages/relay/files.js';

const path = process.env.EIGOS_SERVICE_AGENT_FILE;
if (!path) throw new Error('EIGOS_SERVICE_AGENT_FILE is required');
const config = didiServiceConfigSchema.parse(readPrivateJson(path));
const client = await RelayClient.open({ baseUrl: config.relayUrl, credentialPath: config.credentialPath, statePath: config.statePath, displayName: config.displayName });
const service = new DidiRelayService(client, config), stop = new AbortController();
process.on('SIGTERM', () => stop.abort()); process.on('SIGINT', () => stop.abort());
try {
  while (!stop.signal.aborted) {
    try {
      const contact = await client.requestContact(config.gatewayAgentId);
      if (contact.state === 'pending' && contact.recipient === client.agentId) await client.respondContact(contact.id, 'accept');
      await client.listen(message => service.handle(message, stop.signal), stop.signal);
    }
    catch {
      if (!stop.signal.aborted) await delay(1000, undefined, { signal: stop.signal }).catch(() => {});
    }
  }
} finally { service.close(); client.close(); }
