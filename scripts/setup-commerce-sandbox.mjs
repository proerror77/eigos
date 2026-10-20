import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, cpSync, symlinkSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

if (process.platform !== 'darwin') throw new Error('This local sandbox setup uses macOS launchd');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), runtime = join(homedir(), '.local/share/eigos/commerce-sandbox');
const label = 'com.eigos.commerce-sandbox', service = `gui/${process.getuid()}/${label}`, plistPath = join(homedir(), 'Library/LaunchAgents', `${label}.plist`), envPath = join(runtime, 'server.env');
const read = path => existsSync(path) ? readFileSync(path, 'utf8') : '';
const privateWrite = (path, data) => { writeFileSync(path, data, { mode: 0o600 }); chmodSync(path, 0o600); };
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
mkdirSync(runtime, { recursive: true, mode: 0o700 }); mkdirSync(dirname(plistPath), { recursive: true });
if (read(join(runtime, 'owner.json')) && JSON.parse(read(join(runtime, 'owner.json'))).sourceRoot !== root) throw new Error('Sandbox runtime belongs to another checkout');
const oldPlist = read(plistPath), oldEnv = read(envPath);
if (oldPlist && !oldPlist.includes(xml(envPath))) throw new Error('Sandbox LaunchAgent is not owned by this setup');
const tokenFile = join(runtime, 'connector-token'), token = read(tokenFile).trim() || randomBytes(32).toString('hex');
if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Existing sandbox credential is invalid');
const scan = path => readdirSync(path, { withFileTypes: true }).flatMap(e => e.isDirectory() ? scan(join(path, e.name)) : e.name.endsWith('.ts') ? [join(path, e.name)] : []);
const sourceFiles = [...scan(join(root, 'packages')), ...scan(join(root, 'apps/commerce-sandbox'))].sort();
const files = [...sourceFiles.map(p => 'dist/' + p.slice(root.length + 1).replace(/\.ts$/, '.js')), 'package.json', 'package-lock.json'];
const hash = createHash('sha256'); for (const file of files) { hash.update(file + '\0'); hash.update(readFileSync(join(root, file))); }
const buildDigest = hash.digest('hex'), release = join(runtime, 'releases', buildDigest);
if (!existsSync(release)) { for (const file of files) { mkdirSync(dirname(join(release, file)), { recursive: true }); cpSync(join(root, file), join(release, file)); } }
for (const file of files) if (!readFileSync(join(release, file)).equals(readFileSync(join(root, file)))) throw new Error('Sandbox immutable build differs from current compiled sources');
const dependencyHash = createHash('sha256').update(readFileSync(join(root, 'package-lock.json'))).digest('hex');
let dependencyRoot = join(homedir(), '.local/share/eigos/grok-life/dependencies', dependencyHash);
if (!existsSync(dependencyRoot)) { dependencyRoot = join(runtime, 'dependencies', dependencyHash); if (!existsSync(dependencyRoot)) { mkdirSync(dirname(dependencyRoot), { recursive: true }); cpSync(join(root, 'node_modules'), dependencyRoot, { recursive: true }); } }
if (!existsSync(join(release, 'node_modules'))) symlinkSync(dependencyRoot, join(release, 'node_modules'));
const database = join(runtime, 'sandbox.sqlite'), settings = ['# EIGOS managed isolated commerce sandbox', 'NODE_ENV=development', `EIGOS_COMMERCE_SANDBOX_TOKEN_FILE=${tokenFile}`, `EIGOS_COMMERCE_SANDBOX_DATABASE=${database}`, 'EIGOS_COMMERCE_SANDBOX_PORT=3432', ''].join('\n');
const args = [process.execPath, `--env-file=${envPath}`, join(release, 'dist/apps/commerce-sandbox/main.js')];
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map(v=>`<string>${xml(v)}</string>`).join('')}</array><key>WorkingDirectory</key><string>${xml(release)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer><key>Umask</key><integer>63</integer><key>StandardOutPath</key><string>${xml(join(runtime,'runtime.log'))}</string><key>StandardErrorPath</key><string>${xml(join(runtime,'runtime.log'))}</string></dict></plist>\n`;
const loaded = () => { try { execFileSync('launchctl', ['print', service], { stdio: 'ignore' }); return true; } catch { return false; } };
const stop = async () => { if (loaded()) execFileSync('launchctl', ['bootout', service], { stdio: 'ignore' }); for(let i=0;i<60;i++){let listening=false;try{listening=(await fetch('http://127.0.0.1:3432/health',{signal:AbortSignal.timeout(300)})).ok;}catch{}if(!loaded()&&!listening)return;await new Promise(r=>setTimeout(r,150));}throw new Error('Sandbox did not stop'); };
const changed = !loaded() || oldPlist !== plist || oldEnv !== settings;
const backup = join(runtime, 'backups', new Date().toISOString().replaceAll(':', '-')); mkdirSync(backup, { recursive: true, mode: 0o700 });
for(const [i,path]of[envPath,plistPath].entries())if(existsSync(path))cpSync(path,join(backup,String(i)));
try {
  if(changed){await stop();if(existsSync(database))execFileSync('python3',['-c','import sqlite3,sys; a=sqlite3.connect(sys.argv[1]); b=sqlite3.connect(sys.argv[2]); a.backup(b); b.close(); a.close()',database,join(backup,'sandbox.sqlite')]);privateWrite(tokenFile,token+'\n');privateWrite(envPath,settings);privateWrite(plistPath,plist);execFileSync('launchctl',['bootstrap',`gui/${process.getuid()}`,plistPath],{stdio:'pipe'});}
  let health;for(let i=0;i<60;i++){try{const value=await fetch('http://127.0.0.1:3432/health',{signal:AbortSignal.timeout(500)}).then(r=>r.json());if(value.environment==='sandbox'&&value.protocol==='eigos.commerce.sandbox.v1'&&value.realOperationsAllowed===false){health=value;break;}}catch{}await new Promise(r=>setTimeout(r,200));}
  if(!health)throw new Error('Sandbox did not become ready');
  privateWrite(join(runtime,'owner.json'),JSON.stringify({sourceRoot:root})+'\n');
  const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  privateWrite(join(runtime,'release.json'),JSON.stringify({buildDigest,release,files,sourceCommit,sourceTreeDirty:!!execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim(),instanceId:health.instanceId,updatedAt:new Date().toISOString()})+'\n');
  console.log(JSON.stringify({status:'ready',endpoint:'http://127.0.0.1:3432',tokenFile,buildDigest,release,database,backup,instanceId:health.instanceId,environment:'sandbox',realOperationsAllowed:false}));
} catch(error) {if(changed){await stop().catch(()=>{});for(const [i,path]of[envPath,plistPath].entries())if(existsSync(join(backup,String(i))))cpSync(join(backup,String(i)),path);if(oldPlist)try{execFileSync('launchctl',['bootstrap',`gui/${process.getuid()}`,plistPath],{stdio:'ignore'});}catch{}}throw error;}
