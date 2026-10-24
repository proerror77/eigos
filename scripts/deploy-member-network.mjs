import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { createConnection } from 'node:net';
import { readConfig } from '../dist/packages/core/config.js';
import { assertSourceProxy } from '../dist/packages/core/private-source-proxy.js';
import { installReleaseDependencies } from '../dist/packages/deployment/dependencies.js';
import { releaseFiles } from '../dist/packages/deployment/files.js';
import { assertInviteBetaProxy } from '../dist/packages/deployment/invite-beta-proxy.js';
import { assertCloudflareFrontend, readCloudflareFrontend } from '../dist/packages/deployment/cloudflare-frontend.js';

// Dedicated profiles never replace com.eigos.grok-life. Frontend readback uses the operator's
// existing login; IdP provisioning and business execution are separate steps.
const { values } = parseArgs({ options: { config: { type: 'string' }, profile: { type: 'string', default: 'member-network' }, 'cloudflare-frontend': { type: 'string' }, 'take-over-from': { type: 'string' }, apply: { type: 'boolean', default: false } } });
if (!['member-network', 'invite-beta', 'shopify-checkout-private'].includes(values.profile)) throw new Error('Choose member-network, invite-beta or shopify-checkout-private');
const privateCheckout = values.profile === 'shopify-checkout-private';
const inviteBeta = values.profile === 'invite-beta';
if (values['cloudflare-frontend'] && !inviteBeta) throw new Error('Cloudflare publication is only supported for the invite-beta profile');
const cloudflareFrontend = values['cloudflare-frontend'] ? readCloudflareFrontend(values['cloudflare-frontend']) : undefined;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(homedir(), '.local/share/eigos', values.profile);
const label = `com.eigos.${values.profile}`, service = `gui/${process.getuid()}/${label}`;
const plistPath = join(homedir(), 'Library/LaunchAgents', `${label}.plist`), envPath = join(runtime, 'server.env');
if (process.platform !== 'darwin' || !values.config || !isAbsolute(values.config)) throw new Error('Use --config with an absolute private environment file on macOS');
const stat = lstatSync(values.config);
if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('Deployment configuration must be an owned private regular file');
const originalSettings = readFileSync(values.config, 'utf8'), settings = parseEnv(originalSettings), config = readConfig(settings);
if (config.DATABASE_PATH !== join(runtime, 'tasks.sqlite') || config.MEMBERSHIP_DATABASE_PATH !== join(runtime, 'members.sqlite')) throw new Error('Configure the exact dedicated task and membership database paths for this deployment profile');
if (inviteBeta) {
  if (config.EIGOS_INVITE_BETA !== 'true') throw new Error('The invite-beta deployment requires its constrained application profile');
} else if (privateCheckout) {
  if (config.EIGOS_AUTH_MODE !== 'development' || config.EIGOS_INVITE_BETA === 'true' || !config.EIGOS_SHOPIFY_CHECKOUT_MERCHANTS?.length
    || config.EIGOS_SHOPIFY_CHECKOUT_AUDIT_DIR !== join(runtime, 'shopify-checkout') || config.EIGOS_EXECUTOR !== 'codex'
    || config.EIGOS_NETWORK_ENABLED === 'true' || config.EIGOS_ACTION_SANDBOX === 'true' || config.EIGOS_PAOTUI_SKILL_DIR
    || config.EIGOS_MEMBER_SOURCE_KEY_FILE || config.EIGOS_MEMBER_SOURCE_TAILNET_ORIGIN || config.PUBLIC_URL !== `http://127.0.0.1:${config.PORT}`) throw new Error('Private checkout deployment requires its dedicated loopback configuration and source journal');
} else {
  if (config.EIGOS_INVITE_BETA === 'true' || !config.EIGOS_MEMBER_SOURCE_KEY_FILE || !config.EIGOS_MEMBER_SOURCE_TAILNET_ORIGIN || !existsSync(config.MEMBERSHIP_DATABASE_PATH)) throw new Error('Configure the dedicated member-network database, seeded membership and private source mode');
  const keyStat = lstatSync(config.EIGOS_MEMBER_SOURCE_KEY_FILE);
  if (!keyStat.isFile() || keyStat.nlink !== 1 || keyStat.uid !== process.getuid() || keyStat.size !== 32 || (keyStat.mode & 0o077)) throw new Error('Deployment requires an owned private 32-byte source key');
}
if (!privateCheckout && config.OAUTH_AUDIENCE !== (inviteBeta ? new URL(config.PUBLIC_URL).href : config.PUBLIC_URL)) throw new Error('The member deployment must use its exact canonical OAuth audience');
const assertProxy = () => privateCheckout ? undefined : inviteBeta ? (cloudflareFrontend ? assertCloudflareFrontend(config, cloudflareFrontend) : assertInviteBetaProxy(config)) : assertSourceProxy(config);
if (!inviteBeta || values.apply) assertProxy();
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
if (execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()) throw new Error('Deploy a reviewed committed checkout');
const ownership = join(runtime, 'owner.json');
const previousOwner = existsSync(ownership) ? JSON.parse(readFileSync(ownership, 'utf8')).sourceRoot : undefined;
if (previousOwner && previousOwner !== root && values['take-over-from'] !== previousOwner) throw new Error('Runtime belongs to another checkout; an authorized transfer must name its exact source root');
if (values['take-over-from'] && (!isAbsolute(values['take-over-from']) || values['take-over-from'] !== previousOwner)) throw new Error('Runtime ownership changed before the requested transfer');
const files = releaseFiles(root);
const hash = createHash('sha256'); for (const p of files) { hash.update(p + '\0'); hash.update(readFileSync(join(root, p))); }
const buildDigest = hash.digest('hex'), release = join(runtime, 'releases', buildDigest);
const oldPlist = existsSync(plistPath) ? readFileSync(plistPath, 'utf8') : undefined;
if (oldPlist && !oldPlist.includes(envPath)) throw new Error('LaunchAgent is not owned by this deployment');
const loaded = () => { try { execFileSync('launchctl', ['print', service], { stdio: 'ignore' }); return true; } catch { return false; } };
const listening = () => new Promise(resolveListening => { const socket = createConnection({ host: '127.0.0.1', port: config.PORT }); const done = value => { socket.destroy(); resolveListening(value); }; socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.setTimeout(500, () => done(true)); });
if (!loaded() && await listening()) throw new Error('The intended port belongs to another process');
if (!values.apply) { console.log(JSON.stringify({ status: 'prepared', sourceCommit, buildDigest, endpoint: config.PUBLIC_URL, label, runtime, profile: values.profile, frontend: privateCheckout ? 'loopback' : cloudflareFrontend ? 'cloudflare-tunnel' : 'tailscale', proxyVerification: privateCheckout ? 'loopback_only' : inviteBeta ? 'required_before_apply' : 'private_verified', ...(!inviteBeta && !privateCheckout ? { privateProxyVerified: true } : {}) })); process.exit(0); }
const write = (p, value) => { writeFileSync(p, value, { mode: 0o600 }); chmodSync(p, 0o600); };
for (const p of [runtime, release, dirname(plistPath)]) mkdirSync(p, { recursive: true, mode: 0o700 });
const backup = join(runtime, 'backups', new Date().toISOString().replaceAll(':', '-')); mkdirSync(backup, { recursive: true, mode: 0o700 });
for (const [i, p] of [envPath, plistPath, join(runtime, 'release.json'), ownership].entries()) if (existsSync(p)) cpSync(p, join(backup, String(i)));
for (const p of files) { const to = join(release, p); if (!existsSync(to)) { mkdirSync(dirname(to), { recursive: true }); cpSync(join(root, p), to); } if (!readFileSync(to).equals(readFileSync(join(root, p)))) throw new Error('Immutable release differs from the build'); }
installReleaseDependencies(root, runtime, release);
// Import the actual relocated modules before stopping an existing service.
try { execFileSync(process.execPath, ['--input-type=module', '-e', "await import('./dist/apps/gateway/app.js'); await import('./dist/apps/worker/runtime.js')"], { cwd: release, stdio: 'pipe', timeout: 15000 }); }
catch { throw new Error('Relocated runtime dependency verification failed; the existing service was not stopped'); }
const pause = ms => new Promise(r => setTimeout(r, ms));
async function stop() {
  if (loaded()) execFileSync('launchctl', ['bootout', service], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { if (!loaded() && !await listening()) return; await pause(250); }
  throw new Error('Member network did not stop; no replacement was started');
}
const xml = v => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const paths = [...new Set([dirname(process.execPath), dirname(settings.EIGOS_CODEX_BIN || '/usr/local/bin/codex'), join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'])].join(':');
const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${[process.execPath, `--env-file=${envPath}`, join(release, 'scripts/run-local.mjs'), '--built'].map(v => `<string>${xml(v)}</string>`).join('')}</array><key>WorkingDirectory</key><string>${xml(release)}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(paths)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer><key>Umask</key><integer>63</integer><key>StandardOutPath</key><string>${xml(join(runtime, 'runtime.log'))}</string><key>StandardErrorPath</key><string>${xml(join(runtime, 'runtime.log'))}</string></dict></plist>`;
try {
  await stop();
  for (const name of ['tasks.sqlite', 'members.sqlite']) if (existsSync(join(runtime, name))) execFileSync('python3', ['-c', 'import sqlite3,sys; a=sqlite3.connect(sys.argv[1]); b=sqlite3.connect(sys.argv[2]); a.backup(b); b.close(); a.close()', join(runtime, name), join(backup, name)], { stdio: 'pipe' });
  write(envPath, originalSettings.split('\n').filter(l => !l.startsWith('EIGOS_RELEASE_DIGEST=')).join('\n') + `\nEIGOS_RELEASE_DIGEST=${buildDigest}\n`); write(plistPath, plist);
  execFileSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, plistPath], { stdio: 'pipe' });
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { const health = await fetch(config.PUBLIC_URL + '/health', { redirect: 'error', signal: AbortSignal.timeout(1000) }).then(r => r.json()); if (health.releaseDigest === buildDigest) { ready = true; break; } } catch {} await pause(250);
  }
  if (!ready) throw new Error('The deployed member network did not become healthy');
  assertProxy();
  const metadata = privateCheckout ? undefined : await fetch(config.PUBLIC_URL + '/.well-known/oauth-protected-resource', { redirect: 'error', signal: AbortSignal.timeout(5000) }).then(r => r.json());
  if (inviteBeta) {
    if (JSON.stringify(metadata.scopes_supported) !== JSON.stringify(['openid', 'offline_access', 'services:read', 'tasks:read', 'tasks:write'])) throw new Error('Deployed beta scope discovery mismatch');
    const registration = await fetch(config.PUBLIC_URL + '/.well-known/eigos-agent-registration', { redirect: 'error', signal: AbortSignal.timeout(5000) }).then(r => r.json());
    if (registration.admission_policy !== 'invite-only' || registration.audience !== config.OAUTH_AUDIENCE || metadata.resource !== config.OAUTH_AUDIENCE) throw new Error('Deployed beta admission mismatch');
  } else if (!privateCheckout && !['sources:read', 'sources:write'].every(s => metadata.scopes_supported?.includes(s))) throw new Error('Deployed source discovery mismatch');
  const denied = await fetch(config.PUBLIC_URL + (inviteBeta || privateCheckout ? '/mcp' : '/sources/meituan-paotui'), { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (denied.status !== 401) throw new Error('Unauthenticated source access was not rejected');
  write(ownership, JSON.stringify({ sourceRoot: root }) + '\n');
  write(join(runtime, 'release.json'), JSON.stringify({ sourceCommit, buildDigest, release, files, profile: values.profile, frontend: privateCheckout ? 'loopback' : cloudflareFrontend ? 'cloudflare-tunnel' : 'tailscale', endpoint: config.PUBLIC_URL, updatedAt: new Date().toISOString() }) + '\n');
  console.log(JSON.stringify({ status: 'ready', sourceCommit, buildDigest, endpoint: config.PUBLIC_URL, profile: values.profile, proxyVerified: !privateCheckout, ...(privateCheckout ? { loopbackOnly: true } : {}), ...(!inviteBeta && !privateCheckout ? { privateProxyVerified: true } : {}), unauthenticatedStatus: denied.status, backup }));
} catch {
  await stop().catch(() => {});
  for (const [i, p] of [envPath, plistPath, join(runtime, 'release.json'), ownership].entries()) { const saved = join(backup, String(i)); if (existsSync(saved)) cpSync(saved, p); else if (existsSync(p)) unlinkSync(p); }
  if (oldPlist) try { execFileSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, plistPath], { stdio: 'ignore' }); } catch {}
  throw new Error('Member network deployment failed; previous owned service configuration was restored. Inspect the private runtime log.');
}
