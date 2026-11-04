import { loadLocalEmbedding } from './local-embedding.js';
import { SemanticCatalog } from './catalog.js';
export async function createSemanticRuntime(config: {
  EIGOS_SEMANTIC_MODEL_DIR?: string;
  EIGOS_SEMANTIC_SCHEMA?: string;
}) {
  if (!config.EIGOS_SEMANTIC_MODEL_DIR) return;
  const embedding = await loadLocalEmbedding(config.EIGOS_SEMANTIC_MODEL_DIR);
  try {
    return {
      catalog: new SemanticCatalog(
        embedding,
        config.EIGOS_SEMANTIC_SCHEMA ?? 'eigos_semantic',
      ),
      close: () => embedding.close(),
    };
  } catch (error) {
    await embedding.close();
    throw error;
  }
}
