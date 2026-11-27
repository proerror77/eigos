import { loadInstallation } from '../packages/runtime/installation.js';
import { manageInstallation } from '../scripts/manage-installation.js';
import { startGateway } from './gateway/start.js';
import { startWorker } from './worker/start.js';
import { startIndexer } from './indexer/start.js';

const path = process.env.EIGOS_SOLUTION_MANIFEST;
if (!path) throw new Error('Select an installed package with EIGOS_SOLUTION_MANIFEST');
const installation = await loadInstallation(path);
switch (process.argv[2]) {
  case 'gateway': await startGateway(installation); break;
  case 'worker': await startWorker(installation); break;
  case 'indexer': await startIndexer(installation); break;
  default: await manageInstallation(installation, process.argv.slice(2));
}
