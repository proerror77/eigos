# RollingGo hotel search

`hotel.search.query` exposes one read-only `SearchRollingGoHotels` action through the shared MCP/A2A task catalog. It calls the international RollingGo MCP endpoint, `https://mcp.rollinggo.ai/mcp`, using a Bearer API Key. No booking, order or payment tools are admitted.

Configure Gateway and Worker with the same private settings:

- `EIGOS_ROLLINGGO_KEY_FILE`: absolute path to a regular file owned by the process user, with permissions `0600`, containing the API Key.
- `EIGOS_ROLLINGGO_KEY_SHA256`: SHA-256 of the trimmed key. Rotation requires updating this fingerprint and restarting both processes.
- `EIGOS_PERSONAL_SOURCE_OWNER`: canonical owner partition allowed to use this account. This does not replace task and source permissions.

Input includes `originQuery`, `place`, `placeType`, explicit future `checkInParam` (`checkInDate`, `stayNights`, `adultCount`), `localeParam` (`currency`, `language`) and result `size` (1–10). Missing stay criteria require clarification. Search is for one room; children and additional rooms are not supported by this search capability.

The model selects the read action from the published ontology. Execution pins the task revision, scope, account configuration and action attempt. The result is projected with a source receipt and must be read and evaluated before completion. The five-minute local freshness limit is not a provider price guarantee. Prices are source reference amounts, not confirmed availability or full checkout totals.

Under Foundation, authorize `RollingGoSearchObservation.observedData` and the `rollingGoSearchStatus` function for the task. The business view contains hotel facts, search criteria and observation times; the raw snapshot and execution bindings remain internal. Source, namespace, task, recipient and model-channel permissions still apply. The hotel search scope is a request input with managed/user origins, not a provider observation.

For an existing published business database, publish and activate the current kernel using the established ontology migration process before enabling the capability. Gateway and Worker must use the same active release. Existing active v22 and task-pinned releases remain resolvable without enabling RollingGo or rewriting their metadata. Do not create a parallel production store.

Official references: [Quick start](https://global.rollinggo.store/docs/mcp-docs/quick-start/), [tool reference](https://global.rollinggo.store/docs/mcp-docs/mcp-tool-reference/). The live international `tools/list` schema caps search results at 10 and uses lower-case place types; it takes precedence over older examples. Unit tests use synthetic source data.
