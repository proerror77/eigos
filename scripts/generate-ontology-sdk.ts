import { readFileSync } from 'node:fs';
import { ontologySchema } from '../packages/ontology/schema.js';
import { generateOntologyTypes } from '../packages/sdk/generate.js';

const [file] = process.argv.slice(2);
if (!file) throw new Error('Usage: node --import tsx scripts/generate-ontology-sdk.ts <published-definition.json>');
const document = ontologySchema.parse(JSON.parse(readFileSync(file, 'utf8')));
process.stdout.write(generateOntologyTypes(document));
