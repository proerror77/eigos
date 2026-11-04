import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, stat, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { digest } from '../core/delegation.js';

export const localEmbeddingSource = {
  repository: 'Xenova/multilingual-e5-small',
  revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
  dimensions: 384,
} as const;
const files = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'onnx/model_quantized.onnx',
] as const;
const manifestSchema = z.strictObject({
  version: z.literal(1),
  repository: z.literal(localEmbeddingSource.repository),
  revision: z.literal(localEmbeddingSource.revision),
  dimensions: z.literal(384),
  pooling: z.literal('mean'),
  normalize: z.literal(true),
  dtype: z.literal('q8'),
  files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
});
export interface TextEmbedder {
  readonly modelId: string;
  readonly dimensions: 384;
  embed(text: string, kind: 'query' | 'passage'): Promise<number[]>;
  close(): Promise<void>;
}
async function sha(path: string) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest('hex');
}
export function validateVector(values: readonly number[]): number[] {
  if (values.length !== 384 || values.some((v) => !Number.isFinite(v)))
    throw Error('Embedding must contain 384 finite values');
  const norm = Math.sqrt(values.reduce((n, v) => n + v * v, 0));
  if (Math.abs(norm - 1) > 0.001)
    throw Error('Embedding normalization differs');
  return [...values];
}
/** Explicit setup downloads only pinned public model artifacts. No task text. */
export async function prepareLocalEmbedding(directory: string) {
  if (!isAbsolute(directory)) throw Error('Use an absolute model directory');
  await mkdir(join(directory, 'onnx'), { recursive: true, mode: 0o700 });
  const hashes: Record<string, string> = {};
  for (const file of files) {
    const result = await fetch(
      `https://huggingface.co/${localEmbeddingSource.repository}/resolve/${localEmbeddingSource.revision}/${file}`,
      { signal: AbortSignal.timeout(180000) },
    );
    if (!result.ok || !result.body)
      throw Error(`Model artifact download failed: ${file}`);
    const bytes = Buffer.from(await result.arrayBuffer());
    if (bytes.length > 300_000_000)
      throw Error('Model artifact exceeds its bound');
    await writeFile(join(directory, file), bytes, { mode: 0o600 });
    hashes[file] = await sha(join(directory, file));
  }
  const manifest = {
    version: 1,
    ...localEmbeddingSource,
    pooling: 'mean',
    normalize: true,
    dtype: 'q8',
    files: hashes,
  };
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    { mode: 0o600 },
  );
  return {
    directory,
    modelId: digest({
      manifest,
      encoder: 'transformers.js@4.3.2/e5-prefix/mean/l2/q8/cpu/v1',
    }),
    dimensions: 384,
  };
}
export async function loadLocalEmbedding(
  directory: string,
): Promise<TextEmbedder> {
  if (!isAbsolute(directory) || (await realpath(directory)) !== directory)
    throw Error('Use the exact local model directory');
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')),
  );
  if (
    Object.keys(manifest.files).sort().join('|') !== [...files].sort().join('|')
  )
    throw Error('Model manifest file set differs');
  for (const file of files) {
    const path = join(directory, file);
    if (
      !(await stat(path)).isFile() ||
      (await sha(path)) !== manifest.files[file]
    )
      throw Error('Model artifact hash differs');
  }
  const { pipeline, env } = await import('@huggingface/transformers');
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  const encoder = await pipeline('feature-extraction', directory, {
    device: 'cpu',
    dtype: 'q8',
    local_files_only: true,
  });
  let pending: Promise<unknown> = Promise.resolve(),
    closed = false;
  return {
    modelId: digest({
      manifest,
      encoder: 'transformers.js@4.3.2/e5-prefix/mean/l2/q8/cpu/v1',
    }),
    dimensions: 384,
    embed(text, kind) {
      if (closed || !text.trim() || Buffer.byteLength(text) > 16000)
        return Promise.reject(Error('Invalid local embedding input'));
      const run = pending.then(async () => {
        const output = await encoder(`${kind}: ${text}`, {
          pooling: 'mean',
          normalize: true,
        });
        try {
          return validateVector(Array.from(output.data, Number));
        } finally {
          output.dispose();
        }
      });
      pending = run.catch(() => {});
      return run;
    },
    async close() {
      closed = true;
      await pending;
      await encoder.dispose();
    },
  };
}
