import { MemberStore } from '../dist/packages/members/store.js';

const [action, id, ...extra] = process.argv.slice(2);
if (extra.length || !['list', 'approve', 'suspend'].includes(action) || (action === 'list' ? !!id : !id)) {
  console.error('Usage: npm run members -- list | approve <member-id> | suspend <member-id>');
  process.exitCode = 1;
} else {
  const path = process.env.MEMBERSHIP_DATABASE_PATH ?? `${process.env.DATABASE_PATH ?? './data/eigos.sqlite'}.members`;
  const store = new MemberStore(path);
  try {
    if (action === 'list') console.table(store.list().map(({ id, displayName, status, createdAt }) => ({ id, displayName, status, createdAt })));
    else {
      const member = store.setStatus(id, action === 'approve' ? 'active' : 'suspended');
      console.log(JSON.stringify({ id: member.id, status: member.status }));
    }
  } catch (error) { console.error(error instanceof Error ? error.message : 'Member operation failed'); process.exitCode = 1; }
  finally { store.close(); }
}
