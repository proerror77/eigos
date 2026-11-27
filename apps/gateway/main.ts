import { selectedInstallation } from '../installation.js';
import { startGateway } from './start.js';

const adapter = process.env.EIGOS_SOLUTION_MANIFEST === undefined ? (await import('./app.js')).eigosApp : undefined;
await startGateway(await selectedInstallation(), adapter);
