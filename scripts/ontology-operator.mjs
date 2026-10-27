import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import * as oidc from 'openid-client';
import { createRemoteJWKSet, decodeJwt } from 'jose';
import { jwtVerifier } from '../dist/apps/gateway/auth.js';
import { ontologyOperatorProfileSchema, ontologyOperatorScopes, assertOntologyOperator } from '../dist/packages/members/ontology-operator.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { profile: { type: 'string' }, input: { type: 'string' }, help: { type: 'boolean' } } });
if (values.help) {
  console.log('node ontology-operator.mjs --profile /private/operator/profile.json <login|status|query|command> [--input /path/request.json]');
  process.exit(0);
}
if (!values.profile || positionals.length !== 1 || !['login', 'status', 'query', 'command'].includes(positionals[0])) throw new Error('Use --help for the operator entry commands');
const command = positionals[0], profilePath = resolve(values.profile), directory = dirname(profilePath), credentialsPath = join(directory, 'credentials.json'), handoffPath = join(directory, 'login.json');
const directoryStat = lstatSync(directory);
if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || directoryStat.uid !== process.getuid?.() || directoryStat.mode & 0o077) throw new Error('Use an owned private operator directory');
function readJson(path, maxBytes = 65536, privateFile = true) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.size > maxBytes || privateFile && stat.mode & 0o077) throw new Error('Operator input must be an owned bounded regular file');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}
function save(path, value) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}
const profile = ontologyOperatorProfileSchema.parse(readJson(profilePath)), lockPath = join(directory, 'credentials.lock');
const lock = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
writeFileSync(lock, String(process.pid));
let stage = 'discovery', server;
try {
  const config = await oidc.discovery(new URL(profile.issuer), profile.clientId, undefined, oidc.None(), { timeout: 15 });
  oidc.enableNonRepudiationChecks(config);
  const jwks = new URL(config.serverMetadata().jwks_uri);
  if (jwks.protocol !== 'https:') throw new Error('Issuer keys must use HTTPS');
  const verify = jwtVerifier(profile.issuer, profile.audience, createRemoteJWKSet(jwks), profile.tenantClaim);
  const checked = async token => { const principal = await verify(token); assertOntologyOperator(profile, principal); return principal; };
  async function storeTokens(tokens, previous) {
    const principal = await checked(tokens.access_token), expiresAt = decodeJwt(tokens.access_token).exp * 1000;
    const refresh = tokens.refresh_token ?? previous?.refresh_token;
    save(credentialsPath, { version: 1, issuer: profile.issuer, clientId: profile.clientId, subject: principal.subject, tenant: principal.tenant,
      access_token: tokens.access_token, ...(refresh ? { refresh_token: refresh } : {}), expiresAt });
    return { token: tokens.access_token, principal };
  }
  let access;
  if (command === 'login') {
    stage = 'login';
    const callback = new URL(profile.callbackUrl), verifier = oidc.randomPKCECodeVerifier(), state = oidc.randomState(), nonce = oidc.randomNonce();
    const authorizationUrl = oidc.buildAuthorizationUrl(config, { redirect_uri: callback.href, audience: profile.audience,
      scope: ['openid', 'offline_access', ...ontologyOperatorScopes].join(' '), state, nonce, prompt: 'consent',
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256' });
    let consumed = false;
    server = createServer();
    const authorization = new Promise((resolveGrant, rejectGrant) => {
      server.on('request', (req, res) => {
        res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
        let url;
        try { url = new URL(req.url ?? '/', callback); } catch { res.writeHead(400); res.end(); return; }
        if (req.method !== 'GET' || req.headers.host !== callback.host || url.origin !== callback.origin || url.pathname !== callback.pathname || consumed) { res.writeHead(404); res.end(); return; }
        consumed = true;
        void oidc.authorizationCodeGrant(config, url, { pkceCodeVerifier: verifier, expectedState: state, expectedNonce: nonce, idTokenExpected: true }).then(tokens => {
          if (tokens.claims()?.sub !== profile.subject || tokens.claims()?.iss !== profile.issuer) throw new Error('The signed-in member is not the configured operator');
          return storeTokens(tokens);
        }).then(value => {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('EIGOS 本体操作员登录完成，可以返回任务。'); resolveGrant(value);
        }, () => { res.writeHead(400); res.end('Operator login did not complete. Return to the EIGOS task.'); rejectGrant(new Error('Operator authorization failed')); });
      });
    });
    void authorization.catch(() => {});
    server.listen(Number(callback.port), '127.0.0.1'); await once(server, 'listening');
    save(handoffPath, { status: 'awaiting_login', authorizationUrl: authorizationUrl.href, createdAt: new Date().toISOString() });
    console.log(JSON.stringify({ status: 'awaiting_login', handoff: handoffPath }));
    let deadline;
    try { access = await Promise.race([authorization, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Operator login expired')), 600000); })]); }
    finally { clearTimeout(deadline); server.closeAllConnections(); await new Promise(done => server.close(done)); server = undefined; }
    save(handoffPath, { status: 'identity_verified', clientId: profile.clientId, at: new Date().toISOString() });
    console.log(JSON.stringify({ status: 'identity_verified', clientId: profile.clientId, scopes: access.principal.scopes, installationAndSourceGrants: 'separate' }));
  } else {
    stage = 'credentials';
    const saved = readJson(credentialsPath);
    if (saved.version !== 1 || saved.issuer !== profile.issuer || saved.clientId !== profile.clientId || saved.subject !== profile.subject || saved.tenant !== profile.tenant) throw new Error('Operator credential belongs to another profile');
    if (typeof saved.access_token !== 'string' || !Number.isFinite(saved.expiresAt)) throw new Error('Operator credential is incomplete');
    if (saved.expiresAt < Date.now() + 60000) {
      if (typeof saved.refresh_token !== 'string') throw new Error('Run operator login to obtain a new credential');
      access = await storeTokens(await oidc.refreshTokenGrant(config, saved.refresh_token), saved);
    } else access = { token: saved.access_token, principal: await checked(saved.access_token) };
    stage = command;
    const path = command === 'status' ? '/security/context' : command === 'query' ? '/ontology/v1/query' : '/ontology/v1/commands';
    if (command !== 'status' && !values.input) throw new Error('Use an explicit --input file for a metadata request');
    const body = command === 'status' ? {} : readJson(resolve(values.input), 48000, false);
    const response = await fetch(profile.baseUrl + path, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: 'Bearer ' + access.token, 'Content-Type': 'application/json', 'User-Agent': 'EIGOS-Ontology-Operator/1.0' }, body: JSON.stringify(body) });
    let bytes = 0; const chunks = [];
    if (!response.body) throw new Error('Operator response is missing');
    for await (const chunk of response.body) { bytes += chunk.byteLength; if (bytes > 512000) throw new Error('Operator response exceeds its bound'); chunks.push(Buffer.from(chunk)); }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    console.log(JSON.stringify({ status: response.status, ...(command === 'status' ? { clientId: profile.clientId, scopes: access.principal.scopes } : {}), result }, null, 2));
    if (!response.ok) process.exitCode = 1;
  }
} catch {
  save(join(directory, 'last-error.json'), { stage, at: new Date().toISOString() });
  console.error(`Operator ${stage} did not complete. Inspect its private profile and authorization state; credentials were not printed.`);
  process.exitCode = 1;
} finally {
  server?.closeAllConnections(); if (server?.listening) await new Promise(done => server.close(done));
  closeSync(lock); unlinkSync(lockPath);
}
