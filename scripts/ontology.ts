import { readFile } from 'node:fs/promises';
import { Ontology } from '../packages/ontology/model.js';
import { Database } from '../packages/runtime/database.js';
import { Metadata } from '../packages/runtime/metadata.js';

const command = process.argv[2];
const document = JSON.parse(await readFile(new URL('../packages/ontology/definitions/ride.json', import.meta.url), 'utf8'));
const model = new Ontology(document);
if (command === 'check') console.log(JSON.stringify({ id: model.document.id, version: model.document.version, digest: model.digest, objects: model.objects.size, interfaces: model.interfaces.size, links: model.links.size, actions: model.actions.size, functions: model.functions.size }));
else {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const db = new Database(process.env.DATABASE_URL, process.env.EIGOS_PG_SCHEMA);
  try {
    if (command === 'initialize') await db.initialize();
    else if (command === 'publish') console.log((await new Metadata(db).publish(document)).digest);
    else throw new Error('Use check, initialize or publish');
  } finally { await db.close(); }
}
