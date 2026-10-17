import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, cpSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// A private, single-user Mac runtime. No changes to .env, Auth0, or other services.
if (process.platform !== 'darwin') throw new Error('This setup uses macOS launchd');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = join(root, 'data/grok-life');
mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
// launchd does not inherit the desktop app's Documents-folder access. Stage the
// owned build outside protected folders instead of requesting broader permissions.
const runtime = join(homedir(), '.local/share/eigos/grok-life');
mkdirSync(runtime, { recursive: true, mode: 0o700 }); chmodSync(runtime, 0o700);
const ownership = join(runtime, 'owner.json');
if (existsSync(ownership) && JSON.parse(readFileSync(ownership, 'utf8')).sourceRoot !== root) throw new Error('Runtime belongs to another checkout');
writeFileSync(ownership, JSON.stringify({ sourceRoot: root }) + '\n', { mode: 0o600 });
const envPath = join(directory, 'server.env');
const tokenPath = join(directory, 'token');
const marker = '# EIGOS managed Grok life intake';
if (!existsSync(join(root, 'dist/apps/gateway/main.js'))) throw new Error('Build the project before setup');
let token;
if (existsSync(envPath)) {
  const saved = readFileSync(envPath, 'utf8');
  if (!saved.startsWith(marker)) throw new Error('Existing runtime settings are not owned by this setup');
  token = saved.split('\n').find(line => line.startsWith('EIGOS_DEV_TOKEN='))?.slice('EIGOS_DEV_TOKEN='.length);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Saved runtime credential is invalid');
} else {
  token = randomBytes(32).toString('hex');
}
const settings = [marker, 'NODE_ENV=development', 'HOST=127.0.0.1', 'PORT=3430', 'PUBLIC_URL=http://127.0.0.1:3430',
  `DATABASE_PATH=${join(runtime, 'tasks.sqlite')}`, 'EIGOS_AUTH_MODE=development', `EIGOS_DEV_TOKEN=${token}`,
  'EIGOS_LIFE_INTAKE=true', 'EIGOS_COORDINATOR=disabled', 'EIGOS_EXECUTOR=disabled', 'EIGOS_CSV_PILOT=false',
  'EIGOS_PAOTUI_ORDERS_ENABLED=false', `EIGOS_AUDIT_PATH=${join(runtime, 'http.jsonl')}`, ''].join('\n');
writeFileSync(envPath, settings, { mode: 0o600 });
if (existsSync(tokenPath) && readFileSync(tokenPath, 'utf8').trim() !== token) throw new Error('Existing client credential does not match runtime');
writeFileSync(tokenPath, token + '\n', { mode: 0o600 }); chmodSync(tokenPath, 0o600); chmodSync(envPath, 0o600);
const dependencyHash = createHash('sha256').update(readFileSync(join(root, 'package-lock.json'))).digest('hex');
const dependencyStamp = join(runtime, 'dependencies.sha256');
if (!existsSync(dependencyStamp) || readFileSync(dependencyStamp, 'utf8') !== dependencyHash) {
  cpSync(join(root, 'node_modules'), join(runtime, 'node_modules'), { recursive: true });
  writeFileSync(dependencyStamp, dependencyHash, { mode: 0o600 });
}
cpSync(join(root, 'dist'), join(runtime, 'dist'), { recursive: true });
mkdirSync(join(runtime, 'scripts'), { recursive: true });
cpSync(join(root, 'scripts/run-local.mjs'), join(runtime, 'scripts/run-local.mjs'));
cpSync(join(root, 'package.json'), join(runtime, 'package.json'));
const runtimeEnv = join(runtime, 'server.env'); writeFileSync(runtimeEnv, settings, { mode: 0o600 }); chmodSync(runtimeEnv, 0o600);
writeFileSync(join(directory, 'runtime-location.json'), JSON.stringify({ runtime, database: join(runtime, 'tasks.sqlite'), audit: join(runtime, 'http.jsonl') }) + '\n', { mode: 0o600 });
const label = 'com.eigos.grok-life';
const launchDirectory = join(homedir(), 'Library/LaunchAgents'); mkdirSync(launchDirectory, { recursive: true });
const plistPath = join(launchDirectory, `${label}.plist`);
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const strings = values => values.map(value => `<string>${xml(value)}</string>`).join('');
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${strings([process.execPath, `--env-file=${runtimeEnv}`, join(runtime, 'scripts/run-local.mjs'), '--built'])}</array>
<key>WorkingDirectory</key><string>${xml(runtime)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(join(runtime, 'runtime.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(runtime, 'runtime.log'))}</string>
</dict></plist>\n`;
const previousPlist = existsSync(plistPath) ? readFileSync(plistPath, 'utf8') : '';
if (previousPlist && !previousPlist.includes(xml(envPath)) && !previousPlist.includes(xml(runtimeEnv))) throw new Error('LaunchAgent label is owned by another checkout');
writeFileSync(plistPath, plist, { mode: 0o600 }); chmodSync(plistPath, 0o600);
const service = `gui/${process.getuid()}/${label}`;
let loaded = false;
try { execFileSync('launchctl', ['print', service], { stdio: 'ignore' }); loaded = true; } catch {}
if (loaded && previousPlist !== plist) {
  execFileSync('launchctl', ['bootout', service], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { execFileSync('launchctl', ['print', service], { stdio: 'ignore' }); }
    catch { loaded = false; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (loaded) throw new Error('Previous launch configuration is still unloading; retry after it stops');
} else if (loaded && process.argv.includes('--restart')) {
  // Restart the existing job; immediate bootout/bootstrap can race launchd removal.
  execFileSync('launchctl', ['kickstart', '-k', service], { stdio: 'pipe' });
}
if (!loaded) execFileSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, plistPath], { stdio: 'pipe' });
let ready = false;
for (let i = 0; i < 50; i++) {
  try {
    const response = await fetch('http://127.0.0.1:3430/.well-known/agent-card.json', { signal: AbortSignal.timeout(500) });
    const card = await response.json();
    if (response.ok && card.skills?.some(skill => skill.id === 'life.request')) { ready = true; break; }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 200));
}
if (!ready) throw new Error('Owned runtime did not become ready; inspect its private log');
const profile = join(directory, 'profile.json');
const client = join(root, 'integrations/grok/eigos-delegate/scripts/eigos_a2a.py');
execFileSync('python3', [client, '--config', profile, 'configure', '--card-url', 'http://127.0.0.1:3430/.well-known/agent-card.json',
  '--token-file', tokenPath, '--allow-loopback-http', '--allow-service', 'life.request', '--default-service', 'life.request'], { stdio: 'pipe' });
const peerClient = join(runtime, 'eigos_a2a.py'); cpSync(client, peerClient);
const peerToken = join(runtime, 'client-token'); writeFileSync(peerToken, token + '\n', { mode: 0o600 }); chmodSync(peerToken, 0o600);
const peerProfile = join(runtime, 'profile.json');
execFileSync('python3', [peerClient, '--config', peerProfile, 'configure', '--card-url', 'http://127.0.0.1:3430/.well-known/agent-card.json',
  '--token-file', peerToken, '--allow-loopback-http', '--allow-service', 'life.request', '--default-service', 'life.request'], { stdio: 'pipe' });
const peerDirectory = join(runtime, 'peer'); mkdirSync(peerDirectory, { recursive: true, mode: 0o700 });
const skill = readFileSync(join(root, 'integrations/grok/eigos-delegate/SKILL.md'), 'utf8');
const install = join(runtime, 'skill-install.md');
const installedSkill = `${skill}\n## Saved connection for this user\n\n- Run commands on the user's connected Mac, not the Grok cloud computer.\n- Client: ${peerClient}\n- Profile: ${peerProfile}\n- Command: python3 ${peerClient} --config ${peerProfile} <command>\n- Save input and evidence files in ${peerDirectory}; use /tmp or the user's home as working directory. No Documents-folder access is required.\n- This profile defaults to life.request; credentials remain in a private referenced file. Do not read or print that file or server.env.\n- Service is managed by launchd (${label}) while the Mac is available.\n`;
writeFileSync(install, installedSkill, { mode: 0o600 });
writeFileSync(join(directory, 'skill-install.md'), installedSkill, { mode: 0o600 });
console.log(JSON.stringify({ status: 'ready', endpoint: 'http://127.0.0.1:3430', profile: peerProfile, skillInstall: install, launchAgent: label }));
