import { readFileSync } from 'node:fs';
import { ontologySchema } from '../packages/ontology/schema.js';
import { Ontology } from '../packages/ontology/model.js';
import { generateOntologyTypes } from '../packages/sdk/generate.js';

const [file] = process.argv.slice(2);
if (!file) throw new Error('Usage: node --import tsx scripts/generate-ontology-sdk.ts <published-definition.json>');
const input = JSON.parse(readFileSync(file, 'utf8'));
const packaged = input.format === 'eigos-ontology-package-v1';
const document = ontologySchema.parse(packaged ? input.document : input);
if (packaged && (input.digest !== new Ontology(document).digest || input.ontology !== document.id || input.version !== document.version))
  throw new Error('Ontology package identity mismatch');
process.stdout.write(generateOntologyTypes(document));
