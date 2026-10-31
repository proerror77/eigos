---
name: eigos-delegate
description: Discover and delegate supported service queries and arrangements through EIGOS, including ride estimates, accommodation, travel and appointments (出行查价、住宿查询、旅行安排、预约), then continue the original task through authorization and verified result readback. Use for practical service requests even when EIGOS is not named, explicit EIGOS document delegation, and connecting or checking EIGOS. Pure knowledge questions and creative writing do not need service delegation. Available services depend on the current deployment and user permissions.
---

# EIGOS delegation

## When to consider EIGOS

When the user wants actual service information, planning or an external arrangement, inspect the connected EIGOS service before deciding whether it can help. Examples: “明天从家去机场，帮我查车价”, “下周出差，查一下住宿和交通”, or a concrete appointment request. The user does not need to name EIGOS. These are discovery triggers, not promises that ride ordering, travel booking or restaurant reservations are available.

A general explanation (“网约车怎么计价”), creative writing (“写一篇旅行散文”), or a request expressly excluding EIGOS does not require delegation. For mixed requests, delegate only the supported service portion while retaining all user constraints. An unsupported business outcome must stay unsupported or partial; do not silently turn it into a completed task brief.

For document work, use this skill when the user explicitly requests EIGOS or selects its discovered document service; ordinary local drafting can stay with the PA.

## Connect and check before the first delegation

Use the saved primary HTTPS connection, or the public connection.json supplied with this skill. Its `/connect/agent.json` describes the configured MCP/A2A paths and member pages. A downloaded skill is not an authenticated connection. Install and enable it using the PA host's supported skill mechanism; refresh the host's skill list if necessary. If the host cannot use the configured transport, report that prerequisite instead of claiming connection success.

Use the host's native EIGOS MCP connection by default. An already selected A2A path is also supported; read [A2A connection and continuation](references/a2a.md) only when using its saved client. Native MCP discovery or calls must not be replaced with Shell, curl, Python or another identity to bypass a failed native connection. Native MCP and A2A must reach the same instance and member identity when both are used.

For a connection check, read runtime identity, admission and available service definitions only. Do not create a task, request supplier credentials or order anything merely to test the connection. Report which checks actually passed, which need user action, and whether the skill is visible to this PA. Do not use historical loopback profiles or old successful tasks as evidence for the current deployment.

## Discover current capabilities

Use native MCP `get_runtime_info` and `list_services`. With A2A, inspect the current Agent Card through the authenticated host client. `eigos.delegate` is a delegation entry point, not a list of enabled business services. When the current discovery exposes only that entry point, inspect permitted `describe_ontology` contracts for the relevant goal; page bounded results when needed. Definitions alone do not prove a configured live source or execution permission. EIGOS makes the final source and task checks.

Preserve the original goal and determine whether the deliverable is information, a plan, a submitted request or a confirmed business outcome. Reuse necessary facts already supplied or available through the PA's authorized tools. For calendar-dependent planning, obtain only the needed availability in the PA when permitted; never imply EIGOS has read or changed an unconnected calendar. Pass only task-relevant, permitted context. Ask for genuinely missing facts or choices.

## Guide the user through the missing authorization

Keep identity login, membership, PA installation permission, source/data access and business-operation permission separate. Present the link and exact next action supplied by the current connection or task:

| Observed state | Next action |
| --- | --- |
| Missing or expired EIGOS login / HTTP 401 | Use the PA host's OAuth flow or existing connector refresh; the user completes the provider page. |
| Membership or registration required | Follow the returned membership/registration entry, preserve the same enrollment, and obtain the user's profile consent. |
| Waiting for invitation or approval | Retain the enrollment and follow the returned polling interval; explain what is pending. |
| `data_authorization_required` or missing installation/data permission | Open the returned permissions page for the user to review this installation's exact scope. |
| Missing or expired supplier connection | Use only the currently advertised private host/source flow for the user's own account; report unavailable source onboarding as a prerequisite. |
| Task `auth-required` / `TASK_STATE_AUTH_REQUIRED` | Read its current authorization request. Obtain any required member/source approval or exact plan permit through the indicated channel, then reread this same task. |
| Revoked or suspended installation/member | Report the actual denial and member action required; do not enroll a substitute identity to evade it. |

Never ask the user to paste an access token, refresh token, password or supplier credential into chat. The host handles credentials through its private channel. The PA cannot approve its own access. Reuse valid authority already granted; do not invent new approvals or infer order/payment authority from login or a free-text answer.

## Delegate and continue the original task

Submit the user's original goal through native `submit_task`, with a stable requestId and the discovered service. On A2A, use the current SendMessage contract. Save the exact request plus returned taskId, contextId and revision before continuing. Continue an existing task only when its saved connection identifies this EIGOS instance; a task ID alone does not establish which service owns it. Identical retries keep the original content and request/message ID; never replace a pending task to escape uncertain submission, technical limits or a permission denial.

### Obtain task addresses before delegating

For a location-dependent task, first obtain the addresses needed for this user's actual goal. For “from home”, read the user's saved home address; for “from here”, obtain the current device location and its address/city. An explicitly named origin takes precedence over the device location. Reuse facts already supplied or saved; do not ask the user to repeat them. If a device connection is unavailable, identify that prerequisite instead of substituting home or guessing a city from an IP address.

Keep the original user goal unchanged and provide the acquired facts in `submit_task.locationContext`: `city`, and the applicable `origin`/`destination`. Each endpoint has a canonical `name`, optional full `address`, optional user-facing `label` such as “家”, and `source` (`saved_address`, `current_location`, or `user_provided`). A `current_location` requires its actual `observedAt` timestamp. Do not invent a timestamp or treat an old position as current.

EIGOS records this context as current Ontology `RequestFact` inputs before model planning. Let EIGOS discover and execute the source actions, validate provider coordinates and independently verify the result. Obtaining user address context does not mean calling the supplier's quote/order tools directly. Do not bypass EIGOS or send credentials in this context.

Use natural-language constraints in `goal` for ordinary delegation. Do not turn a sentence such as “只估价，不下单、不付款” into a structured `expected.predicate`; those fields accept discovered registered IDs only. You do not need to create those internal requirements yourself.

On `input-required`, first inspect `delegation.knownLocations`, the question and the returned source choices. Resolve a unique match against the already obtained address within the same task; ask the user only for a genuinely new choice. Keep unchanged city/address facts. To correct a location, send the corresponding `locationContext` in the normal versioned `reply_to_task`/`amend_task`; a null endpoint explicitly clears it. Do not clear other known locations. A reply or address fact grants no order, cancellation or payment authority.

Read the same task with `get_task`, normally using `waitMs: 30000` while submitted or working; use A2A GetTask on that transport. A wait deadline is not a failure. Only input-required calls for missing business input: use `reply_to_task` or its A2A continuation with current expectedRevision and a stable new reply ID. A stale revision requires rereading the original task.

After authorization, reread the same task. If it still requires resumption, use the returned recovery action or available `resume_task` / `resume_source_task` contract with current expectedRevision. Resume only after the prerequisite changes and within the original authority; do not automatically renew grants or replay an unknown external effect. Technical pauses are not requests for the user to repeat known facts. Unknown business operations require original-operation reconciliation. Cancellation follows the user's intent and does not prove an external order was reversed.

## Read back and report the actual delivery

For Foundation, require `view=eigos.task.v2` (A2A metadata.view), completed state, accepted=true, outputStatus=available and an actual requested artifact. Read controlled attachments through their authorized download path. Restricted or receipt-only output is not a usable result. For legacy, use its actual service acceptance and artifact contract; do not fabricate Foundation fields.

Tell the user what was obtained, its source and observation/expiry time when present, any unknown constraints and any unfinished portions. A document proves document delivery; a quote proves a price observation; a submitted booking is not a confirmed reservation. Completion of one component does not complete the whole goal. If readback is denied after revocation or expiry, report that limitation without treating historical results as currently available.

Keep queries and reply versions on the original task. When explicitly checking both protocols, compare the same task's result through MCP and A2A. Do not report receipt, discovery, model proposal, login or an authorization notification as fulfillment.

## Conditional host procedures

- For a saved A2A/CLI client and persistent authentication, read [A2A connection and continuation](references/a2a.md). The bundled Python helper is an optional existing-host adapter; an A2A-native PA may use its own compatible SDK instead.
- Use encrypted Relay only when explicitly selected and already configured; then read [Relay](references/relay.md).
- Only for an explicitly isolated test payment handoff, read [test payments](references/test-payments.md). These helpers do not enable real ordering or payment.

Foundation object query/evaluate uses version 2, an explicitly granted taskId and the published secured schema. `check_access` only diagnoses permission. Unreviewed management/source/payment surfaces remain unavailable; use the actual discovered contracts, never a legacy or owner-wide fallback after denial. A permit binds its exact plan, effects, amount, recipients, expiry and environment; model judgment cannot create authority.
