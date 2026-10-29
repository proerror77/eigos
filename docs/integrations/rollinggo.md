# RollingGo hotel search

`hotel.search.query` exposes one read-only `SearchRollingGoHotels` action through the shared MCP/A2A task catalog. It calls the international RollingGo MCP endpoint, `https://mcp.rollinggo.ai/mcp`, using a Bearer API Key. No booking, order or payment tools are admitted.

Configure Gateway and Worker with the same private settings:

- `EIGOS_ROLLINGGO_KEY_FILE`: absolute path to a regular file owned by the process user, with permissions `0600`, containing the API Key.
- `EIGOS_ROLLINGGO_KEY_SHA256`: SHA-256 of the trimmed key. Rotation requires updating this fingerprint and restarting both processes.
- `EIGOS_PERSONAL_SOURCE_OWNER`: canonical owner partition allowed to use this account. This does not replace task and source permissions.

Input includes `originQuery`, `place`, `placeType`, explicit future `checkInParam` (`checkInDate`, `stayNights`, `adultCount`), `localeParam` (`currency`, `language`) and result `size` (1–10). Missing stay criteria require clarification. Search is for one room; children and additional rooms are not supported by this search capability.

The model selects the read action from the published ontology. Execution pins the task revision, scope, account configuration and action attempt. The result is projected with a source receipt and must be read and evaluated before completion. The five-minute local freshness limit is not a provider price guarantee. Prices are source reference amounts, not confirmed availability or full checkout totals.

Under Foundation, authorize `RollingGoSearchObservation.observedData` and the `rollingGoSearchStatus` function for the task. The business view contains hotel facts, search criteria and observation times; the raw snapshot and execution bindings remain internal. Source, namespace, task, recipient and model-channel permissions still apply. The hotel search scope is a request input with managed/user origins, not a provider observation.

For an existing v22 Foundation authority, stop Gateway/Worker and take a consistent private backup first. Run `scripts/upgrade-rollinggo-policy.mjs` with `--database`, the exact reviewed `--expected-digest` and `--expected-revision` to preview the narrowly scoped policy upgrade, then add `--apply`. It accepts only the known v22 contract, retains grant/source records, and copies namespace roles with the same action/function lists and expiries. It refuses active managers/claims, unknown contracts and pending authorization fences; it does not approve RollingGo source permissions. Primary operations must load the existing `EIGOS_AUTHORITY_FILE`.

For an existing published business database, run `node scripts/install-rollinggo-readonly.mjs --database /absolute/private/tasks.sqlite` to preview the additive installation. Review its active digest and generation, then pass those exact values as `--expected-digest` and `--expected-generation` with `--apply`. In the primary runtime also load its `EIGOS_AUTHORITY_FILE` environment. The installer publishes and activates only the missing RollingGo definitions; it grants no source or task permissions. Gateway and Worker must use the same active release. Existing active v22 and task-pinned releases remain resolvable without enabling RollingGo or rewriting their metadata. Do not create a parallel production store.

Official references: [Quick start](https://global.rollinggo.store/docs/mcp-docs/quick-start/), [tool reference](https://global.rollinggo.store/docs/mcp-docs/mcp-tool-reference/). The live international `tools/list` schema caps search results at 10 and uses lower-case place types; it takes precedence over older examples. Unit tests use synthetic source data.
