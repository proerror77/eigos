import { createHash } from 'node:crypto';
import { parseDocument, visit, isAlias } from 'yaml';
import { z } from 'zod';
import { DomainError } from '../../core/domain.js';
import { digest } from '../../core/delegation.js';
import type { RollingGoProgram } from '../../capabilities/rollinggo/program.js';
import { rollingGoActions } from '../rollinggo.js';
import { assertDefinitionJson } from '../definition-contracts.js';
import type { OntologyModel } from '../model.js';
import { parsePipelineIntake, type PipelineIntake } from './contracts.js';
import { mapPipelineFields } from './mapping.js';

const text = z.string().min(1).max(500);
const columnSchema = z.object({ id: text, name: text });
const tableSchema = z.object({ id: text, name: text, columns: z.array(columnSchema).min(1).max(50) });
const documentSchema = z.strictObject({
  data_layer: z.object({ databases: z.array(z.object({ id: text, schemas: z.array(z.object({
    tables: z.array(tableSchema).max(100),
  })).max(20) })).min(1).max(20) }),
  semantic_layer: z.object({ terms: z.array(z.object({ id: text, name: text,
    represents: z.array(text).min(1).max(20),
    columns_attributes: z.array(z.object({ id: text, name: text, column_id: text })).max(50),
  })).min(1).max(100), sql_attributes: z.record(z.string(), z.array(z.unknown()).max(100)).optional(),
  custom_analyses: z.array(z.unknown()).max(100).optional() }),
  zones: z.array(z.unknown()).max(100).optional(),
});
type HotelType = 'HotelProperty' | 'HotelPrice';
type HotelSamples = Record<HotelType, Record<string, unknown>[]>;
export interface AutoOntologyHotelImport {
  model: OntologyModel;
  program: RollingGoProgram;
  source: Omit<PipelineIntake['source'], 'digest'>;
  serviceId: string;
  /** Reviewed physical table IDs; generated labels never select business types. */
  tables: Record<HotelType, string>;
  /** Properties already produced by RollingGoProgram.project, including their IDs. */
  samples: HotelSamples;
  conditions: PipelineIntake['conditions'];
}

function fail(message: string): never { throw new DomainError('INVALID_INPUT', message); }

/** Read a bounded native Auto Ontology document. SQL, tags and aliases are not an import language. */
function readDocument(yaml: string) {
  if (typeof yaml !== 'string' || Buffer.byteLength(yaml) > 256000) fail('Auto Ontology YAML is limited to 256 KB');
  const doc = parseDocument(yaml, { version: '1.2', schema: 'core', strict: true, uniqueKeys: true, stringKeys: true, prettyErrors: false });
  if (doc.errors.length || doc.warnings.length || doc.directives?.yaml.version !== '1.2') fail('Expected one valid YAML 1.2 document without custom tags');
  let nodes = 0;
  visit(doc, (_key, node, path) => {
    if (++nodes > 10000 || path.length > 32) fail('Auto Ontology YAML exceeds its structural bound');
    if (isAlias(node) || node && typeof node === 'object' && 'tag' in node && node.tag) fail('YAML aliases and explicit tags are not supported');
  });
  const value: unknown = doc.toJS({ maxAliasCount: 0 });
  assertDefinitionJson(value);
  const parsed = documentSchema.safeParse(value);
  if (!parsed.success) fail('Expected a native Auto Ontology catalog and semantic layer');
  const layer = parsed.data.semantic_layer;
  if (Object.values(layer.sql_attributes ?? {}).some(items => items.length) || layer.custom_analyses?.length) fail('SQL-derived attributes and custom analyses are not supported');
  return parsed.data;
}

const allowed: Record<HotelType, readonly string[]> = {
  HotelProperty: ['displayTitle', 'sourceId', 'hotelName', 'address'],
  HotelPrice: ['displayTitle', 'observedAt', 'expiresAt', 'hotelRevision', 'requestRevision', 'checkInDate', 'stayNights', 'adultCount',
    'referenceAmount', 'currency', 'hasPrice', 'priceKind', 'amountUnit', 'priceBasis', 'pricingCompleteness'],
};

/** Converts generated metadata into an unverified intake for the existing hotel program.
 * Mappings describe its canonical projection properties. They do not ingest raw
 * hotel arrays or write a second set of hotel identities through PipelineFactStore.
 * No source access, publication, activation or authorization occurs here.
 */
export function importAutoOntologyHotel(yaml: string, options: AutoOntologyHotelImport): PipelineIntake {
  const document = readDocument(yaml), { model, program } = options;
  const actionId = 'SearchRollingGoHotels', action = model.action(actionId), capability = program.capability();
  if (program.ref.id !== 'hotel.search.query' || program.ref.version !== '1'
    || digest(program.actionIds) !== digest([actionId]) || digest(action.read) !== digest(rollingGoActions[0]!.read)
    || !capability.environment || !['sandbox', 'live'].includes(capability.environment)) fail('An exact existing RollingGo read-only program binding is required');
  if (options.tables.HotelProperty === options.tables.HotelPrice) fail('Hotel entities and price observations need distinct reviewed tables');

  const tables = document.data_layer.databases.flatMap(database => database.schemas.flatMap(schema => schema.tables));
  const tableById = new Map<string, typeof tables[number]>(), columnTable = new Map<string, string>();
  const termIds = new Set<string>(), attributeIds = new Set<string>();
  for (const table of tables) {
    if (tableById.has(table.id)) fail('Duplicate physical table identity');
    tableById.set(table.id, table);
    const names = new Set<string>();
    for (const column of table.columns) {
      if (columnTable.has(column.id) || names.has(column.name)) fail('Duplicate physical column identity or name');
      names.add(column.name); columnTable.set(column.id, table.id);
    }
  }
  for (const term of document.semantic_layer.terms) {
    if (termIds.has(term.id) || new Set(term.represents).size !== term.represents.length || term.represents.some(id => !tableById.has(id))) fail('Invalid term identity or table reference');
    termIds.add(term.id);
    for (const attribute of term.columns_attributes) {
      if (attributeIds.has(attribute.id) || !term.represents.includes(columnTable.get(attribute.column_id) ?? '')) fail('Invalid semantic column reference');
      attributeIds.add(attribute.id);
    }
  }

  const vocabulary: PipelineIntake['vocabulary'] = [], mappings: PipelineIntake['mappings'] = [], fixtures: PipelineIntake['fixtures'] = [];
  for (const objectType of ['HotelProperty', 'HotelPrice'] as const) {
    const table = tableById.get(options.tables[objectType]);
    if (!table) fail(`Missing reviewed ${objectType} table`);
    const type = model.object(objectType), terms = document.semantic_layer.terms.filter(term => term.represents.includes(table.id));
    if (model.objectWritePolicy(objectType) !== 'source' || !terms.length || terms.some(term => term.represents.length !== 1)) fail('Each hotel projection needs unambiguous source-backed terms');
    for (const term of terms) vocabulary.push({ term: term.name, aliases: [], objectType });
    const names = new Set(table.columns.map(column => column.name));
    const nativeId = objectType === 'HotelProperty' ? 'sourceId' : type.primaryKey;
    if (!names.has(nativeId)) fail(`${objectType} needs its existing source projection identity`);
    if (table.columns.some(column => !type.properties[column.name] || column.name !== type.primaryKey && !allowed[objectType].includes(column.name))) fail(`Unreviewed ${objectType} projection field`);
    for (const [name, property] of Object.entries(type.properties)) {
      if (property.required && name !== type.primaryKey && !names.has(name)) fail(`Missing required ${objectType}.${name} column`);
    }
    const mapping = { id: objectType === 'HotelProperty' ? 'hotel' : 'price', objectType, nativeId: [nativeId], maxAgeMs: 300000,
      fields: table.columns.filter(column => column.name !== type.primaryKey).map(column => ({
        from: [column.name], to: [column.name], optional: !type.properties[column.name]!.required,
      })) };
    const samples = options.samples[objectType];
    if (!Array.isArray(samples) || !samples.length || samples.length > 10) fail('Each hotel projection needs 1 to 10 contract samples');
    for (const sample of samples) {
      assertDefinitionJson(sample);
      model.parseProperties(objectType, sample);
      if (typeof sample[nativeId] !== 'string' || !String(sample[nativeId]).trim()) fail('A source projection identity is required in every sample');
      if (Object.keys(sample).some(name => name !== type.primaryKey && !names.has(name))) fail('The YAML omits an observed projection field');
      const expected = mapPipelineFields(mapping, sample), { [type.primaryKey]: _identity, ...properties } = sample;
      if (digest(expected) !== digest(properties)) fail('A mapping would lose observed hotel properties');
      fixtures.push({ mappingId: mapping.id, input: structuredClone(sample), expected });
    }
    mappings.push(mapping);
  }
  return parsePipelineIntake({ format: 'eigos.ontology.pipeline.v1', serviceId: options.serviceId,
    source: { ...options.source, digest: createHash('sha256').update(yaml).digest('hex') },
    programRef: { ...program.ref }, configurationDigest: program.configurationDigest, environment: capability.environment,
    vocabulary, mappings, fixtures, conditions: options.conditions,
    actions: [{ actionId, definitionDigest: digest(action), requiredEvidence: capability.environment === 'sandbox' ? 'synthetic' : 'live_readonly' }],
  });
}
