import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { FeatureExtractionPipeline } from '@huggingface/transformers';
import { localEmbeddingDefinition, localEmbeddingModel } from '../ontology/embedding-definition.js';
import type { VersionedFunction } from './functions.js';

let extractor: Promise<FeatureExtractionPipeline> | undefined;
let tail: Promise<unknown> = Promise.resolve();
let pending = 0;
export async function warmLocalEmbeddings() {
  if (!extractor) {
    extractor = (async () => {
      const cache = process.env.EIGOS_EMBEDDING_CACHE ?? join(homedir(), '.cache', 'eigos', 'embeddings');
      await mkdir(cache, { recursive: true });
      const { pipeline } = await import('@huggingface/transformers');
      return pipeline('feature-extraction', localEmbeddingModel.name, {
        revision: localEmbeddingModel.revision,
        cache_dir: cache,
        dtype: 'q8',
        device: 'cpu',
        session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
      });
    })().catch((error) => {
      extractor = undefined;
      throw error;
    });
  }
  return extractor;
}
export async function embedLocal(text: string, signal: AbortSignal): Promise<number[]> {
  signal.throwIfAborted();
  if (pending >= 16) throw new Error('Local embedding queue is full; retry when current indexing completes');
  pending++;
  const work = tail
    .then(async () => {
      signal.throwIfAborted();
      const model = await warmLocalEmbeddings();
      signal.throwIfAborted();
      const characters = Array.from(text),
        chunks: string[] = [];
      for (let offset = 0; offset < characters.length; offset += 224)
        chunks.push(characters.slice(offset, offset + 256).join(''));
      const output = await model(chunks, { pooling: 'mean', normalize: true });
      signal.throwIfAborted();
      const vectors = output.tolist() as number[][];
      const result = Array<number>(localEmbeddingModel.dimensions).fill(0);
      for (const vector of vectors) {
        if (vector.length !== result.length || vector.some((value) => !Number.isFinite(value)))
          throw new Error('Embedding model returned invalid dimensions');
        for (let index = 0; index < vector.length; index++) result[index]! += vector[index]! / vectors.length;
      }
      const norm = Math.hypot(...result);
      if (!Number.isFinite(norm) || norm === 0) throw new Error('Embedding model returned an empty vector');
      return result.map((value) => value / norm);
    })
    .finally(() => {
      pending--;
    });
  tail = work.catch(() => {});
  return work;
}
export const localEmbeddingVersion: VersionedFunction = {
  definition: localEmbeddingDefinition,
  implementationId:
    localEmbeddingModel.name +
    '@' +
    localEmbeddingModel.revision +
    ':transformers4.3.2:q8:chunks256-overlap32:mean-normalize-v1',
  handler: (input, context) => embedLocal(String(input.text), context.signal),
};
