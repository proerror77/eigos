import { selectedInstallation } from '../installation.js';
import { startIndexer } from './start.js';

await startIndexer(await selectedInstallation());
