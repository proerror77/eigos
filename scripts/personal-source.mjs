// Local operator provisioning. This command does not fetch, copy or print provider tokens.
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MemberStore } from '../dist/packages/members/store.js';
import { personalSourceSchema, readPersonalSource } from '../dist/packages/core/personal-source.js';

const { positionals, values } = parseArgs({ allowPositionals: true, options: { member: { type: 'string' }, file: { type: 'string' }, 'expires-hours': { type: 'string', default: '24' } } });
let temporary;
try {
  const [action, ...extra] = positionals;
  if (extra.length || !['bind', 'revoke', 'inspect'].includes(action) || !values.file) throw new Error('Usage: npm run source:personal -- bind --member <member-id> --file data/private/source.json [--expires-hours 24] | revoke --file <path> | inspect --file <path>');
  const path = resolve(values.file);
  let connection;
  if (action === 'bind') {
    const child = relative(resolve('data'), path), hours = Number(values['expires-hours']);
    if (!child || child.startsWith('..') || child.startsWith('/') || !values.member || !Number.isFinite(hours) || hours <= 0 || hours > 168 || process.getuid === undefined) throw new Error('Bind requires a member, a private data/ file and an expiry of at most 168 hours');
    const db = process.env.MEMBERSHIP_DATABASE_PATH ?? `${process.env.DATABASE_PATH ?? './data/eigos.sqlite'}.members`;
    if (!existsSync(db)) throw new Error('Existing membership database required');
    const members = new MemberStore(db);
    try {
      const member = members.get(values.member);
      const enrolled = JSON.parse(process.env.EIGOS_NETWORK_MEMBER_IDS ?? '[]');
      if (member.status !== 'active' || !Array.isArray(enrolled) || !enrolled.includes(member.id) || member.issuer !== process.env.OAUTH_ISSUER) throw new Error('Select an active enrolled member from the configured issuer');
      connection = personalSourceSchema.parse({ version: 1, connectionId: randomUUID(), revision: 1, memberId: member.id,
        owner: { issuer: member.issuer, tenant: member.tenant, subject: member.subject }, credential: 'local_pt_passport', localUid: process.getuid(), purpose: 'delivery_quote_readonly', state: 'active', expiresAt: new Date(Date.now() + hours * 3600000).toISOString() });
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, JSON.stringify(connection) + '\n', { mode: 0o600, flag: 'wx' });
    } finally { members.close(); }
  } else {
    connection = readPersonalSource(path);
    if (action === 'revoke') {
      const changed = { ...connection, state: 'revoked', revision: connection.revision + 1 };
      temporary = path + '.' + randomUUID() + '.tmp';
      writeFileSync(temporary, JSON.stringify(changed) + '\n', { mode: 0o600, flag: 'wx' });
      // Refuse an already changed record; the final rename is atomic for readers.
      if (JSON.stringify(readPersonalSource(path)) !== JSON.stringify(connection)) throw new Error('Connection changed; inspect it before retrying');
      renameSync(temporary, path); temporary = undefined; connection = changed;
    }
  }
  console.log(JSON.stringify({ connectionId: connection.connectionId, memberId: connection.memberId, state: connection.state, expiresAt: connection.expiresAt }));
} catch { console.error('Personal source operation rejected. Check the command, enrolled member, private file and current connection state.'); process.exitCode = 1; }
finally { if (temporary && existsSync(temporary)) unlinkSync(temporary); }
