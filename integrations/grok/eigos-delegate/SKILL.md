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
- For `TASK_STATE_INPUT_REQUIRED`, first check `metadata.delegation.phase`; use the PA-owned handoff below for `awaiting_pa_payment`, otherwise read the actual question. Use the user's latest correction and retained facts, asking only for genuinely missing information. Save `{"answer":"...","expectedRevision":<question revision>}` to a JSON file and use `reply --task-id <id> --input-file <file> --request-id <new-stable-id>`, or `send --task-id <id> --expected-revision <question revision> --text-file <file> --request-id <new-stable-id>`. Never silently rebind an old answer to a newer question.
- If the user corrects an open read-only task while it is running, use `amend` with the same JSON fields and its current revision. A correction replaces only the relevant facts. Do not create a replacement task or resend unchanged answers.
- `metadata.internalState=paused` is a technical pause even when A2A reports WORKING. Inspect `metadata.delegation.recovery`; restore the runtime prerequisite within existing authority, then use `resume --task-id <id> --input-file <file> --request-id <new-stable-id>` with `{"expectedRevision":<current revision>}` and optional `executionBudget:"extended"`. Do not send an answer or ask the user to reconfirm business facts. Automatic retries already handle temporary failures. Three unchanged failures remain paused until conditions change.
- `metadata.memberUsage` accounts for this member across tasks and installations. Member limits are currently disabled; task safety budgets remain finite. Unknown token usage is not zero, and this ledger excludes the external PA's own model usage.
- An explicitly requested sandbox task uses `submit --input-file <file> --request-id <stable-id>` with `service: "eigos.delegate"`, the original `goal`, and `executionEnvironment: "sandbox"`. Preserve supplied structured requirements. Real-service requests retain their real-service boundary; do not silently turn them into simulations.
- For commerce address choices, use the labels EIGOS actually returned. When EIGOS requests a structured destination choice, return the user's selected label in a location requirement with `role: "destination"` and `expected: {"ref": "<selected label>"}`, alongside the answer. EIGOS obtains merchant, warehouse, inventory and customs facts itself; the PA supplies user context and choices.

## Authorization and delivery

For `TASK_STATE_AUTH_REQUIRED`, present the plan, exact input, checks, quote and limitations. Use an existing explicit authorization only if it covers these details. Otherwise ask the user. Never infer authorization from the model's assessment or from the fact that EIGOS is connected.

Local simulation uses an EIGOS application authorization endpoint separate from A2A messages. It approves only a local simulated workflow, not actual funds. With authorization, save a JSON file containing `action: "confirm_simulated_payment"`, the task's exact `quoteId` and `quoteDigest`, and a new stable `requestId`; run `authorize --task-id <id> --input-file <file>`. Reuse that exact payload for a network retry. Do not put credential values in the JSON. The client reads its configured credential source internally.

When `metadata.delegation.authorizationRequest` contains a `planDigest`, use `action: "approve_plan"` instead. Copy the exact plan digest, declared `effects` as `allowedEffects`, `maxAmount` and `payeeIds`; add a short explicit future `expiresAt`, `environment: "sandbox"` and a stable `requestId`. Check that the effects and cumulative spending remain within the user's existing sandbox authorization. Each new plan has its own binding. A changed plan, missing payment effect or unapproved payee is not covered by an earlier permit. The same `authorize` command submits this form; a network retry preserves the whole payload and request ID.

Then resume polling. For current delegation tasks, report completion only if the task is `TASK_STATE_COMPLETED` and `metadata.delegation.acceptance.accepted` is true. Inspect `metadata.delegation.agent.programRef`, or the existing `metadata.delegation.plan.capabilityRef`, to explain what was delivered. A brief must explicitly retain `execution=not_started`; its completion does not mean its underlying business goal was performed. Sandbox artifacts remain synthetic, including merchant facts, tax rules, orders, payments and delivery events. `FAILED`, `REJECTED` and `CANCELED` are not successful deliveries. Inspect ontology outcome and afterSales records when present. Return the actual artifact, not an invented replacement. Save the actual artifact unchanged if files are requested: brief data is in the artifact's JSON part; CSV JSON/Markdown is in the artifact's result.

## Shopify checkout payment handoff v3 — isolated tests only

When `paPayment.request.version == "3"`, the original checkout belongs to the local Shopify contract simulator. Payment authority stays with the user and PA. Use the PA's already configured isolated test Vault or account; never route synthetic terms to a real wallet. EIGOS receives no card, account token or Vault credential.

Read the exact request, full amount/currency, payee, source checkout and expiry. Inspect your own current test capability. With the supplied `eigos_test_payment.py` helper, use `--config <private PA payment profile> capabilities --task-id <original id>`. Select one supported returned capability by saving `{"handoffId":"<request.id>","handoffDigest":"<request.digest>","capability":<returned capability>}` and calling the existing `payment-route` command with a stable UUID. Do not include `wallet` for v3 or invent an available capability.

Keep the selected route and `selection.operationId`. The PA payment helper re-reads the same task, checks its private exact test authorization and environment, persists dispatch before payment, and keeps credentials outside tool output. Call its `pay --task-id <original id>` only for the authorized original checkout. Once a dispatch exists, repeated `pay` calls query it; `query` explicitly reads that same operation. Unknown, declined, expired or missing results never authorize another payment or route switch. The helper supports only pinned loopback simulation and documented test instruments, not a real Grok Vault or payment provider.

After an attempt, use the existing `payment-result` command with only the original handoff ID/digest and `submitted`, `unknown`, `declined` or `canceled`. Continue reading the same EIGOS task until its independent merchant payment AND original order checks finish. Read the final artifact back to the user and label it as synthetic test checkout/payment with `realPayment=false`; it is not official Shopify development-store integration or fulfillment.

## PA-owned payment handoff — isolated tests only

When the task pauses with `phase: "awaiting_pa_payment"`, read `metadata.delegation.agent.paPayment`. Its `request` binds the task, provider booking, final amount/currency, payee, payment handler and expiry. The optional Agent Card extension `/.well-known/eigos-pa-payment` publishes the schemas. This is an EIGOS application contract carried by A2A, not a universal A2A payment standard.

The PA retains its own wallet and payment authorization. The reservation permit has zero payment spend and does not authorize charging the user. Version 2 keeps both routes: prefer Link Agent Wallet when usable, otherwise hand the provider's ordinary Link checkout to the user. In the current sandbox, the wallet handler is `sandbox.pa-wallet` and the checkout is an explicitly labeled local simulation. Never turn a synthetic request into a real Stripe/Link purchase. Actual Link and merchant connections require their own admission and verified bindings.

Before choosing a route, inspect the PA's existing wallet capability and current eligibility. A logged-in ordinary Link checkout account does not prove Agent Wallet eligibility. Report `available/ready` only when the appropriate wallet capability is usable; otherwise use `unavailable` with `region_unsupported`, `not_connected`, `connector_missing` or `wallet_unavailable`. Unknown status remains `unknown/unknown`. Do not repeat authorization attempts for an unchanged region denial, and do not interpret a declined or already submitted payment as wallet unavailability.

Save `{"handoffId":"<request.id>","handoffDigest":"<request.digest>","wallet":{"status":"unavailable","reason":"region_unsupported","observedAt":"<current ISO time>"}}` to a file and run `payment-route --task-id <id> --input-file <file> --request-id <stable-UUID>`. EIGOS checks the original unpaid booking and selects the preferred usable route. Preserve `metadata.delegation.agent.paPayment.selection`; retries reuse the exact UUID and input. If a selection already exists, use it rather than selecting again. This observation and selection grant no new payment authority.

If provider facts have expired before a route is selected, use `reconcile --task-id <id> --request-id <stable-UUID>` (the existing EIGOS readback endpoint) or MCP `reconcile_task`, then poll the original task. This refreshes source facts without pretending that a payment was attempted. Do not replace the booking or submit a false payment notification merely to refresh it.

For `selection.route == "link_agent_wallet"`, use the PA's own compatible wallet directly with the provider. For `link_checkout`, show the user the exact source-provided `request.terms.checkout.url` and ask them to confirm in the merchant page; do not request their card details or claim that opening the URL completed payment. A real ordinary Link checkout is a user-confirmed flow. Do not guess payment URLs, open another booking, or execute credentials against a different recipient.

Before any authorized payment, re-read the task: it must still be waiting, its status must be `awaiting_pa` or `awaiting_user`, the route must match the saved selection, and the terms must not have expired. Verify the endpoint, payee and exact amount. Persist the handoff ID, `selection.operationId` and the wallet's original operation identity before dispatch. An issued route may already be in use. A timeout, payment decline, duplicate handoff or `awaiting_provider` state means query the original payment, never automatically switch routes or pay again.

After the wallet attempt or the user's checkout response, save only `{"handoffId":"<request.id>","handoffDigest":"<request.digest>","outcome":"submitted"}` and run `payment-result --task-id <id> --input-file <file> --request-id <stable-UUID>`. Outcomes are `submitted`, `declined`, `unknown`, or `canceled`; none proves success. Do not send wallet keys, tokens, card data or a free-text “paid” reply. The client sends a structured A2A continuation with `action: "report_payment_result"`; MCP callers can use `report_payment_result` with the same fields plus `taskId` and `requestId`. Browser redirects, page success messages and URL parameters are not payment evidence.

Reuse the identical notification UUID and payload on a network retry. If an independent readback is already running, query the task and retry the same notification later. EIGOS must separately read the provider's payment and booking before completion. A lost notification can be followed by an `unknown` notification or `reconcile_task`; neither initiates another payment. Cancellation withdraws the EIGOS handoff but does not reverse an already dispatched PA payment. Report a late outcome for audit; a canceled task must stay canceled.

`get --task-id <id>` retrieves a snapshot. `cancel --task-id <id>` requires the user's intent to cancel; cancellation is not proof that any external order was reversed. Completed/failed/rejected/canceled tasks do not restart; a later request needs a new task.

## Persistent connection

Setup is performed once with `configure --card-url <url> --token-file <private-file>` (or `--token-env <secret-variable-name>`). Explicit `--allow-loopback-http` is for authorized local development only. The profile stores a credential reference, not a token. Production needs HTTPS and a separately managed authentication/refresh flow; this client does not implement OAuth sign-in or token refresh. Never print, upload or place the token in a prompt. Do not alter the server, source code, credentials or delegation allowlist while fulfilling a task.

The client's `submit` with structured `service` fields and the authorization endpoint are EIGOS application conventions, not universal A2A methods. The current EIGOS server always returns Tasks; this client is not a general client for every A2A agent. Its same-origin and no-redirect rules are local connection policies.
