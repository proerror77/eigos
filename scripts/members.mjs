import { DatabaseSync } from 'node:sqlite';
import { NetworkStore } from '../dist/packages/network/store.js';
import { MemberStore } from '../dist/packages/members/store.js';
import { openMembershipAdministration } from '../dist/packages/security/admin.js';
import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';

const { positionals, values } = parseArgs({ allowPositionals: true, options: { output: { type: 'string' }, 'expires-hours': { type: 'string', default: '24' } } });
const [action, id, ...extra] = positionals;
if (extra.length || !['list', 'approve', 'suspend', 'invite', 'revoke-invite'].includes(action) || (action === 'list' ? !!id : !id)) {
  console.error('Usage: npm run members -- list | approve <member-id> | suspend <member-id> | invite <member-id> --output data/private/invitation.json [--expires-hours 24] | revoke-invite <invitation-id>');
  process.exitCode = 1;
} else {
  const database = process.env.DATABASE_PATH ?? './data/eigos.sqlite';
  const path = process.env.MEMBERSHIP_DATABASE_PATH ?? `${database}.members`;
  let admin, business;
  try {
    if ((!existsSync(database) && !existsSync(path)) && process.env.EIGOS_SECURITY_MODE !== 'foundation') {
      const members = new MemberStore(path);
      admin = { members, mode: 'legacy', setStatus: (id, status) => members.setStatus(id, status), close: () => members.close() };
    } else admin = openMembershipAdministration(database, path, process.env.EIGOS_SECURITY_MODE);
    if (admin.mode === 'legacy' && existsSync(database)) {
      business = new DatabaseSync(database); business.exec('PRAGMA busy_timeout=5000;');
      if (business.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='network_auth_fences'").get()) {
        const network = new NetworkStore(business);
        admin.members.setRevocationObserver(change => network.fence(change.memberId, change.kind, change.target));
      }
    }
    const store = admin.members;
    if (action === 'list') console.table(store.list().map(({ id, displayName, status, createdAt }) => ({ id, displayName, status, createdAt })));
    else if (action === 'invite') {
      if (!values.output) throw new Error('Invitation credentials require a private --output file under ignored data/');
      const output = resolve(values.output), child = relative(resolve('data'), output);
      if (!child || child.startsWith('..') || child.startsWith('/')) throw new Error('Invitation output must be under ignored data/');
      const invitation = store.agents.invite(id, Number(values['expires-hours']) * 3600000);
      try { mkdirSync(dirname(output), { recursive: true, mode: 0o700 }); writeFileSync(output, JSON.stringify(invitation) + '\n', { mode: 0o600, flag: 'wx' }); }
      catch (error) { store.agents.revokeInvitation(invitation.id); throw error; }
      console.log(JSON.stringify({ invitationId: invitation.id, expiresAt: invitation.expiresAt, privateFile: output }));
    } else if (action === 'revoke-invite') { store.agents.revokeInvitation(id); console.log('Invitation revoked'); }
    else {
      const member = admin.setStatus(id, action === 'approve' ? 'active' : 'suspended');
      console.log(JSON.stringify({ id: member.id, status: member.status }));
    }
  } catch (error) { console.error(error instanceof Error ? error.message : 'Member operation failed'); process.exitCode = 1; }
  finally { admin?.close(); business?.close(); }
}
