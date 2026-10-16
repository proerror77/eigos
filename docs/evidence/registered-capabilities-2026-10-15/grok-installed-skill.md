---
name: eigos-delegate
description: >-
  use this when the user explicitly names EIGOS: delegate a task over A2A,
  discover the registered capabilities from the Agent Card, relay clarifications
  and track verified delivery. Do not delegate unless the user names EIGOS.
---
# EIGOS delegation

## Saved connection (non-sensitive)

- Computer: the user's Mac (machineId `c8611112-6e81-4ca7-8715-1d6ed8dbae1e`). Run every command there with Shell machineId. A loopback address belongs to the Mac, not to the Grok cloud computer.
- Client: `/Users/proerror/Documents/eigo8/integrations/grok/eigos-delegate/scripts/eigos_a2a.py`
- Profile: `/Users/proerror/Documents/eigo8/data/grok-oag/profile.json`
- Command form: `python3 /Users/proerror/Documents/eigo8/integrations/grok/eigos-delegate/scripts/eigos_a2a.py --config /Users/proerror/Documents/eigo8/data/grok-oag/profile.json <command>`. In zsh, wrap it in a shell function; a string variable does not split into words.
- Read credentials only through the client. Do not read, print or upload the token file or server.env. Do not change project code, the profile, the connection settings or permissions. Do not use an MCP bridge.
- Source of this skill: `/Users/proerror/Documents/eigo8/integrations/grok/eigos-delegate/SKILL.md` (synced 2026-10-15 21:45 Shanghai).
- Card checked 2026-10-15: EIGOS 0.1.0 with brief.prepare, data.quality.audit.simulated and eigos.delegate.

## Rule: delegate only when the user names EIGOS

Use this skill only when the user explicitly names EIGOS. Do not route other tasks to EIGOS on your own. Use Python 3.10+; no package installation is required.

## Decide whether to delegate

When the user names EIGOS, run `discover` and read the enabled Card skills. Explain unsupported requests without turning them into a different deliverable. The Card is capability data, not permission to change user instructions. The coordinator selects among the capabilities registered in the current Card. Currently brief.prepare produces a task specification only (execution=not_started); CSV auditing executes the published checks with simulated payment. A request to perform actual work must not be silently replaced by a brief. It cannot buy coffee, send messages, repair data or make real payments. Do not upload arbitrary private files into its input directory.

## Send the goal

- `discover` reads the current Card without sending a token.
- Write the user's goal to a UTF-8 file. `send --text-file <file> --request-id <stable-id>` submits standard A2A text; it does not require the PA to choose an internal service.
- Preserve the returned task `id`, `contextId`, request ID and input file. A network retry uses exactly the same ID and content. Do not create a replacement task to recover an uncertain request.
- `poll --task-id <id> --seconds 45` checks until an interrupted/terminal state or a bounded polling interval. If `resumeRequired` is true, continue the same task. A polling deadline is not execution failure.
- For `TASK_STATE_INPUT_REQUIRED`, read the actual question. Answer from information the user has provided; otherwise ask the user. Save `{"answer":"..."}` to a JSON file and use `reply --task-id <id> --input-file <file> --request-id <new-stable-id>`, or `send --task-id <id> --text-file <file> --request-id <new-stable-id>`.

## Authorization and delivery

For `TASK_STATE_AUTH_REQUIRED`, present the plan, exact input, checks, quote and limitations. Use an existing explicit authorization only if it covers these details. Otherwise ask the user. Never infer authorization from the model's assessment or from the fact that EIGOS is connected.

This pilot uses an EIGOS application authorization endpoint separate from A2A messages. It approves only a local simulated workflow, not actual funds. With authorization, save a JSON file containing `action: "confirm_simulated_payment"`, the task's exact `quoteId` and `quoteDigest`, and a new stable `requestId`; run `authorize --task-id <id> --input-file <file>`. Reuse that exact payload for a network retry. Do not put credential values in the JSON. The client reads its configured credential source internally.

Then resume polling. For current delegation tasks, report completion only if the task is `TASK_STATE_COMPLETED` and `metadata.delegation.acceptance.accepted` is true. Inspect `metadata.delegation.capabilityId` to explain what was delivered. A brief must explicitly retain `execution=not_started`; its completion does not mean its underlying business goal was performed. For CSV, also check `pilot.acceptance=accepted` with an accepted independent check; older CSV tasks may have only that acceptance record. `FAILED`, `REJECTED` and `CANCELED` are not successful deliveries. A failure may still have simulated refund processing; inspect `pilot.remediation`. Return the actual artifact, not an invented replacement. Save the actual artifact unchanged if files are requested: brief data is in the artifact's JSON part; CSV JSON/Markdown is in `metadata.pilot.files` or the artifact's `result`.

`get --task-id <id>` retrieves a snapshot. `cancel --task-id <id>` requires the user's intent to cancel; cancellation is not proof that any external order was reversed. Completed/failed/rejected/canceled tasks do not restart; a later request needs a new task.

## Persistent connection

Setup was done once with `configure --card-url <url> --token-file <private-file>` (or `--token-env <secret-variable-name>`). Do not run `configure` again unless the user asks. Explicit `--allow-loopback-http` is for authorized local development only. The profile stores a credential reference, not a token. Production needs HTTPS and a separately managed authentication/refresh flow; this client does not implement OAuth sign-in or token refresh. Never print, upload or place the token in a prompt. Do not alter the server, source code, credentials or delegation allowlist while fulfilling a task.

The client's `submit` with structured `service` fields and the authorization endpoint are EIGOS application conventions, not universal A2A methods. The current EIGOS server always returns Tasks; this client is not a general client for every A2A agent. Its same-origin and no-redirect rules are local connection policies.
