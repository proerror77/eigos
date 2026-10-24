---
name: eigos-delegate
description: Discover the user's configured EIGOS services, delegate a supported goal, and continue the same task through native MCP or authenticated A2A. Verify the current deployment and actual delivery.
---

# EIGOS delegation

Use the saved primary HTTPS connection. Native MCP and A2A must reach the same instance and the same member identity. Do not use historical loopback profiles or old task successes as evidence for the current service.

## Discover and delegate

For a requested service outcome, inspect EIGOS when it may provide a relevant capability. Respect an explicit instruction not to delegate. Use native MCP `get_runtime_info` and `list_services`; report the actual capability scope. Do not turn an unsupported real-world request into a completed task brief or document.

Use the host's native EIGOS MCP connection by default. Native discovery or calls must not be replaced with Shell, curl, Python or the A2A transport. If authentication fails, complete the host's OAuth flow or report the actual failure. Never read, print, copy or place an access token, refresh token or client secret in a prompt or tool argument.

Submit the user's original goal through native `submit_task`, using a stable requestId. Retain the taskId, contextId and request ID. Network retries preserve the original content and ID; never create a replacement task to escape an uncertain result or execution budget.

Read the same task with `get_task`, normally using `waitMs: 30000` while submitted or working. A wait deadline is not a failure. For input-required, use only information supplied by the user; ask for actual missing facts. Reply on the same task using the current expectedRevision and a new stable request ID. Do not repeat questions already answered.

Technical recovering or paused states are not missing business input. Preserve the task and confirmed facts, identify the runtime prerequisite, then use `resume_task` only after it changes. Do not repeatedly retry the same unchanged failure. Cancellation requires the user's intent and does not prove that an external order was canceled.

## A2A on the same primary instance

A2A is an independently authenticated protocol path. Use the saved client on the user's connected Mac, where its private profile lives. The client uses device OAuth and rotating refresh credentials through AgentConnector; it does not expose token values to the model.

Commands follow this form:

```text
node <saved-client> --profile <saved-profile> discover
node <saved-client> --profile <saved-profile> login
node <saved-client> --profile <saved-profile> status
node <saved-client> --profile <saved-profile> a2a --input <request.json> --output <receipt.json>
```

`discover` returns the current runtime and Agent Card. Compare instance and releaseDigest with native MCP `get_runtime_info`. Complete device login as the same EIGOS member used for native MCP. An active installation and a successful protocol response are separate checks.

For readback, write an A2A 1.0 JSON-RPC request with method `GetTask` and `params.id` equal to the existing taskId. For a continuation, use `SendMessage` with `configuration.returnImmediately=true`, `message.role="ROLE_USER"`, a new stable `message.messageId`, the original `message.taskId` and `message.contextId`, text parts, and `message.metadata.expectedRevision` from the current task. Save the exact request before sending. The client preserves the request, injects authorization internally, and never automatically replays writes.

An A2A continuation must not create a second task. Inspect the actual JSON-RPC response; a transport success containing an `error` is not success.

## Shopify checkout payment handoff v3 — isolated tests only

When `paPayment.request.version == "3"`, the original checkout belongs to the local Shopify contract simulator. Payment authority stays with the user and PA. Use the PA's already configured isolated test Vault or account; never route synthetic terms to a real wallet. EIGOS receives no card, account token or Vault credential.

Read the exact request, full amount/currency, payee, source checkout and expiry. Inspect your own current test capability. With the supplied `eigos_test_payment.py` helper, use `--config <private PA payment profile> capabilities --task-id <original id>`. Select one supported returned capability by saving `{"handoffId":"<request.id>","handoffDigest":"<request.digest>","capability":<returned capability>}` and calling the existing `payment-route` command with a stable UUID. Do not include `wallet` for v3 or invent an available capability.

Keep the selected route and `selection.operationId`. The PA payment helper re-reads the same task, checks its private exact test authorization and environment, persists dispatch before payment, and keeps credentials outside tool output. Call its `pay --task-id <original id>` only for the authorized original checkout. Once a dispatch exists, repeated `pay` calls query it; `query` explicitly reads that same operation. Unknown, declined, expired or missing results never authorize another payment or route switch. The helper supports only pinned loopback simulation and documented test instruments, not a real Grok Vault or payment provider.

After an attempt, use the existing `payment-result` command with only the original handoff ID/digest and `submitted`, `unknown`, `declined` or `canceled`. Continue reading the same EIGOS task until its independent merchant payment AND original order checks finish. Read the final artifact back to the user and label it as synthetic test checkout/payment with `realPayment=false`; it is not official Shopify development-store integration or fulfillment.

## Booking payment handoff v2 — isolated tests only

Apply this section only when `paPayment.request.version == "2"`. Inspect the original booking, full price, payee and expiry. The PA observes its own current Link Agent Wallet test availability; unknown availability does not authorize a fallback or a new payment.

Save `{"handoffId":"<request.id>","handoffDigest":"<request.digest>","wallet":{"status":"unavailable","reason":"region_unsupported","observedAt":"<current ISO time>"}}` to a file and run `payment-route --task-id <id> --input-file <file> --request-id <stable-UUID>`. EIGOS checks the original unpaid booking and selects the preferred usable route. Preserve `metadata.delegation.agent.paPayment.selection`; retries reuse the exact UUID and input. If a selection already exists, use it rather than selecting again. This observation and selection grant no new payment authority.

If provider facts have expired before a route is selected, use `reconcile --task-id <id> --request-id <stable-UUID>` (the existing EIGOS readback endpoint) or MCP `reconcile_task`, then poll the original task. This refreshes source facts without pretending that a payment was attempted. Do not replace the booking or submit a false payment notification merely to refresh it.

For `selection.route == "link_agent_wallet"`, use the PA's own compatible wallet directly with the provider. For `link_checkout`, show the user the exact source-provided `request.terms.checkout.url` and ask them to confirm in the merchant page; do not request their card details or claim that opening the URL completed payment. A real ordinary Link checkout is a user-confirmed flow. Do not guess payment URLs, open another booking, or execute credentials against a different recipient.

Before any authorized payment, re-read the task: it must still be waiting, its status must be `awaiting_pa` or `awaiting_user`, the route must match the saved selection, and the terms must not have expired. Verify the endpoint, payee and exact amount. Persist the handoff ID, `selection.operationId` and the wallet's original operation identity before dispatch. An issued route may already be in use. A timeout, payment decline, duplicate handoff or `awaiting_provider` state means query the original payment, never automatically switch routes or pay again.

After the wallet attempt or the user's checkout response, save only `{"handoffId":"<request.id>","handoffDigest":"<request.digest>","outcome":"submitted"}` and run `payment-result --task-id <id> --input-file <file> --request-id <stable-UUID>`. Outcomes are `submitted`, `declined`, `unknown`, or `canceled`; none proves success. Do not send wallet keys, tokens, card data or a free-text “paid” reply. The client sends a structured A2A continuation with `action: "report_payment_result"`; MCP callers can use `report_payment_result` with the same fields plus `taskId` and `requestId`. Browser redirects, page success messages and URL parameters are not payment evidence.

Reuse the identical notification UUID and payload on a network retry. If an independent readback is already running, query the task and retry the same notification later. EIGOS must separately read the provider's payment and booking before completion. A lost notification can be followed by an `unknown` notification or `reconcile_task`; neither initiates another payment. Cancellation withdraws the EIGOS handoff but does not reverse an already dispatched PA payment. Report a late outcome for audit; a canceled task must stay canceled.

## Verify delivery

Report completion only when the same task is completed, its independent acceptance is true, and the requested artifact is present. A document delivery proves that document was produced; a task brief does not prove its underlying business goal occurred. Discovery, a model proposal, an authorization notice or a payment notice is not fulfillment.

When checking both protocols, retrieve the same taskId through native MCP and A2A, compare the actual artifact content, status and acceptance, and retain both receipts. Distinguish this live PA check from fixed probes or synthetic internal tests.

For a newly authorized request, `run --text-file <goal> --request-id <stable-id> --save-dir <private-directory>` combines discovery, one submission, polling and saving raw receipts in one client invocation. It outputs compact delivery text for the PA to relay; complete structured artifacts remain saved. It polls for up to 55 seconds (default interval 0.25 seconds); the separate poll command retains its 45-second limit. `run --spec-file <private-JSON>` can supply saved profile, textFile, requestId, saveDir and optional seconds/interval without credential values or a business plan. When `resumeRequired=true`, repeat the identical command and directory: it reads the saved task, never submits a replacement. An uncertain send stops for inspection of the original request identity. Input-required, authorization-required and failed states stop without responding, approving, paying or retrying. Use the explicit continuation flow for any user input or authority. The run also saves phase timing and the actual received UTC before final readback and artifact processing.

`get --task-id <id>` retrieves a snapshot. `cancel --task-id <id>` requires the user's intent to cancel; cancellation is not proof that any external order was reversed. Completed/failed/rejected/canceled tasks do not restart; a later request needs a new task.

## Persistent connection

Setup is performed once with `configure --card-url <url> --token-file <private-file>` (or `--token-env <secret-variable-name>`). Explicit `--allow-loopback-http` is for authorized local development only. The profile stores a credential reference, not a token. Production needs HTTPS and a separately managed authentication/refresh flow; this client does not implement OAuth sign-in or token refresh. Never print, upload or place the token in a prompt. Do not alter the server, source code, credentials or delegation allowlist while fulfilling a task.

The client's `submit` with structured `service` fields and the authorization endpoint are EIGOS application conventions, not universal A2A methods. The current EIGOS server always returns Tasks; this client is not a general client for every A2A agent. Its same-origin and no-redirect rules are local connection policies.
