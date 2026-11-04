# Task-local supplied vectors

PA or Worker code can supply numeric vectors it has already generated. EIGOS
does not select an embedding provider, receive a provider key, or start an
embedding model. A supplied model name is a producer assertion, not proof of
model execution or business correctness.

This PostgreSQL feature ranks an explicit set of at most 50 objects already
authorized in the original task. `semanticCandidates` is a Function returning
candidate ObjectSet data. Index synchronization is a derived-data technical
operation; neither operation is a business Action Type or task completion.
The initial implementation uses exact pgvector cosine distance, without ANN.
Its coverage statement applies to the requested set, not the owner's corpus.

## Controlled installation

The ordinary v27 kernel and startup behavior remain the default. The feature
requires an existing reviewed PostgreSQL primary activation, exact pgvector
0.8.2 in `extensions`, a separately reviewed schema extension, and explicit
forward installation of the v28 function release. Existing task pins, grants,
deadlines and primary activation receipts are preserved.

Use `scripts/postgres-task-vectors.mjs` after building. An operator input file
has `version:1`, `kind:"eigos.task-vector-operation"`, `action`, a pinned
`binding:{path,sha256}`, `adminIdentity:{user,role}` and the actual external
`reviewDigest`. `action` is `prepare-schema` or `publish-kernel`. Publishing
also requires a pinned `feature:{path,sha256}` and
`expectedActive:{ref,generation}` from the actual prior release.

1. Run with only `--input /private/operation.json` to inspect an offline preview.
2. For the reviewed schema operation, pass `--apply`, its exact
   `--expected-preview-digest`, a new `--output /private/proof.json`, and a
   separate new `--feature-output /private/task-vectors.json`.
3. The command verifies committed schema/ACLs through an independent connection.
   A separate `--readback` operation can verify the pinned feature again.
4. Preview and explicitly apply `publish-kernel` against the exact prior v27
   release/generation. It appends the real software release and activates it
   for future tasks; it does not retarget old tasks.
5. Set `EIGOS_POSTGRES_VECTOR_FEATURE_FILE` to the private feature manifest for
   the same Gateway and Worker. Startup only verifies; it performs no DDL.

Existing administrator credentials come from `EIGOS_POSTGRES_ADMIN_USER` and
`EIGOS_POSTGRES_ADMIN_PASSWORD` in the host environment, using the binding's
verified TLS CA. Do not put passwords in operation files, URLs or arguments.
No command starts a publisher, Worker or model. Preserve evidence after an
uncertain commit and independently inspect before retrying.

The extension adds exactly two immutable derived-data tables and one schema
receipt table to the same business schema. Runtime has SELECT/INSERT for the
data tables and SELECT for the receipt, plus two fixed numeric wrappers.
Runtime retains no `extensions` USAGE/CREATE permission. Old binaries reject
these extra tables; a rollback requires a reviewed schema/release plan.

## Providing a batch

First read the exact permitted object fields using the ordinary task query.
Use the published task release, actual object revision, and a fixed input
encoding. `embeddedFieldInput` in `packages/ontology/semantic-retrieval.ts`
implements `canonical-fields-json-v1`:

- Sort unique field names. Encode each as `{name,present:true,value}` or
  `{name,present:false}`; missing and null differ.
- `fieldsDigest` is SHA-256 of the EIGOS canonical JSON of that array.
- Embedding input bytes are UTF-8 canonical JSON of
  `{version:1,ontologyRelease,object,revision,fields:thatArray}`.
  `inputDigest` is SHA-256 of those bytes.

`POST /ontology/vectors/sync` uses the normal bound PA bearer authentication.
Supply `version:1`, `taskId`, `expectedRequestRevision`, `ontologyRelease`, a
fresh `batchId`, and `space:{modelId,modelRevision,dimensions,metric:"cosine",
inputFormat:"canonical-fields-json-v1"}`. Each `rows` entry contains `object`,
`expectedObjectRevision`, `fields`, `fieldsDigest`, `inputDigest` and `vector`.
The task must explicitly permit processing and the exact input fields.
Query-only permission cannot synchronize an index. The server re-reads the
authorized fields and compares the digests; uploaded text or hashes grant no
access. Successful responses contain `batchId` and `batchDigest`.

Vectors must be finite, nonzero float32 values with the stated dimension.
Requests retain the existing 60,000-byte application bound; split batches that
do not fit. One task retains at most 2,000 derived rows/batches and 8 MiB of
vector/manifest payload. Idempotent repetition of the same batch does not
consume the quota again. History is not automatically deleted to free space.

An enabled PG Worker runtime exposes `vectors.syncWorker(actualClaim,
actualProcessingChannelId,packet,signal)`. It revalidates the original live claim;
model/provider work must finish outside its transaction. Claim tokens never
appear in the PA packet or model-facing tool arguments. An automatic emitter
is not installed by this API.

## Retrieving candidates

Call ordinary `evaluate_ontology` on a task pinned to the installed v28 release:
`call.function="semanticCandidates"`, with `call.object` equal to that task's
ServiceRequest. Supply the same `space`, a `queryVector`, `limit`, and
`candidates`. Each candidate supplies its object/revision/field digests plus
the committed `batchId` and `batchDigest`; several batches can cover one set.
Function view and invocation rights are independently required.

Every candidate is authorized before ranking. Output includes `candidateOnly`,
`embeddingProvenance:"producer_supplied"`, ranked refs/distances, and a digest
of the requested scope. It creates no binding for an ungranted object. Worker
planning uses the same evaluator and records all input influences, including
non-winning candidates, in its actual read receipts.

Missing, incomplete or stale vectors produce `unknown:index_incomplete`, not
an empty success. Permission revocation denies access even if old vectors
remain. Modified object revisions or fields require explicit synchronization.
Cancelled/terminal tasks reject new index writes. Old v27 tasks keep their
original permissions and cannot acquire the new Function from a software
upgrade. Re-read current permitted facts before any later business action;
similarity does not validate evidence, fulfill a Goal, or authorize an order.
