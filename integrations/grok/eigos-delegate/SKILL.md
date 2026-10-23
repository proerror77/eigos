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

## Verify delivery

Report completion only when the same task is completed, its independent acceptance is true, and the requested artifact is present. A document delivery proves that document was produced; a task brief does not prove its underlying business goal occurred. Discovery, a model proposal, an authorization notice or a payment notice is not fulfillment.

When checking both protocols, retrieve the same taskId through native MCP and A2A, compare the actual artifact content, status and acceptance, and retain both receipts. Distinguish this live PA check from fixed probes or synthetic internal tests.

Business actions require their own exact authorization and available source bindings. This connection grants no real purchase, payment, external order cancellation or outbound-contact authority. Preserve all current service limitations.
