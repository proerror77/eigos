import { z } from 'zod';
import { classificationSchema } from './classification.js';
import type { OntologyDocument } from './schema.js';

export const documentType = 'OperationalDocumentVersion';
export const documentChunkType = 'OperationalDocumentChunk';
export const documentChunkLink = 'DocumentVersionChunk';
export const documentLink = 'SchedulePlanDocument';
export const registerDocument = 'RegisterSchedulePlanDocument';
export const registerDocumentFunction = 'registerSchedulePlanDocument';

const text = { type: 'string' };
const nonnegative = { type: 'integer', minimum: 0 };
const positive = { type: 'integer', minimum: 1 };
const label = z.toJSONSchema(classificationSchema);
const locationRange = {
  type: 'object',
  properties: { startOffset: nonnegative, endOffset: positive, page: positive, paragraph: positive },
  required: ['startOffset', 'endOffset'],
  additionalProperties: false,
};
const sha256 = { ...text, pattern: '^[a-f0-9]{64}$' };
const ref = {
  type: 'object',
  properties: { type: text, id: text },
  required: ['type', 'id'],
  additionalProperties: false,
};
const fields = {
  documentKey: { description: 'Stable identity across editions', schema: { ...text, minLength: 1, maxLength: 200 }, required: true },
  edition: { description: 'Immutable source version', schema: { ...text, minLength: 1, maxLength: 100 }, required: true },
  name: { description: 'Document title', schema: { ...text, minLength: 1, maxLength: 200 }, required: true },
  mediaType: { description: 'Original media format', schema: { ...text, enum: ['application/pdf', 'text/markdown', 'text/plain'] }, required: true },
  sourceRef: {
    description: 'Opaque identity in the source system',
    schema: { ...text, pattern: '^[A-Za-z0-9][A-Za-z0-9_./:-]{0,499}$' },
    required: true,
  },
  contentSha256: { description: 'SHA-256 reported by the importer for the original document', schema: sha256, required: true },
  classification: { description: 'Data disclosure level and compartment requirements', schema: label, required: false },
  locationRanges: {
    description: 'Optional source page and paragraph locations, using Unicode code point offsets',
    schema: { type: 'array', maxItems: 512, items: locationRange },
    required: false,
  },
  extractedText: {
    description: 'Versioned extracted text from the importer',
    schema: { ...text, minLength: 1, maxLength: 64000, pattern: '\\S' },
    required: true,
    renderHints: { hidden: true },
  },
};
const parameters = {
  type: 'object',
  properties: { plan: ref, ...Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.schema])) },
  required: ['plan', ...Object.entries(fields).filter(([, field]) => field.required).map(([name]) => name)],
  additionalProperties: false,
};

export const documentDefinition: Pick<OntologyDocument, 'objectTypes' | 'linkTypes' | 'functionTypes' | 'actionTypes'> = {
  objectTypes: [{
    apiName: documentType,
    displayName: '业务文档版本',
    description: 'An immutable PDF or SOP edition with an original source reference and searchable extracted text.',
    primaryKey: 'id',
    titleProperty: 'name',
    classificationProperty: 'classification',
    interfaces: {},
    properties: {
      id: { description: 'Stable digest of the document key and edition', schema: sha256, required: true },
      ...fields,
      textSha256: { description: 'Verified SHA-256 of the extracted UTF-8 text', schema: sha256, required: true },
    },
  }, {
    apiName: documentChunkType,
    displayName: '文档引用片段',
    description: 'Searchable passage with an exact edition, character span and source locator where available.',
    primaryKey: 'id',
    titleProperty: 'name',
    classificationProperty: 'classification',
    interfaces: {},
    properties: {
      id: { description: 'Stable digest of the version and character range', schema: sha256, required: true },
      name: { description: 'Passage title', schema: text, required: true },
      documentId: { description: 'Immutable parent document version ID', schema: sha256, required: true },
      index: { description: 'Zero-based passage number', schema: nonnegative, required: true },
      startOffset: { description: 'Inclusive Unicode code point offset', schema: nonnegative, required: true },
      endOffset: { description: 'Exclusive Unicode code point offset', schema: positive, required: true },
      page: { description: 'Original source page when supplied', schema: positive, required: false },
      paragraph: { description: 'Original source paragraph when supplied', schema: positive, required: false },
      text: { description: 'Versioned extracted passage', schema: { ...text, minLength: 1, maxLength: 3000 }, required: true },
      classification: { description: 'Data disclosure level inherited from the version', schema: label, required: false },
    },
  }],
  linkTypes: [{
    apiName: documentChunkLink,
    description: 'An immutable document edition and its ordered source passages.',
    from: { type: documentType, name: 'chunks', cardinality: 'many' },
    to: { type: documentChunkType, name: 'version', cardinality: 'one' },
  }, {
    apiName: documentLink,
    description: 'The document versions used by a schedule plan.',
    from: { type: 'SchedulePlan', name: 'documents', cardinality: 'many' },
    to: { type: documentType, name: 'plans', cardinality: 'many' },
  }],
  functionTypes: [{
    apiName: registerDocumentFunction,
    description: 'Prepare a versioned document for a schedule plan and stage the document and its Link together.',
    parameters,
    returns: ref,
    edits: true,
    dependencies: { objectTypes: ['SchedulePlan', documentType, documentChunkType], linkTypes: [documentLink, documentChunkLink] },
  }],
  actionTypes: [{
    apiName: registerDocument,
    description: 'Register a PDF or SOP edition with caller-provided metadata and extracted text, and attach it to a schedule plan.',
    parameters,
    objectParameters: { plan: 'SchedulePlan' },
    submissionCriteria: [],
    function: registerDocumentFunction,
  }],
};
