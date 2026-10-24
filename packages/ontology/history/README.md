# Frozen business model predecessor

`business-v14.json` is immutable input for the named `eigos.business@14` to `@15`
metadata migration. It was extracted from the pre-repair baseline at commit
`07f462e`, with model digest
`8482a64b0e6d058454af37bc8951dd703e152061d8ced023785cbf8b619c0f94`.

The source is `data/ontology-architecture-2026-10-21/baseline/model-v14.json`.
Its 137 object fingerprints and 575 link digests were independently pinned in
`tests/fixtures/ontology-v14-fingerprints.json`. This smaller runtime snapshot
retains the exact property JSON Schemas and fingerprint metadata for affected
objects, announced additive changes, and the named earlier integration schemas.
Per-object navigation and presentation visibility are excluded exactly as they
were excluded by the v14 object-fingerprint algorithm. Each remaining definition
must reproduce its pinned fingerprint. Link snapshots use `digest`, not
`fingerprint`; no existing v14 link definition changed in this transition.

The fixture `tests/fixtures/ontology-v14-migration-objects.json` contains minimal
synthetic old facts for compatibility checks, not business-completion evidence.
Metadata migration changes only `definition_digest`; it does not rewrite facts,
source bytes, object revisions, link endpoints, task versions, plans or grants.

Do not regenerate this history from the current model or change an old pin to
make a test pass. A further changed v14 type must be copied from the same frozen
baseline and checked against the independent fingerprint fixture. Future model
transitions require their own frozen predecessor and named migration.
