// Isolated, read-only evaluation of the approved 18 architecture questions.
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { createDrillHost } from './ontology-drill.js';
import { architectureDrillDatasets } from '../tests/fixtures/architecture-drill.js';
import { architectureVariationDatasets } from '../tests/fixtures/architecture-variations.js';
const directory=resolve(process.argv[2] ?? `data/ontology-architecture-${Date.now()}`);
if (existsSync(join(directory, 'manifest.json'))) throw new Error('A recorded architecture run cannot be overwritten; choose a new directory');
const selected=process.argv[3]?.split(',');
const prepared=[...(!selected || selected.some(id => !id.startsWith('U')) ? await architectureDrillDatasets(directory) : []),
  ...(!selected || selected.some(id => id.startsWith('U')) ? architectureVariationDatasets(directory) : [])];
const datasets=selected?prepared.filter(d=>selected.includes(d.id)):prepared;
for (const data of prepared) if (!datasets.includes(data)) data.close?.();
const host=await createDrillHost(directory,()=>datasets);
console.log(JSON.stringify({ready:true,baseUrl:host.baseUrl,accessFile:join(directory,'access.json'),cases:datasets.length}));
const stop=async()=>{await host.close();process.exit(0);};
process.on('SIGINT',()=>{void stop();});process.on('SIGTERM',()=>{void stop();});
