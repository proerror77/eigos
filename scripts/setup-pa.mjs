import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, cpSync, symlinkSync, readdirSync, renameSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readWorkerConfig } from '../dist/packages/core/config.js';
import { DidiMcpConnector } from '../dist/packages/capabilities/didi/connector.js';

// Owned local deployment, with immutable build snapshots and private recovery backups.
if (process.platform !== 'darwin') throw new Error('This setup uses macOS launchd');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = join(root, 'data/grok-life');
const runtime = join(homedir(), '.local/share/eigos/grok-life');
const envPath = join(directory, 'server.env'), runtimeEnv = join(runtime, 'server.env');
const label = 'com.eigos.grok-life', service = `gui/${process.getuid()}/${label}`;
const plistPath = join(homedir(), 'Library/LaunchAgents', `${label}.plist`);
const marker = '# EIGOS managed Grok ontology runtime';
const oldMarker = '# EIGOS managed Grok life intake';
const privateWrite = (path, data) => { writeFileSync(path, data, { mode: 0o600 }); chmodSync(path, 0o600); };
const read = path => existsSync(path) ? readFileSync(path, 'utf8') : '';
const field = (text, key) => text.split('\n').find(l => l.startsWith(key + '='))?.slice(key.length + 1).replace(/^["']|["']$/g, '');
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
for (const path of [directory, runtime, dirname(plistPath)]) { mkdirSync(path, { recursive: true, mode: 0o700 }); }
chmodSync(directory, 0o700); chmodSync(runtime, 0o700);
const ownership = join(runtime, 'owner.json');
if (existsSync(ownership) && JSON.parse(read(ownership)).sourceRoot !== root) throw new Error('Runtime belongs to another checkout');
const previousPlist = read(plistPath);
if (previousPlist && !previousPlist.includes(xml(envPath)) && !previousPlist.includes(xml(runtimeEnv))) throw new Error('LaunchAgent belongs to another runtime');
const oldSettings = read(runtimeEnv) || read(envPath);
if (oldSettings && !oldSettings.startsWith(marker) && !oldSettings.startsWith(oldMarker)) throw new Error('Existing settings are not owned by this setup');
const token = field(oldSettings, 'EIGOS_DEV_TOKEN') ?? randomBytes(32).toString('hex');
if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Existing runtime credential is invalid');
for (const path of [join(directory, 'token'), join(runtime, 'client-token')]) if (read(path).trim() && read(path).trim() !== token) throw new Error('Existing client credential mismatch');
const skill = process.env.EIGOS_PAOTUI_SKILL_DIR ?? field(read(join(root, '.env')), 'EIGOS_PAOTUI_SKILL_DIR') ?? join(homedir(), '.codex/skills/meituan-paotui');
if (!isAbsolute(skill) || /[\r\n]/.test(skill) || !existsSync(join(skill, 'paotui.js'))) throw new Error('Configure the existing absolute official Paotui skill directory');
// Preserve an owned whitelist across updates; only an explicit setting replaces it.
// Use the runtime validator before stopping the existing service or writing settings.
const publicGeoQueries = readWorkerConfig({
  NODE_ENV: 'development', HOST: '127.0.0.1', PUBLIC_URL: 'http://127.0.0.1:3430',
  EIGOS_AUTH_MODE: 'development', EIGOS_PAOTUI_SKILL_DIR: skill,
  EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES: process.env.EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES
    ?? field(oldSettings, 'EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES'),
}).EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES ?? [];
const publicGeoSetting = "'" + JSON.stringify(publicGeoQueries).replaceAll("'", '\\u0027') + "'";
const shopifyMerchants = readWorkerConfig({
  NODE_ENV: 'development', HOST: '127.0.0.1', PUBLIC_URL: 'http://127.0.0.1:3430', EIGOS_AUTH_MODE: 'development',
  EIGOS_SHOPIFY_CATALOG_MERCHANTS: process.env.EIGOS_SHOPIFY_CATALOG_MERCHANTS ?? field(oldSettings, 'EIGOS_SHOPIFY_CATALOG_MERCHANTS'),
}).EIGOS_SHOPIFY_CATALOG_MERCHANTS ?? [];
const shopifySetting = "'" + JSON.stringify(shopifyMerchants).replaceAll("'", '\\u0027') + "'";
const didiDisabled = process.env.EIGOS_DIDI_KEY_FILE === '';
const didi = readWorkerConfig({
  NODE_ENV: 'development', HOST: '127.0.0.1', PUBLIC_URL: 'http://127.0.0.1:3430', EIGOS_AUTH_MODE: 'development',
  EIGOS_DIDI_KEY_FILE: didiDisabled ? undefined : process.env.EIGOS_DIDI_KEY_FILE ?? field(oldSettings, 'EIGOS_DIDI_KEY_FILE'),
  EIGOS_DIDI_BINDING_ID: didiDisabled ? undefined : process.env.EIGOS_DIDI_BINDING_ID ?? field(oldSettings, 'EIGOS_DIDI_BINDING_ID'),
  EIGOS_DIDI_KEY_SHA256: didiDisabled ? undefined : process.env.EIGOS_DIDI_KEY_SHA256 ?? field(oldSettings, 'EIGOS_DIDI_KEY_SHA256'),
  EIGOS_DIDI_ENVIRONMENT: process.env.EIGOS_DIDI_ENVIRONMENT ?? field(oldSettings, 'EIGOS_DIDI_ENVIRONMENT'),
  EIGOS_DIDI_ORDERS_ENABLED: process.env.EIGOS_DIDI_ORDERS_ENABLED ?? field(oldSettings, 'EIGOS_DIDI_ORDERS_ENABLED'),
});
if (didi.EIGOS_DIDI_KEY_FILE && /[\r\n'"#]/.test(didi.EIGOS_DIDI_KEY_FILE)) throw new Error('DiDi credential path cannot be represented in managed settings');
if (didi.EIGOS_DIDI_KEY_FILE) await new DidiMcpConnector({ keyFile: didi.EIGOS_DIDI_KEY_FILE, keySha256: didi.EIGOS_DIDI_KEY_SHA256, bindingId: didi.EIGOS_DIDI_BINDING_ID, environment: didi.EIGOS_DIDI_ENVIRONMENT }).verifyCredential();
const commerceDisabled = process.env.EIGOS_COMMERCE_SANDBOX_URL === '';
const commerceUrl = commerceDisabled ? undefined : process.env.EIGOS_COMMERCE_SANDBOX_URL ?? field(oldSettings, 'EIGOS_COMMERCE_SANDBOX_URL');
const commerceTokenFile = commerceDisabled ? undefined : process.env.EIGOS_COMMERCE_SANDBOX_TOKEN_FILE ?? field(oldSettings, 'EIGOS_COMMERCE_SANDBOX_TOKEN_FILE');
const commerce = readWorkerConfig({ NODE_ENV: 'development', HOST: '127.0.0.1', PUBLIC_URL: 'http://127.0.0.1:3430', EIGOS_AUTH_MODE: 'development', EIGOS_ACTION_SANDBOX: commerceUrl ? 'true' : 'false', EIGOS_COMMERCE_SANDBOX_URL: commerceUrl, EIGOS_COMMERCE_SANDBOX_TOKEN_FILE: commerceTokenFile });
const codex = process.env.EIGOS_CODEX_BIN ?? execFileSync('/usr/bin/which', ['codex'], { encoding: 'utf8' }).trim();
const passport = execFileSync('/usr/bin/which', ['pt-passport'], { encoding: 'utf8' }).trim();
if (!isAbsolute(codex) || !existsSync(codex)) throw new Error('Codex executable unavailable');
const runtimePath = [...new Set([dirname(process.execPath), dirname(codex), dirname(passport), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'])].join(':');
const scan = path => readdirSync(path, { withFileTypes: true }).flatMap(e => e.isDirectory() ? scan(join(path, e.name)) : e.name.endsWith('.ts') ? [join(path, e.name)] : []);
const sourceFiles = [...scan(join(root, 'apps')), ...scan(join(root, 'packages'))].sort();
const ontologyFiles = readdirSync(join(root, 'ontology')).filter(name => name.endsWith('.json')).sort().map(name => {
  const path = 'dist/ontology/' + name;
  if (!existsSync(join(root, path)) || !readFileSync(join(root, path)).equals(readFileSync(join(root, 'ontology', name)))) throw new Error('Run npm run ontology:sync before updating the runtime');
  return path;
});
const files = [...sourceFiles.map(path => 'dist/' + path.slice(root.length + 1).replace(/\.ts$/, '.js')), ...ontologyFiles, 'scripts/run-local.mjs', 'package.json', 'package-lock.json'];
const fingerprint = createHash('sha256');
for (const path of files) { fingerprint.update(path + '\0'); fingerprint.update(readFileSync(join(root, path))); }
const buildDigest = fingerprint.digest('hex');
const release = join(runtime, 'releases', buildDigest);
if (!existsSync(release)) {
  mkdirSync(release, { recursive: true, mode: 0o700 });
  for (const path of files) { mkdirSync(dirname(join(release, path)), { recursive: true }); cpSync(join(root, path), join(release, path)); }
}
for (const path of files) if (!existsSync(join(release,path)) || !readFileSync(join(release,path)).equals(readFileSync(join(root,path)))) throw new Error('Immutable release does not match the current build');
const dependencyHash = createHash('sha256').update(readFileSync(join(root, 'package-lock.json'))).digest('hex');
const dependencyRoot = join(runtime, 'dependencies', dependencyHash);
if (!existsSync(dependencyRoot)) { mkdirSync(dirname(dependencyRoot), { recursive: true }); cpSync(join(root, 'node_modules'), dependencyRoot, { recursive: true }); }
if (!existsSync(join(release, 'node_modules'))) symlinkSync(dependencyRoot, join(release, 'node_modules'));
const settings = [marker, 'NODE_ENV=development', 'HOST=127.0.0.1', 'PORT=3430', 'PUBLIC_URL=http://127.0.0.1:3430',
  `DATABASE_PATH=${join(runtime, 'tasks.sqlite')}`, 'EIGOS_AUTH_MODE=development', `EIGOS_DEV_TOKEN=${token}`,
  'EIGOS_COORDINATOR=codex', 'EIGOS_EXECUTOR=codex', `EIGOS_CODEX_BIN=${codex}`, 'EIGOS_EXECUTOR_TIMEOUT_MS=120000', 'EIGOS_CSV_PILOT=false',
  'EIGOS_PAOTUI_ORDERS_ENABLED=false', `EIGOS_PAOTUI_SKILL_DIR=${skill}`, `EIGOS_AUDIT_PATH=${join(runtime, 'http.jsonl')}`,
  `EIGOS_PUBLIC_GEO_DISCOVERY_QUERIES=${publicGeoSetting}`,
  `EIGOS_SHOPIFY_CATALOG_MERCHANTS=${shopifySetting}`,
  ...(shopifyMerchants.length ? [`EIGOS_SHOPIFY_AUDIT_DIR=${join(runtime, 'shopify-reads')}`] : []),
  ...(didi.EIGOS_DIDI_KEY_FILE ? [`EIGOS_DIDI_KEY_FILE=${didi.EIGOS_DIDI_KEY_FILE}`, `EIGOS_DIDI_KEY_SHA256=${didi.EIGOS_DIDI_KEY_SHA256}`, `EIGOS_DIDI_BINDING_ID=${didi.EIGOS_DIDI_BINDING_ID}`, `EIGOS_DIDI_ENVIRONMENT=${didi.EIGOS_DIDI_ENVIRONMENT}`, 'EIGOS_DIDI_ORDERS_ENABLED=false', `EIGOS_DIDI_AUDIT_DIR=${join(runtime, 'didi-reads')}`] : []),
  ...(commerce.EIGOS_COMMERCE_SANDBOX_URL ? ['EIGOS_ACTION_SANDBOX=true', `EIGOS_COMMERCE_SANDBOX_URL=${commerce.EIGOS_COMMERCE_SANDBOX_URL}`, `EIGOS_COMMERCE_SANDBOX_TOKEN_FILE=${commerce.EIGOS_COMMERCE_SANDBOX_TOKEN_FILE}`, `EIGOS_COMMERCE_SANDBOX_AUDIT_DIR=${join(runtime, 'commerce-sandbox-reads')}`] : []),
  `EIGOS_ONTOLOGY_AUDIT_PATH=${join(runtime, 'ontology-reads.jsonl')}`, `EIGOS_RELEASE_DIGEST=${buildDigest}`, ''].join('\n');
const strings = values => values.map(v => `<string>${xml(v)}</string>`).join('');
const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${strings([process.execPath, `--env-file=${runtimeEnv}`, join(release, 'scripts/run-local.mjs'), '--built'])}</array>
<key>WorkingDirectory</key><string>${xml(release)}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(runtimePath)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer><key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(join(runtime, 'runtime.log'))}</string><key>StandardErrorPath</key><string>${xml(join(runtime, 'runtime.log'))}</string></dict></plist>\n`;
const loaded = () => { try { execFileSync('launchctl', ['print', service], { stdio: 'ignore' }); return true; } catch { return false; } };
const stop = async () => {
  if (loaded()) execFileSync('launchctl', ['bootout', service], { stdio: 'ignore' });
  for (let i=0;i<100;i++) { let listening = false; try { listening = (await fetch('http://127.0.0.1:3430/health', { signal: AbortSignal.timeout(300) })).ok; } catch {} if (!loaded() && !listening) return; await new Promise(r=>setTimeout(r,150)); }
  throw new Error('Owned runtime has not fully stopped');
};
const ready = async () => {
  for (let i=0;i<100;i++) {
    try {
      const health = await fetch('http://127.0.0.1:3430/health', { signal: AbortSignal.timeout(500) }).then(r=>r.json());
      const card = await fetch('http://127.0.0.1:3430/.well-known/agent-card.json', { signal: AbortSignal.timeout(500) }).then(r=>r.json());
      if (health.releaseDigest === buildDigest && card.skills.length === 1 && card.skills[0].id === 'eigos.delegate') return;
    } catch {} await new Promise(r=>setTimeout(r,200));
  } throw new Error('New ontology runtime did not become ready; inspect the private log');
};
const needsRestart = !loaded() || previousPlist !== plist || oldSettings !== settings || process.argv.includes('--restart');
const backup = join(runtime, 'backups', new Date().toISOString().replaceAll(':', '-')); mkdirSync(backup, { recursive: true, mode: 0o700 });
const managed = [envPath, runtimeEnv, plistPath, join(directory,'profile.json'), join(runtime,'profile.json'), join(runtime,'skill-install.md')];
for (const [i,path] of managed.entries()) if (existsSync(path)) cpSync(path, join(backup, String(i)));
try {
  if (needsRestart) {
    await stop();
    if (existsSync(join(runtime,'tasks.sqlite'))) execFileSync('python3', ['-c', 'import sqlite3,sys; a=sqlite3.connect(sys.argv[1]); b=sqlite3.connect(sys.argv[2]); a.backup(b); b.close(); a.close()', join(runtime,'tasks.sqlite'), join(backup,'tasks.sqlite')], { stdio: 'pipe' });
    privateWrite(envPath, settings); privateWrite(runtimeEnv, settings); privateWrite(plistPath, plist);
    execFileSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, plistPath], { stdio: 'pipe' });
  }
  await ready();
  const client = join(root, 'integrations/grok/eigos-delegate/scripts/eigos_a2a.py');
  const peerClient = join(runtime, 'eigos_a2a.py'); cpSync(client, peerClient);
  for (const [profile, credential, executable] of [[join(directory,'profile.json'),join(directory,'token'),client], [join(runtime,'profile.json'),join(runtime,'client-token'),peerClient]]) {
    privateWrite(credential, token + '\n');
    execFileSync('python3', [executable, '--config', profile, 'configure', '--card-url','http://127.0.0.1:3430/.well-known/agent-card.json','--token-file',credential,'--allow-loopback-http','--allow-service','eigos.delegate','--default-service','eigos.delegate'], { stdio:'pipe' });
  }
  const peerDirectory = join(runtime, 'peer'); mkdirSync(peerDirectory, { recursive: true, mode: 0o700 });
  const installedSkill = readFileSync(join(root,'integrations/grok/eigos-delegate/SKILL.md'),'utf8') + `\n## Saved connection for this user\n\n- Run on the user's connected Mac, not the cloud computer.\n- Client: ${peerClient}\n- Profile: ${join(runtime,'profile.json')}\n- Command: python3 ${peerClient} --config ${join(runtime,'profile.json')} <command>\n- Save task inputs and receipts in ${peerDirectory}.\n- Default and allowed service: eigos.delegate. Credential values are private; never read or print client-token or server.env.\n- Parcel quotation is read-only: let EIGOS read saved addresses, present choices and continue the same task. Do not find or inject address IDs yourself.\n- launchd ${label} keeps Gateway/Worker available while the Mac is available.\n`;
  privateWrite(join(runtime,'skill-install.md'), installedSkill); privateWrite(join(directory,'skill-install.md'), installedSkill);
  privateWrite(ownership, JSON.stringify({sourceRoot:root})+'\n');
  const sourceCommit = execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  const dirty = !!execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim();
  privateWrite(join(runtime,'release.json'),JSON.stringify({buildDigest,release,sourceCommit,sourceTreeDirty:dirty,files,updatedAt:new Date().toISOString()})+'\n');
  privateWrite(join(directory,'runtime-location.json'),JSON.stringify({runtime,release,buildDigest,database:join(runtime,'tasks.sqlite'),audit:join(runtime,'http.jsonl')})+'\n');
  // Retired executable snapshots are recovery material, never a second active mode.
  for (const name of ['dist','scripts']) if (existsSync(join(runtime,name))) renameSync(join(runtime,name), join(backup,'retired-'+name));
  console.log(JSON.stringify({status:'ready',endpoint:'http://127.0.0.1:3430',defaultService:'eigos.delegate',buildDigest,release,backup,sourceCommit,sourceTreeDirty:dirty,publicGeoDiscoveryQueries:publicGeoQueries,shopifyCatalogMerchants:shopifyMerchants,skillInstall:join(runtime,'skill-install.md')}));
} catch (error) {
  if (needsRestart) {
    await stop().catch(()=>{});
    for (const [i,path] of managed.entries()) if (existsSync(join(backup,String(i)))) cpSync(join(backup,String(i)),path);
    if (previousPlist) try { execFileSync('launchctl',['bootstrap',`gui/${process.getuid()}`,plistPath],{stdio:'ignore'}); } catch {}
  }
  throw error;
}
