import type { OntologyDocument } from './schema.js';

export const documentType = 'OperationalDocumentVersion';
export const documentLink = 'SchedulePlanDocument';
export const registerDocument = 'RegisterSchedulePlanDocument';
export const registerDocumentFunction = 'registerSchedulePlanDocument';

const text = { type: 'string' };
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
  required: ['plan', ...Object.keys(fields)],
  additionalProperties: false,
};

export const documentDefinition: Pick<OntologyDocument, 'objectTypes' | 'linkTypes' | 'functionTypes' | 'actionTypes'> = {
  objectTypes: [{
    apiName: documentType,
    displayName: '业务文档版本',
    description: 'An immutable PDF or SOP edition with an original source reference and searchable extracted text.',
    primaryKey: 'id',
    titleProperty: 'name',
    interfaces: {},
    properties: {
      id: { description: 'Stable digest of the document key and edition', schema: sha256, required: true },
      ...fields,
      textSha256: { description: 'Verified SHA-256 of the extracted UTF-8 text', schema: sha256, required: true },
    },
  }],
  linkTypes: [{
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
    dependencies: { objectTypes: ['SchedulePlan', documentType], linkTypes: [documentLink] },
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
