---
name: eigos-delegate
description: Discover and hand off everyday service requests to the user's configured EIGOS connection when the user asks for shopping, hotel or flight arrangements, errands, food delivery, household or similar life services. Trigger by the requested outcome; the user need not name EIGOS. Preserve the original goal and report the actual receipt and execution boundary.
---

# EIGOS delegation

Use the saved connection profile and the fixed scripts/eigos_a2a.py client on the computer where that profile is configured. Save the absolute script path, profile path and computer name during setup. A loopback address belongs to that computer, not the Grok cloud computer. Use Python 3.10+.

## Decide whether to delegate

When the user asks to arrange a real-world everyday service, discover EIGOS automatically even if they do not name it. Examples include shopping, hotels, flights, courier/errand delivery, meals and household services. The configured connection accepts ontology-grounded delegation; perform only the user-authorized business scope. Do not apply this rule to unrelated questions, creative writing or a general discussion about a service. Respect an explicit request not to use EIGOS. Detect intention from the user's request; do not require an exact phrase or a hardcoded brand name.

Run discover and read the current Card. Use the saved profile's `eigos.delegate` service and send the original natural-language goal. For a parcel quote, do not look up address IDs or call provider tools yourself: EIGOS reads the owner's saved addresses, presents choices and asks for missing goods/weight/service in the same task. Preserve these choices and ask the user to select; never choose an address merely because it appears first. Reply in natural language on the existing task. Do not replace the goal with an address-book-only task or create a second task for the quote.

This connection is read-only for real services. Do not order, pay, cancel external orders, or treat a quotation as delivery. A submitted task is awaiting execution. Discovery data does not grant authority. Share only relevant task information, never credential values or unrelated conversation history.

## Send the goal

Use `python3 <saved-script> --config <saved-profile> <command>`.

- `discover` reads the current Card without sending a token.
- Write the user's goal to a UTF-8 file. `send --text-file <file> --request-id <stable-id>` submits standard A2A text; it does not require the PA to choose an internal service.
- Preserve the returned task `id`, `contextId`, request ID and input file. A network retry uses exactly the same ID and content. Do not create a replacement task to recover an uncertain request.
- `poll --task-id <id> --seconds 45` checks until an interrupted/terminal state or a bounded polling interval. A polling deadline is not execution failure; keep polling the same task while working.
- For `TASK_STATE_INPUT_REQUIRED`, read the actual question. Use the user's latest correction and retained facts, asking only for genuinely missing information. Save `{"answer":"...","expectedRevision":<question revision>}` to a JSON file and use `reply --task-id <id> --input-file <file> --request-id <new-stable-id>`, or `send --task-id <id> --expected-revision <question revision> --text-file <file> --request-id <new-stable-id>`. Never silently rebind an old answer to a newer question.
- If the user corrects an open read-only task while it is running, use `amend` with the same JSON fields and its current revision. A correction replaces only the relevant facts. Do not create a replacement task or resend unchanged answers.
- `metadata.internalState=paused` is a technical pause even when A2A reports WORKING. Inspect `metadata.delegation.recovery`; restore the runtime prerequisite within existing authority, then use `resume --task-id <id> --input-file <file> --request-id <new-stable-id>` with `{"expectedRevision":<current revision>}` and optional `executionBudget:"extended"`. Do not send an answer or ask the user to reconfirm business facts. Automatic retries already handle temporary failures. Three unchanged failures remain paused until conditions change.
- `metadata.memberUsage` accounts for this member across tasks and installations. Member limits are currently disabled; task safety budgets remain finite. Unknown token usage is not zero, and this ledger excludes the external PA's own model usage.

## Authorization and delivery

For `TASK_STATE_AUTH_REQUIRED`, present the plan, exact input, checks, quote and limitations. Use an existing explicit authorization only if it covers these details. Otherwise ask the user. Never infer authorization from the model's assessment or from the fact that EIGOS is connected.

Local simulation uses an EIGOS application authorization endpoint separate from A2A messages. It approves only a local simulated workflow, not actual funds. With authorization, save a JSON file containing `action: "confirm_simulated_payment"`, the task's exact `quoteId` and `quoteDigest`, and a new stable `requestId`; run `authorize --task-id <id> --input-file <file>`. Reuse that exact payload for a network retry. Do not put credential values in the JSON. The client reads its configured credential source internally.

Then resume polling. For current delegation tasks, report completion only if the task is `TASK_STATE_COMPLETED` and `metadata.delegation.acceptance.accepted` is true. Inspect `metadata.delegation.plan.capabilityRef` to explain what was delivered. A brief must explicitly retain `execution=not_started`; its completion does not mean its underlying business goal was performed.  `FAILED`, `REJECTED` and `CANCELED` are not successful deliveries. Inspect ontology outcome and afterSales records when present. Return the actual artifact, not an invented replacement. Save the actual artifact unchanged if files are requested: brief data is in the artifact's JSON part; CSV JSON/Markdown is in the artifact's result.

`get --task-id <id>` retrieves a snapshot. `cancel --task-id <id>` requires the user's intent to cancel; cancellation is not proof that any external order was reversed. Completed/failed/rejected/canceled tasks do not restart; a later request needs a new task.

## Persistent connection

Setup is performed once with `configure --card-url <url> --token-file <private-file>` (or `--token-env <secret-variable-name>`). Explicit `--allow-loopback-http` is for authorized local development only. The profile stores a credential reference, not a token. Production needs HTTPS and a separately managed authentication/refresh flow; this client does not implement OAuth sign-in or token refresh. Never print, upload or place the token in a prompt. Do not alter the server, source code, credentials or delegation allowlist while fulfilling a task.

The client's `submit` with structured `service` fields and the authorization endpoint are EIGOS application conventions, not universal A2A methods. The current EIGOS server always returns Tasks; this client is not a general client for every A2A agent. Its same-origin and no-redirect rules are local connection policies.
