import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { createConnection } from 'node:net';
import { readConfig } from '../dist/packages/core/config.js';
import { assertSourceProxy } from '../dist/packages/core/private-source-proxy.js';
import { installReleaseDependencies } from '../dist/packages/deployment/dependencies.js';

// Separate from com.eigos.grok-life. No token acquisition, IdP changes or business calls.
const { values } = parseArgs({ options: { config: { type: 'string' }, apply: { type: 'boolean', default: false } } });
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(homedir(), '.local/share/eigos/member-network');
const label = 'com.eigos.member-network', service = `gui/${process.getuid()}/${label}`;
const plistPath = join(homedir(), 'Library/LaunchAgents', `${label}.plist`), envPath = join(runtime, 'server.env');
if (process.platform !== 'darwin' || !values.config || !isAbsolute(values.config)) throw new Error('Use --config with an absolute private environment file on macOS');
const stat = lstatSync(values.config);
if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('Deployment configuration must be an owned private regular file');
const originalSettings = readFileSync(values.config, 'utf8'), settings = parseEnv(originalSettings), config = readConfig(settings);
if (!config.EIGOS_MEMBER_SOURCE_KEY_FILE || !config.EIGOS_MEMBER_SOURCE_TAILNET_ORIGIN || config.DATABASE_PATH !== join(runtime, 'tasks.sqlite') || config.MEMBERSHIP_DATABASE_PATH !== join(runtime, 'members.sqlite') || !existsSync(config.MEMBERSHIP_DATABASE_PATH)) throw new Error('Configure the dedicated member-network database, seeded membership and private source mode');
const keyStat = lstatSync(config.EIGOS_MEMBER_SOURCE_KEY_FILE);
if (!keyStat.isFile() || keyStat.nlink !== 1 || keyStat.uid !== process.getuid() || keyStat.size !== 32 || (keyStat.mode & 0o077)) throw new Error('Deployment requires an owned private 32-byte source key');
if (config.OAUTH_AUDIENCE !== config.PUBLIC_URL) throw new Error('The member deployment must use its exact existing OAuth audience');
assertSourceProxy(config);
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
if (execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()) throw new Error('Deploy a reviewed committed checkout');
const ownership = join(runtime, 'owner.json');
if (existsSync(ownership) && JSON.parse(readFileSync(ownership, 'utf8')).sourceRoot !== root) throw new Error('Member network runtime belongs to another checkout');
const scan = p => readdirSync(p, { withFileTypes: true }).flatMap(e => e.isDirectory() ? scan(join(p, e.name)) : e.name.endsWith('.ts') ? [join(p, e.name)] : []);
const files = [...scan(join(root, 'apps')), ...scan(join(root, 'packages'))].sort().map(p => 'dist/' + p.slice(root.length + 1).replace(/\.ts$/, '.js'));
files.push('scripts/run-local.mjs', 'package.json', 'package-lock.json');
const hash = createHash('sha256'); for (const p of files) { hash.update(p + '\0'); hash.update(readFileSync(join(root, p))); }
const buildDigest = hash.digest('hex'), release = join(runtime, 'releases', buildDigest);
const oldPlist = existsSync(plistPath) ? readFileSync(plistPath, 'utf8') : undefined;
if (oldPlist && !oldPlist.includes(envPath)) throw new Error('LaunchAgent is not owned by this deployment');
const loaded = () => { try { execFileSync('launchctl', ['print', service], { stdio: 'ignore' }); return true; } catch { return false; } };
const listening = () => new Promise(resolveListening => { const socket = createConnection({ host: '127.0.0.1', port: config.PORT }); const done = value => { socket.destroy(); resolveListening(value); }; socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.setTimeout(500, () => done(true)); });
if (!loaded() && await listening()) throw new Error('The intended port belongs to another process');
if (!values.apply) { console.log(JSON.stringify({ status: 'prepared', sourceCommit, buildDigest, endpoint: config.PUBLIC_URL, label, runtime, privateProxyVerified: true })); process.exit(0); }
const write = (p, value) => { writeFileSync(p, value, { mode: 0o600 }); chmodSync(p, 0o600); };
for (const p of [runtime, release, dirname(plistPath)]) mkdirSync(p, { recursive: true, mode: 0o700 });
const backup = join(runtime, 'backups', new Date().toISOString().replaceAll(':', '-')); mkdirSync(backup, { recursive: true, mode: 0o700 });
for (const [i, p] of [envPath, plistPath, join(runtime, 'release.json')].entries()) if (existsSync(p)) cpSync(p, join(backup, String(i)));
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
  assertSourceProxy(config);
  const metadata = await fetch(config.PUBLIC_URL + '/.well-known/oauth-protected-resource', { redirect: 'error', signal: AbortSignal.timeout(5000) }).then(r => r.json());
  if (!['sources:read', 'sources:write'].every(s => metadata.scopes_supported?.includes(s))) throw new Error('Deployed source discovery mismatch');
  const denied = await fetch(config.PUBLIC_URL + '/sources/meituan-paotui', { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (denied.status !== 401) throw new Error('Unauthenticated source access was not rejected');
  write(ownership, JSON.stringify({ sourceRoot: root }) + '\n');
  write(join(runtime, 'release.json'), JSON.stringify({ sourceCommit, buildDigest, release, files, endpoint: config.PUBLIC_URL, updatedAt: new Date().toISOString() }) + '\n');
  console.log(JSON.stringify({ status: 'ready', sourceCommit, buildDigest, endpoint: config.PUBLIC_URL, privateProxyVerified: true, unauthenticatedStatus: denied.status, backup }));
} catch {
  await stop().catch(() => {});
  for (const [i, p] of [envPath, plistPath, join(runtime, 'release.json')].entries()) { const saved = join(backup, String(i)); if (existsSync(saved)) cpSync(saved, p); else if (existsSync(p)) unlinkSync(p); }
  if (oldPlist) try { execFileSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, plistPath], { stdio: 'ignore' }); } catch {}
  throw new Error('Member network deployment failed; previous owned service configuration was restored. Inspect the private runtime log.');
}
