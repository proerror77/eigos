import { readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync, symlinkSync, renameSync, chmodSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { primaryRelease } from '../dist/packages/deployment/primary.js';
import { taskRelayMetadataSchema, taskRelayProfileSchema } from '../dist/packages/agent-transport/task-contracts.js';
import { PA_SKILL_DIRECTORY, PA_SKILL_FILES } from '../dist/packages/members/pa-onboarding.js';

const {release} = primaryRelease();
const endpoint = release.endpoint;
if (typeof endpoint !== 'string' || new URL(endpoint).protocol !== 'https:' || new URL(endpoint).origin !== endpoint) throw new Error('Primary deployment has no exact HTTPS endpoint');
const health = await fetch(endpoint + '/health', { redirect: 'error', signal: AbortSignal.timeout(15000) }).then(r => { if (!r.ok) throw new Error('Primary runtime unavailable'); return r.json(); });
if (health.instance !== endpoint || health.releaseDigest !== release.buildDigest || health.ontologyTransport !== 'native-mcp') throw new Error('Primary runtime does not match its native MCP release');
const directory = join(homedir(), '.local/share/eigos/primary-pa'); mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
const profilePath = join(directory, 'profile.json');
const existing = existsSync(profilePath) ? JSON.parse(readFileSync(profilePath, 'utf8')) : undefined;
if (existing && existing.baseUrl !== endpoint) throw new Error('Existing PA profile belongs to another origin');
const relay = existing?.relay ? taskRelayProfileSchema.parse(existing.relay) : undefined;
if (relay) {
  const response = await fetch(endpoint + '/.well-known/eigos-task-relay', { redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('The configured PA Relay is unavailable; preserve the existing profile');
  const metadata = taskRelayMetadataSchema.parse(await response.json());
  if (metadata.authorityId !== health.authorityId || metadata.authorityId !== relay.authorityId || metadata.gatewayOrigin !== endpoint
    || metadata.gatewayAgentId !== relay.gatewayAgentId || metadata.relayUrl !== relay.baseUrl) throw new Error('The configured PA Relay identity changed; review it before updating the profile');
}
const profile = { baseUrl: endpoint, credentialPath: join(directory, 'oauth-credentials.json'), displayName: 'Grok Bot A2A on primary EIGOS', ...(relay ? { relay } : {}) };
const write = (path, text) => { const temporary = path + '.' + randomUUID() + '.tmp'; writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' }); renameSync(temporary, path); };
const target = join(release.release, 'integrations/grok/eigos-native/client.mjs'), link = join(directory, 'eigos.mjs');
if (!existsSync(target) || (existsSync(link) && !lstatSync(link).isSymbolicLink())) throw new Error('PA client release or managed link is invalid');
const temporary = link + '.' + randomUUID() + '.tmp'; symlinkSync(target, temporary); renameSync(temporary, link);
write(profilePath, JSON.stringify(profile, null, 2) + '\n');
mkdirSync(join(directory, 'receipts'), { recursive: true, mode: 0o700 });
const skillDirectory = join(directory, 'eigos-delegate');
for (const name of PA_SKILL_FILES) {
  const destination = join(skillDirectory, name); mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(join(release.release, 'dist', PA_SKILL_DIRECTORY, name), destination);
}
const skill = readFileSync(join(skillDirectory, 'SKILL.md'), 'utf8')
  + `\n## Saved primary connection\n\n- Native MCP connection: EIGOS, ${endpoint}/mcp.\n- A2A runs on the user's connected Mac.\n- Client command: node ${link} --profile ${profilePath} <command>.\n- Save non-secret task requests and receipts in ${join(directory, 'receipts')}.\n- The profile contains credential references only. Do not read or print oauth-credentials.json.\n- Both protocols must report this origin: ${endpoint}.\n`;
write(join(skillDirectory, 'SKILL.md'), skill);
// Retain the existing single-file handoff with working local reference links.
write(join(directory, 'skill-install.md'), skill.replaceAll('](references/', `](${skillDirectory}/references/`));
write(join(directory, 'deployment.json'), JSON.stringify({ instance: endpoint, backend: health.backend, releaseDigest: release.buildDigest, sourceCommit: release.sourceCommit }, null, 2) + '\n');
console.log(JSON.stringify({ status: 'installed', instance: endpoint, profile: profilePath, client: link, skill: join(directory, 'skill-install.md'), skillDirectory, authentication: 'separate_user_oauth_required' }));
