import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { OntologyDocument } from '../../../packages/ontology/schema.js';

export const v50Digest = '6ceae09f9f119815a5c0abb7ad4320547bc365c8730a24123928b43a9aebd8f6';

/** The immutable EIGOS v50 definition before installing the Scenario Interface and review Actions. */
export function readV50(): OntologyDocument {
  return JSON.parse(gunzipSync(readFileSync('tests/fixtures/history/eigos-v50.json.gz')).toString('utf8'));
}
