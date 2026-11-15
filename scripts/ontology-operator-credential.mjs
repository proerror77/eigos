import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const profileDirectory = join(homedir(), '.local/share/eigos/primary-ontology-operator');
const credentialPath = join(profileDirectory, 'credentials.json');
const lockPath = join(profileDirectory, 'credentials.lock');

async function readPrivate(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > 65536) {
      throw new Error('The operator profile must be an owned private file');
    }
    return JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
}

const current = saved => typeof saved.access_token === 'string' && saved.expiresAt > Date.now() + 60000;

async function credential(profile) {
  const read = async () => {
    const saved = await readPrivate(credentialPath);
    if (!['issuer', 'clientId', 'tenant', 'subject'].every(key => saved[key] === profile[key])) {
      throw new Error('OAuth credential does not belong to this operator profile');
    }
    return saved;
  };
  const saved = await read();
  if (current(saved)) return { token: saved.access_token, refreshed: false };

  // Share the existing profile's refresh lock. Parallel callers re-read after rotation.
  const deadline = performance.now() + 20000;
  let lock;
  while (!lock) {
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST' || performance.now() >= deadline) throw error;
      await delay(200);
    }
  }
  try {
    const previous = await read();
    if (current(previous)) return { token: previous.access_token, refreshed: false };
    if (!previous.refresh_token) throw new Error('The operator needs an OAuth login');
    const response = await fetch(new URL('oauth/token', profile.issuer), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: profile.clientId, refresh_token: previous.refresh_token }),
    });
    if (!response.ok) throw new Error(`OAuth renewal failed (HTTP ${response.status})`);
    const tokens = await response.json();
    const { payload } = await jwtVerify(tokens.access_token, createRemoteJWKSet(new URL('.well-known/jwks.json', profile.issuer)), {
      issuer: profile.issuer, audience: profile.audience, algorithms: ['RS256', 'ES256', 'EdDSA'], requiredClaims: ['exp', 'sub'],
    });
    if (payload.sub !== profile.subject || payload[profile.tenantClaim] !== profile.tenant ||
        (payload.azp ?? payload.client_id) !== profile.clientId) throw new Error('OAuth renewal returned a different identity');
    const tmp = credentialPath + '.' + randomUUID();
    try {
      await writeFile(tmp, JSON.stringify({ ...previous, access_token: tokens.access_token,
        refresh_token: tokens.refresh_token ?? previous.refresh_token, expiresAt: payload.exp * 1000,
      }) + '\n', { mode: 0o600, flag: 'wx' });
      await rename(tmp, credentialPath);
    } finally {
      await unlink(tmp).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    return { token: tokens.access_token, refreshed: true };
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

export async function loadOperatorCredential() {
  const profile = await readPrivate(join(profileDirectory, 'profile.json'));
  const base = new URL(profile.baseUrl);
  if (base.origin !== 'https://eigos.mandonothing.com' || new URL(profile.issuer).protocol !== 'https:') {
    throw new Error('Unexpected operator service or issuer');
  }
  return { base, ...await credential(profile) };
}
