import { selectedInstallation } from '../apps/installation.js';
import { manageInstallation } from './manage-installation.js';

const args = process.argv.slice(2);
if (process.env.EIGOS_SOLUTION_MANIFEST === undefined &&
    ['invite', 'account', 'enable-pgvector', 'provision-public-places', 'replay-check', 'archive-logs', 'audit', 'permissions'].includes(args[0] ?? '')) {
  await import('./eigos-administration.js');
} else {
  await manageInstallation(await selectedInstallation(), args);
}
