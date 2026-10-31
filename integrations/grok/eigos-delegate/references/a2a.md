## A2A on the same primary instance

A2A is an independently authenticated protocol path. Use the saved client on the user's connected Mac, where its private profile lives. The client uses device OAuth and rotating refresh credentials through AgentConnector; it does not expose token values to the model.

Commands follow this form:

```text
node <saved-client> --profile <saved-profile> discover
node <saved-client> --profile <saved-profile> login
node <saved-client> --profile <saved-profile> status
node <saved-client> --profile <saved-profile> a2a --input <request.json> --output <receipt.json>
```

The standard client validates new-task data with the same input schema as EIGOS before opening credentials or making a network request. It can canonicalize an explicit shared `locationContext.source="user_provided"` onto each named endpoint. It preserves the original goal and message ID; it never infers current location, observation times, missing provenance or permission. Conflicting provenance is rejected locally with field paths. Use the normal endpoint-level schema above; no manual JSON correction or per-business execution script is needed for this known shared-source form.

`discover` returns the current runtime and Agent Card. Compare instance and releaseDigest with native MCP `get_runtime_info`. Complete device login as the same EIGOS member used for native MCP. An active installation and a successful protocol response are separate checks.

For readback, write an A2A 1.0 JSON-RPC request with method `GetTask` and `params.id` equal to the existing taskId. For a continuation, use `SendMessage` with `configuration.returnImmediately=true`, `message.role="ROLE_USER"`, a new stable `message.messageId`, the original `message.taskId` and `message.contextId`, text parts, and `message.metadata.expectedRevision` from the current task. Save the exact request before sending. The client preserves the request, injects authorization internally, and never automatically replays writes.

An A2A continuation must not create a second task. Inspect the actual JSON-RPC response; a transport success containing an `error` is not success.

For a newly authorized request, `run --text-file <goal> --request-id <stable-id> --save-dir <private-directory>` combines discovery, one submission, polling and saving raw receipts in one client invocation. It outputs compact delivery text for the PA to relay; complete structured artifacts remain saved. It polls for up to 55 seconds (default interval 0.25 seconds); the separate poll command retains its 45-second limit. `run --spec-file <private-JSON>` can supply saved profile, textFile, requestId, saveDir and optional seconds/interval without credential values or a business plan. When `resumeRequired=true`, repeat the identical command and directory: it reads the saved task, never submits a replacement. An uncertain send stops for inspection of the original request identity. Input-required, authorization-required and failed states stop without responding, approving, paying or retrying. Use the explicit continuation flow for any user input or authority. The run also saves phase timing and the actual received UTC before final readback and artifact processing.

`get --task-id <id>` retrieves a snapshot. `cancel --task-id <id>` requires the user's intent to cancel; cancellation is not proof that any external order was reversed. Completed/failed/rejected/canceled tasks do not restart; a later request needs a new task.

## Persistent connection

Foundation setup uses `configure --card-url <https-url> --security-mode foundation --agent-credential-file <private-installation-file> --node-bin <absolute-node-path> --agent-request-helper <absolute-reviewed-agent-request.mjs>`. Each installation has its own Node AgentConnector credential file; `scripts/agent-enroll.mjs begin/finish` performs provider device enrollment, with the human completing the provider page. The member then approves the installation's task/data ceiling and sources. The Python process delegates authenticated requests to AgentConnector, which handles rotating refresh credentials without returning bearer values to Python. On hosts that require an existing environment proxy, add `--node-use-env-proxy` with a Node version supporting that flag. Configure verifies the installation context before replacing the profile.

Legacy setup remains `configure --card-url <url> --token-file <private-file>` (or `--token-env <secret-variable-name>`). Explicit `--allow-loopback-http` is for authorized local development only. The profile stores a credential reference, not a token. A legacy token-file profile does not perform OAuth refresh. Never print, upload or place the token in a prompt. Do not alter the server, source code, credentials or delegation allowlist while fulfilling a task.

The client's `submit` with structured `service` fields and the authorization endpoint are EIGOS application conventions, not universal A2A methods. The current EIGOS server always returns Tasks; this client is not a general client for every A2A agent. Its same-origin and no-redirect rules are local connection policies.
