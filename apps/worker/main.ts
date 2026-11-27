import { selectedInstallation } from '../installation.js';
import { startWorker } from './start.js';

await startWorker(await selectedInstallation());
