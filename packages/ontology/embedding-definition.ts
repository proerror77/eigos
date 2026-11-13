import type { OntologyDocument } from './schema.js';

export const localEmbeddingModel = {
  name: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
  revision: '2c4055b12046f11709e9df2c122e59ffbdc2f900',
  dimensions: 384,
};
export const localEmbeddingDefinition: OntologyDocument['functionTypes'][number] & { version: string } = {
  apiName: 'embedTextLocal',
  version: 'multilingual-minilm-1',
  description:
    'Embed text locally with pinned multilingual MiniLM weights. Text stays in the runtime process. The first call downloads the public model into the configured host cache.',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', minLength: 1, maxLength: 4000 } },
    required: ['text'],
    additionalProperties: false,
  },
  returns: { type: 'array', items: { type: 'number' }, minItems: 384, maxItems: 384 },
  dependencies: {},
};
