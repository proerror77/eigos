import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createApp } from '../apps/gateway/app.js';
import { readConfig } from '../packages/core/config.js';
import { fixture, route } from './fixture.js';
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import { jwtVerifier } from '../apps/gateway/auth.js';

test('MCP and A2A share the same authenticated PostgreSQL task and ontology', async () => {
  const f = await fixture(), token = 'synthetic-token-'.repeat(3);
  const config = readConfig({ DATABASE_URL: process.env.EIGOS_TEST_DATABASE_URL, EIGOS_AUTH_MODE: 'development', EIGOS_DEV_TOKEN: token });
  const gateway = createApp(config, f.db, f.source), server = gateway.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert(address && typeof address !== 'string'); const url = `http://127.0.0.1:${address.port}`;
  const client = new Client({ name: 'test-agent', version: '1' });
  try {
    assert.equal((await fetch(url + '/ontology')).status, 401);
    await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
    const result = await client.callTool({ name: 'submit_task', arguments: { requestId: 'protocol', message: '只询价', route } });
    const content = result.content as { text: string }[]; const task = JSON.parse(content[0]!.text);
    await f.worker.runOne();
    const response = await fetch(url + '/a2a', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, 'A2A-Version': '1.0' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: task.id } }) });
    const body = await response.json() as { result?: { id: string }; error?: unknown };
    assert.equal(body.result?.id, task.id, JSON.stringify(body));
  } finally { await client.close(); await new Promise<void>(resolve => server.close(() => resolve())); await f.close(); }
});

test('JWT identity, audience and expiry are verified before owner queries', async () => {
  const keys = await generateKeyPair('ES256'), publicKey = await exportJWK(keys.publicKey);
  const verify = jwtVerifier('https://issuer.example', 'eigos', createLocalJWKSet({ keys: [{ ...publicKey, kid: 'test' }] }));
  const sign = (audience: string, expiry: string) => new SignJWT({ tenant_id: 'test', scope: 'tasks:read' }).setProtectedHeader({ alg: 'ES256', kid: 'test' }).setIssuer('https://issuer.example').setAudience(audience).setSubject('owner').setIssuedAt().setExpirationTime(expiry).sign(keys.privateKey);
  const actor = await verify(await sign('eigos', '1m'));
  assert.deepEqual(actor.scopes, ['tasks:read']);
  await assert.rejects(verify(await sign('another-audience', '1m')));
  await assert.rejects(verify(await sign('eigos', '-1m')));
});

test('production issuer tenant claims resolve the same owner without a fallback identity', async () => {
  const keys = await generateKeyPair('ES256'), publicKey = await exportJWK(keys.publicKey);
  const jwks = createLocalJWKSet({ keys: [{ ...publicKey, kid: 'test' }] }), claim = 'https://eigos.example/claims/tenant_id';
  const token = await new SignJWT({ [claim]: 'personal', scope: 'tasks:read tasks:write' }).setProtectedHeader({ alg: 'ES256', kid: 'test' })
    .setIssuer('https://issuer.example').setAudience('eigos').setSubject('owner').setIssuedAt().setExpirationTime('1m').sign(keys.privateKey);
  const actor = await jwtVerifier('https://issuer.example', 'eigos', jwks, claim)(token);
  assert.deepEqual(actor.scopes, ['tasks:read', 'tasks:write']);
  await assert.rejects(jwtVerifier('https://issuer.example', 'eigos', jwks)(token));
});
