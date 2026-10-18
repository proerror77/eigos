// Read-only independent-agent drill host. No model, provider, Worker or real account.
import { resolve, join } from 'node:path';
import { createDrillHost } from './ontology-drill.js';
import { serviceDrillDatasets } from '../tests/fixtures/service-domain-drill.js';

const directory = resolve(process.argv[2] ?? 'data/service-domain-drill');
const host = await createDrillHost(directory, serviceDrillDatasets);
console.log(JSON.stringify({ ready: true, baseUrl: host.baseUrl, accessFile: join(directory, 'access.json') }));
const stop = async () => { await host.close(); process.exit(0); };
process.on('SIGINT', () => { void stop(); }); process.on('SIGTERM', () => { void stop(); });
