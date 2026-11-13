import {warmLocalEmbeddings,embedLocal} from '../packages/runtime/local-embeddings.js';
import {localEmbeddingModel} from '../packages/ontology/embedding-definition.js';
await warmLocalEmbeddings();
const vector=await embedLocal('本地语义检索准备完成',AbortSignal.timeout(30000));
console.log(JSON.stringify({model:localEmbeddingModel.name,revision:localEmbeddingModel.revision,dimensions:vector.length,ready:true}));
