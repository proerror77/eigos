// Local synthetic investigation only: no real model, provider key or business action.
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDrillHost } from './ontology-drill.js';
import { readServiceDrillDatasets } from '../tests/fixtures/read-service-drill.js';

export async function createReadServiceDrill(directory: string) {
  const datasets = await readServiceDrillDatasets(join(directory, 'source'));
  return createDrillHost(directory, () => datasets);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = resolve(process.argv[2] ?? 'data/read-service-drill');
  const host = await createReadServiceDrill(directory);
  console.log(JSON.stringify({ ready: true, baseUrl: host.baseUrl, accessFile: join(directory, 'access.json'), scope: 'synthetic_ontology_investigation' }));
  const close = async () => { await host.close(); process.exit(0); };
  process.once('SIGINT', () => { void close(); }); process.once('SIGTERM', () => { void close(); });
}
