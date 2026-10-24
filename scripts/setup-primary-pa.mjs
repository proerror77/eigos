import { readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync, symlinkSync, renameSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(homedir(), '.local/share/eigos/invite-beta');
const release = JSON.parse(readFileSync(join(runtime, 'release.json'), 'utf8'));
const endpoint = release.endpoint;
if (typeof endpoint !== 'string' || new URL(endpoint).protocol !== 'https:' || new URL(endpoint).origin !== endpoint) throw new Error('Primary deployment has no exact HTTPS endpoint');
const health = await fetch(endpoint + '/health', { redirect: 'error', signal: AbortSignal.timeout(15000) }).then(r => { if (!r.ok) throw new Error('Primary runtime unavailable'); return r.json(); });
if (health.instance !== endpoint || health.releaseDigest !== release.buildDigest || health.ontologyTransport !== 'native-mcp') throw new Error('Primary runtime does not match its native MCP release');
const directory = join(homedir(), '.local/share/eigos/primary-pa'); mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
const profilePath = join(directory, 'profile.json');
if (existsSync(profilePath) && JSON.parse(readFileSync(profilePath, 'utf8')).baseUrl !== endpoint) throw new Error('Existing PA profile belongs to another origin');
const profile = { baseUrl: endpoint, credentialPath: join(directory, 'oauth-credentials.json'), displayName: 'Grok Bot A2A on primary EIGOS' };
const write = (path, text) => { const temporary = path + '.' + randomUUID() + '.tmp'; writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' }); renameSync(temporary, path); };
const target = join(release.release, 'integrations/grok/eigos-native/client.mjs'), link = join(directory, 'eigos.mjs');
if (!existsSync(target) || (existsSync(link) && !lstatSync(link).isSymbolicLink())) throw new Error('PA client release or managed link is invalid');
const temporary = link + '.' + randomUUID() + '.tmp'; symlinkSync(target, temporary); renameSync(temporary, link);
write(profilePath, JSON.stringify(profile, null, 2) + '\n');
mkdirSync(join(directory, 'receipts'), { recursive: true, mode: 0o700 });
const skill = readFileSync(join(root, 'integrations/grok/eigos-delegate/SKILL.md'), 'utf8')
  + `\n## Saved primary connection\n\n- Native MCP connection: EIGOS, ${endpoint}/mcp.\n- A2A runs on the user's connected Mac.\n- Client command: node ${link} --profile ${profilePath} <command>.\n- Save non-secret task requests and receipts in ${join(directory, 'receipts')}.\n- The profile contains credential references only. Do not read or print oauth-credentials.json.\n- Both protocols must report this origin: ${endpoint}.\n`;
write(join(directory, 'skill-install.md'), skill);
write(join(directory, 'deployment.json'), JSON.stringify({ instance: endpoint, backend: health.backend, releaseDigest: release.buildDigest, sourceCommit: release.sourceCommit }, null, 2) + '\n');
console.log(JSON.stringify({ status: 'installed', instance: endpoint, profile: profilePath, client: link, skill: join(directory, 'skill-install.md'), authentication: 'separate_user_oauth_required' }));
