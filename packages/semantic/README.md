# Local semantic capability discovery

This module ranks current, authorized ontology metadata with a pinned local multilingual E5 model and pgvector. The first Agent entry is `discover_actions`. With the feature configured, a nonempty search uses semantic ranking by default. `searchMode: keyword` explicitly selects the existing literal lookup. Exact `actionId` discovery and later dispatch use their precise contracts.

Prepare the public model artifacts before enabling the feature:

```sh
npm run semantic:catalog -- model --model-dir /absolute/models/multilingual-e5-small
```

Setup downloads only pinned files from `Xenova/multilingual-e5-small`, revision `761b726dd34fb83930e26aab4e9ac3899aa1fa78`. The source model is MIT-licensed multilingual E5-small. The manifest records artifact hashes, 384 dimensions and the pooling/normalization contract. Serving verifies these files, loads CPU inference and disables remote model access. Queries and indexed descriptions are processed locally. The model ID includes the manifest and encoder contract. [Source model](https://huggingface.co/intfloat/multilingual-e5-small) · [ONNX conversion](https://huggingface.co/Xenova/multilingual-e5-small)

The PostgreSQL target must already have the reviewed `vector` extension in `extensions`, supplied by the parent migration's operator workflow. Use the exact existing private binding. Init and index use `EIGOS_POSTGRES_ADMIN_USER` / `EIGOS_POSTGRES_ADMIN_PASSWORD`; search uses the runtime identity and `EIGOS_POSTGRES_PASSWORD`. CA and target are read from that binding. Local synthetic tests alone can use explicit `PGHOST=127.0.0.1`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` and `PGPORT`.

```sh
npm run semantic:catalog -- init --binding /private/postgres-binding.json --model-dir /absolute/models/multilingual-e5-small --reader-role eigos_runtime
npm run semantic:catalog -- index --binding /private/postgres-binding.json --model-dir /absolute/models/multilingual-e5-small --ontology eigos.business --watch
```

Init requires a database transaction and a dedicated `eigos_semantic` or `eigos_semantic_<suffix>` schema. It revokes PUBLIC access and optionally grants the named runtime role metadata-column SELECT and EXECUTE on one fixed SQL ranking function. That function has a fixed `pg_catalog` search path, explicit relation/operator names and no dynamic SQL. Its owner accesses vector operators. The runtime reader receives no blanket privilege on `extensions` or the embedding column. Installation must be included in the deployment's reviewed role inventory.

Index builds embeddings outside its write transaction, rechecks the immutable release content, then replaces that release/model projection atomically under an advisory lock. The watch reader follows durable `published` events, advancing only after acknowledged indexing. Restart can replay events safely. The active release is indexed at startup, and `--release <digest>` selects an exact retained release. Metadata contains actions, object types and Functions; current Agent semantic discovery ranks the permitted action subset. Operator search supports `--kind action|object|function --query <text>`.

Enable the Node Worker with the prepared artifact directory, semantic schema and model:

```sh
EIGOS_STORAGE_BACKEND=postgres
EIGOS_SEMANTIC_MODEL_DIR=/absolute/models/multilingual-e5-small
EIGOS_SEMANTIC_SCHEMA=eigos_semantic
```

The Worker loads the model before serving and disposes it on shutdown. The native Agent's task-scoped Ontology MCP uses this runtime. Gateway retains exact/keyword discovery and does not load an embedding model; an explicit semantic request there reports that semantic discovery is unavailable. Existing PostgreSQL readiness, task, role, namespace, source, model-channel and claim checks surround each Agent discovery. Ranking receives only actions allowed by those checks. SQL joins the exact permitted metadata digests and pinned namespace/release/model, then the original catalog builds current contracts and binding pins. A missing/stale index rejects the semantic read. It does not become an empty successful discovery. A similarity score is candidate metadata and grants no effect.

Changing model weights, encoder version, text projection or release requires rebuilding the corresponding projection. Keep retained release indexes needed by pinned tasks. The exact lookup, Function evaluation, argument validation, action authorization and independent readback remain the acceptance path. Business instances and private task history are outside this first index corpus.

The dedicated semantic workflow executes the actual local model, actual pgvector, the operator index command and the real native PostgreSQL Agent discovery session. Tests verify Chinese paraphrase retrieval, precise contract and Function readback, a restricted database reader, stale metadata and revoked task authority. PostgreSQL migration PR #55 is this branch's explicit base dependency; no deployment or primary cutover is performed by this module.
