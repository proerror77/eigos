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
- `poll --task-id <id> --seconds 45` checks until an interrupted/terminal state or a bounded polling interval. If `resumeRequired` is true, continue the same task. A polling deadline is not execution failure.
- For `TASK_STATE_INPUT_REQUIRED`, first inspect `metadata.delegation.phase`. If it is `awaiting_pa_payment`, use the PA-owned payment handoff below. Otherwise read the actual question, answer from information the user has provided or ask the user. Save `{"answer":"..."}` to a JSON file and use `reply --task-id <id> --input-file <file> --request-id <new-stable-id>`, or `send --task-id <id> --text-file <file> --request-id <new-stable-id>`.
- An explicitly requested sandbox task uses `submit --input-file <file> --request-id <stable-id>` with `service: "eigos.delegate"`, the original `goal`, and `executionEnvironment: "sandbox"`. Preserve supplied structured requirements. Real-service requests retain their real-service boundary; do not silently turn them into simulations.
- For commerce address choices, use the labels EIGOS actually returned. When EIGOS requests a structured destination choice, return the user's selected label in a location requirement with `role: "destination"` and `expected: {"ref": "<selected label>"}`, alongside the answer. EIGOS obtains merchant, warehouse, inventory and customs facts itself; the PA supplies user context and choices.

## Authorization and delivery

For `TASK_STATE_AUTH_REQUIRED`, present the plan, exact input, checks, quote and limitations. Use an existing explicit authorization only if it covers these details. Otherwise ask the user. Never infer authorization from the model's assessment or from the fact that EIGOS is connected.

Local simulation uses an EIGOS application authorization endpoint separate from A2A messages. It approves only a local simulated workflow, not actual funds. With authorization, save a JSON file containing `action: "confirm_simulated_payment"`, the task's exact `quoteId` and `quoteDigest`, and a new stable `requestId`; run `authorize --task-id <id> --input-file <file>`. Reuse that exact payload for a network retry. Do not put credential values in the JSON. The client reads its configured credential source internally.

When `metadata.delegation.authorizationRequest` contains a `planDigest`, use `action: "approve_plan"` instead. Copy the exact plan digest, declared `effects` as `allowedEffects`, `maxAmount` and `payeeIds`; add a short explicit future `expiresAt`, `environment: "sandbox"` and a stable `requestId`. Check that the effects and cumulative spending remain within the user's existing sandbox authorization. Each new plan has its own binding. A changed plan, missing payment effect or unapproved payee is not covered by an earlier permit. The same `authorize` command submits this form; a network retry preserves the whole payload and request ID.

Then resume polling. For current delegation tasks, report completion only if the task is `TASK_STATE_COMPLETED` and `metadata.delegation.acceptance.accepted` is true. Inspect `metadata.delegation.agent.programRef`, or the existing `metadata.delegation.plan.capabilityRef`, to explain what was delivered. A brief must explicitly retain `execution=not_started`; its completion does not mean its underlying business goal was performed. Sandbox artifacts remain synthetic, including merchant facts, tax rules, orders, payments and delivery events. `FAILED`, `REJECTED` and `CANCELED` are not successful deliveries. Inspect ontology outcome and afterSales records when present. Return the actual artifact, not an invented replacement. Save the actual artifact unchanged if files are requested: brief data is in the artifact's JSON part; CSV JSON/Markdown is in the artifact's result.

## PA-owned payment handoff — isolated tests only

When the task pauses with `phase: "awaiting_pa_payment"`, read `metadata.delegation.agent.paPayment`. Its `request` binds the task, provider booking, final amount/currency, payee, payment handler and expiry. The optional Agent Card extension `/.well-known/eigos-pa-payment` publishes the schemas. This is an EIGOS application contract carried by A2A, not a universal A2A payment standard.

The PA retains its own wallet and payment authorization. The reservation permit has zero payment spend and does not authorize charging the user. This version accepts only the explicitly authorized `sandbox.pa-wallet` fixture handler. Never turn a synthetic request into a real Stripe/Link purchase. If the PA has no compatible test wallet, report that limitation while preserving the task. Do not modify the EIGOS server or its source connection to work around it.

Before initiating the authorized test payment, re-read the task: it must still be waiting, the handoff status must be `awaiting_pa`, and its terms must not have expired. Verify the provider endpoint against the PA's existing connection and the exact approved amount. Use the PA's own credential directly with that provider. Persist the original handoff ID and the PA wallet's idempotency/operation identity before sending. A timeout, duplicate handoff, or `awaiting_provider` state means query the original payment, not pay again.

After the attempt, save only `{"handoffId":"<request.id>","handoffDigest":"<request.digest>","outcome":"submitted"}` and run `payment-result --task-id <id> --input-file <file> --request-id <stable-UUID>`. Outcomes are `submitted`, `declined`, `unknown`, or `canceled`; none proves success. Do not send wallet keys, tokens, card data or a free-text “paid” reply. The client sends a structured A2A continuation with `action: "report_payment_result"`; MCP callers can use `report_payment_result` with the same fields plus `taskId` and `requestId`.

Reuse the identical notification UUID and payload on a network retry. If an independent readback is already running, query the task and retry the same notification later. EIGOS must separately read the provider's payment and booking before completion. A lost notification can be followed by an `unknown` notification or `reconcile_task`; neither initiates another payment. Cancellation withdraws the EIGOS handoff but does not reverse an already dispatched PA payment. Report a late outcome for audit; a canceled task must stay canceled.

`get --task-id <id>` retrieves a snapshot. `cancel --task-id <id>` requires the user's intent to cancel; cancellation is not proof that any external order was reversed. Completed/failed/rejected/canceled tasks do not restart; a later request needs a new task.

## Persistent connection

Setup is performed once with `configure --card-url <url> --token-file <private-file>` (or `--token-env <secret-variable-name>`). Explicit `--allow-loopback-http` is for authorized local development only. The profile stores a credential reference, not a token. Production needs HTTPS and a separately managed authentication/refresh flow; this client does not implement OAuth sign-in or token refresh. Never print, upload or place the token in a prompt. Do not alter the server, source code, credentials or delegation allowlist while fulfilling a task.

The client's `submit` with structured `service` fields and the authorization endpoint are EIGOS application conventions, not universal A2A methods. The current EIGOS server always returns Tasks; this client is not a general client for every A2A agent. Its same-origin and no-redirect rules are local connection policies.
