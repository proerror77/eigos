## Encrypted Relay when selected

Use Relay when the user explicitly requests it and the saved PA profile contains a reviewed `relay` connection. Keep the native MCP default for other requests. The profile pins the Relay origin, private node-file reference, primary `authorityId` and full Gateway public-key ID. The existing saved client verifies these pins before binding or sending; do not create or change them while fulfilling a business task.

```text
node <saved-client> --profile <saved-profile> relay-enroll
node <saved-client> --profile <saved-profile> relay-bind
node <saved-client> --profile <saved-profile> relay --input <request.json> --output <receipt.json>
```

Enrollment requires the user's authorization to connect this node and uses the already authenticated member installation. It grants communication only. The host handles the short enrollment assertion internally; do not retrieve credentials, private keys or bearer values. A `relay-renew` command requires an input file containing a fixed UUID `requestId`; reuse that file on an uncertain renewal.

Save a Relay request with a UUID `requestId` and `kind`: `task.submit` carries the original `submit_task` input in `input`; `task.get` and `task.cancel` carry `taskId`; `task.reply` carries the current versioned reply in `input`. Follow the same address, authority and completion rules above. Use a fresh request ID for each read or continuation. On an uncertain submit, preserve the exact saved request and business request ID; retrying it can use a new transport message while the primary retains the same task. Never replace its goal or infer completion from `transportReceipt.status=received`.

The client returns the primary authority ID, business request ID, transport message ID and the protected `task` view. Re-read that task until `state=completed`, `accepted=true` and the actual artifact is available. Compare the same task ID through native MCP or A2A for independent protocol readback. Relay does not expose order or payment approval commands; permission denial is not a reason to switch identities or use an owner-wide API.
