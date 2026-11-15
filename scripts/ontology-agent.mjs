import { randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const directory = join(homedir(), '.local/share/eigos/primary-ontology-operator');
const read = async name => JSON.parse(await readFile(join(directory, name), 'utf8'));

async function credential() {
  const profile = await read('profile.json');
  const endpoint = new URL('/mcp', profile.baseUrl);
  if (endpoint.origin !== 'https://eigos.mandonothing.com') throw new Error('Unexpected EIGOS endpoint');
  const lockPath = join(directory, 'credentials.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  try {
    const saved = await read('credentials.json');
    if (!['issuer', 'clientId', 'subject', 'tenant'].every(key => saved[key] === profile[key])) {
      throw new Error('Saved OAuth credential belongs to a different Agent profile');
    }
    if (saved.expiresAt > Date.now() + 60000) return { endpoint, token: saved.access_token, refreshed: false };
    if (!saved.refresh_token) throw new Error('The Agent profile needs an OAuth login');
    const response = await fetch(new URL('oauth/token', profile.issuer), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      body: new URLSearchParams({
        grant_type: 'refresh_token', client_id: profile.clientId, refresh_token: saved.refresh_token,
      }),
    });
    if (!response.ok) throw new Error(`OAuth renewal failed (HTTP ${response.status})`);
    const tokens = await response.json();
    const { payload } = await jwtVerify(
      tokens.access_token, createRemoteJWKSet(new URL('.well-known/jwks.json', profile.issuer)),
      { issuer: profile.issuer, audience: profile.audience, algorithms: ['RS256', 'ES256', 'EdDSA'], requiredClaims: ['exp'] },
    );
    if (payload.sub !== profile.subject || payload[profile.tenantClaim] !== profile.tenant ||
        (payload.azp ?? payload.client_id) !== profile.clientId) {
      throw new Error('OAuth renewal returned a different Agent identity');
    }
    const path = join(directory, 'credentials.json');
    const candidate = path + '.' + randomUUID();
    try {
      await writeFile(candidate, JSON.stringify({
        ...saved, access_token: tokens.access_token, refresh_token: tokens.refresh_token ?? saved.refresh_token,
        expiresAt: payload.exp * 1000,
      }) + '\n', { mode: 0o600, flag: 'wx' });
      await rename(candidate, path);
    } finally {
      await unlink(candidate).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    return { endpoint, token: tokens.access_token, refreshed: true };
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

async function main() {
  const [city, origin, destination, requestId = randomUUID()] = process.argv.slice(2);
  if (!city || !origin || !destination) throw new Error('Usage: ontology-agent.mjs CITY ORIGIN DESTINATION [REQUEST_ID]');
  const startedAt = new Date().toISOString(), started = performance.now();
  const auth = await credential(), authorized = performance.now();
  const client = new Client({ name: 'codex-production-ontology-agent', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(auth.endpoint, {
      requestInit: { headers: { Authorization: 'Bearer ' + auth.token }, redirect: 'error' },
      reconnectionOptions: { maxRetries: 0 },
    }), { timeout: 10000 });
    const connected = performance.now();
    const result = await client.callTool({
      name: 'complete_with_action',
      arguments: {
        requestId,
        action: { interface: { type: 'RideInquiry', action: 'estimate', implementation: 'RideRequest' },
          input: { city, origin, destination } },
        read: { function: 'readRideEstimates', resultParameter: 'request' },
      },
    }, { timeout: 35000 });
    const returnedAt = new Date().toISOString(), returned = performance.now();
    if (result.isError) throw new Error(result.content?.[0]?.text ?? 'EIGOS quote failed');
    const quote = JSON.parse(result.content[0].text);
    if (quote.accepted !== true || !quote.evidence?.includes('live_readonly')) {
      throw new Error('EIGOS did not return a verified live quote');
    }
    console.log(JSON.stringify({
      requestId, startedAt, returnedAt, refreshed: auth.refreshed,
      timingMs: {
        credentials: Math.round(authorized - started), connect: Math.round(connected - authorized),
        call: Math.round(returned - connected), total: Math.round(returned - started),
      },
      request: quote.request, accepted: quote.accepted, evidence: quote.evidence,
      route: Object.fromEntries(Object.entries(quote.route).map(([side, { name, address }]) => [side, { name, address }])),
      estimates: quote.estimates.map(({ properties: { name, priceText, expiresAt } }) => ({ name, priceText, expiresAt })),
    }));
  } finally {
    await client.close().catch(() => {});
  }
}

main().catch(error => {
  // Transport errors can contain request details; do not print arbitrary exceptions.
  const message = error instanceof Error ? error.message : '';
  console.error(/^(Usage:|EIGOS did not|OAuth renewal|Unexpected EIGOS|Saved OAuth|The Agent profile|请确认)/.test(message)
    ? message : 'EIGOS Agent call failed. Check the authorized local profile, connection and tool availability.');
  process.exitCode = 1;
});
