import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RelayClient } from '../packages/agent-transport/client.js';
import { createProof, type NodeKeys } from '../packages/agent-transport/crypto.js';
import { RelayError } from '../packages/relay/contracts.js';

// This test is deliberately opt-in and restricted to disposable staging hosts.
// The supplied enrollment token must be synthetic and for that staging Relay.
const baseUrl = process.env.EIGOS_TEST_CF_RELAY_URL;
const ownerToken = process.env.EIGOS_TEST_CF_RELAY_TOKEN;
test('Cloudflare Relay accepts authenticated encrypted messages and enforces replay and revoke', { skip: !baseUrl || !ownerToken }, async () => {
  const origin = new URL(baseUrl!);
  if (origin.protocol !== 'https:' || !/^eigos-relay-stage-[a-f0-9]{12}\.[a-z0-9-]+\.workers\.dev$/.test(origin.hostname) || origin.origin !== baseUrl) throw new Error('Only the disposable Relay staging origin is permitted');
  const dir = mkdtempSync(join(tmpdir(), 'eigos-cf-relay-'));
  const a = await RelayClient.open({ baseUrl: baseUrl!, credentialPath: join(dir, 'a.json'), displayName: 'Synthetic A' });
  let b = await RelayClient.open({ baseUrl: baseUrl!, credentialPath: join(dir, 'b.json'), displayName: 'Synthetic B' });
  let aRegistered = false, bRegistered = false;
  try {
    await a.register(ownerToken!); aRegistered = true; await b.register(ownerToken!); bRegistered = true;
    const contact = await a.requestContact(b.agentId); await b.respondContact(contact.id, 'accept');
    const id = randomUUID();
    assert.equal((await a.send(b.agentId, contact.id, { fixture: 'cloudflare' }, { id })).status, 'queued');
    assert.equal((await a.deliver(id)).id, id);
    b.close();
    b = await RelayClient.open({ baseUrl: baseUrl!, credentialPath: join(dir, 'b.json'), displayName: 'Synthetic B' });
    assert.deepEqual((await b.poll()).map(item => item.content), [{ fixture: 'cloudflare' }]);
    assert.equal((await a.receipt(a.agentId, id)).status, 'received');
    const raw = JSON.parse(readFileSync(join(dir, 'a.json'), 'utf8'));
    const keys: NodeKeys = { signingKey: raw.signingKey, encryptionKey: raw.encryptionKey, identity: a.identity };
    if (process.env.EIGOS_TEST_CF_RELAY_VERSION) {
      const selfUrl = `${baseUrl}/v1/agents/${a.agentId}`;
      const selfProof = await createProof(keys,raw.secret,'GET',selfUrl);
      const self = await fetch(selfUrl,{headers:{Authorization:'DPoP '+raw.secret,DPoP:selfProof,'X-EIGOS-Agent-ID':a.agentId}});
      assert.equal(self.status,200);assert.equal(self.headers.get('X-EIGOS-Relay-Worker-Version'),process.env.EIGOS_TEST_CF_RELAY_VERSION);
      await self.arrayBuffer();
    }
    const proof = await createProof(keys, raw.secret, 'GET', baseUrl! + '/v1/contacts');
    const headers = { Authorization: 'DPoP ' + raw.secret, DPoP: proof, 'X-Eigos-Agent-Id': a.agentId };
    const first = await fetch(baseUrl! + '/v1/contacts', { headers });
    const replay = await fetch(baseUrl! + '/v1/contacts', { headers });
    assert.equal(first.status, 200); assert.equal(replay.status, 401);
    assert.equal((await replay.json() as { error: string }).error, 'DPOP_PROOF_REPLAY');
    await b.respondContact(contact.id, 'revoke');
    await assert.rejects(a.send(b.agentId, contact.id, { fixture: 'revoked' }), error => error instanceof RelayError && error.code === 'CONTACT_NOT_ACCEPTED');
  } finally {
    const cleanup = await Promise.allSettled([
      ...(aRegistered ? [a.revoke(ownerToken!)] : []),
      ...(bRegistered ? [b.revoke(ownerToken!)] : []),
    ]);
    a.close(); b.close(); rmSync(dir, { recursive: true, force: true });
    assert(cleanup.every(result => result.status === 'fulfilled'), 'Failed to revoke synthetic nodes');
  }
});
