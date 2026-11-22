# EIGOS agentgateway ingress

This deployment runs standalone agentgateway on the existing Tokyo ECS origin. Cloudflare Tunnel terminates public TLS. The candidate forwards HTTP to the EIGOS application, which owns OAuth, account sessions, MCP tools, A2A tasks, PA delivery, and Ontology authorization and execution. The public origin and protocol URLs stay on `https://eigos.mandonothing.com`.

| Listener | Address |
| --- | --- |
| Candidate data plane | `127.0.0.1:13212` |
| Existing EIGOS application | `127.0.0.1:3212` |
| Prometheus metrics | `127.0.0.1:15120/metrics` |
| Proxy readiness | `127.0.0.1:15121/healthz/ready` |

The service runs under systemd with a dynamic user, loopback network access, and immutable configuration. Metrics are local. The admin API and per-request access logging are disabled. The proxy uses the pinned [v1.7.0 release](https://github.com/agentgateway/agentgateway/releases/tag/v1.7.0) and the [standalone HTTP routing configuration](https://agentgateway.dev/docs/standalone/latest/documentation/configuration/routes/).

## Install and verify

Copy this directory to a private staging directory on the origin. Run `sudo bash install.sh` once. Then run `bash verify.sh` on the origin. It compares the candidate to the application for response bodies, status codes, OAuth challenges, redirects, and content headers. It also checks the Origin and Host restrictions, readiness, metrics, and public health. Check that the three agentgateway sockets bind to loopback with `ss -ltn`.

The script exercises public reads and authentication rejection. Before switching traffic, also verify an authorized MCP initialize and tool listing, an A2A read using a known task or a synthetic task, and the account login flow, including the callback. Confirm that the effective client address and HTTPS scheme used by the existing account and rate-limit middleware are preserved when Cloudflare forwards through the candidate. Check a denied identity alongside the authorized cases.

## Route production traffic

1. Read the current Cloudflare Tunnel configuration and active connectors. Save the complete ingress configuration privately as the rollback input. Verify that every active connector can reach the candidate at the same loopback address.
2. Change the service URI for `eigos.mandonothing.com` from `http://127.0.0.1:3212` to `http://127.0.0.1:13212`, preserving the remaining rules and origin settings.
3. Read back the tunnel configuration. Repeat the public health, OAuth discovery, authentication, MCP, A2A, and account checks. Compare the agentgateway request counter before and after an uncached public request to confirm that the public origin reaches the candidate. Monitor readiness and HTTP error rates.
4. On a regression, restore the saved Cloudflare configuration and verify public health and protocol responses before stopping the candidate. To stop the candidate after rollback, run `sudo systemctl disable --now eigos-agentgateway.service`.

The candidate and rollback both use the same EIGOS application and database. These operations require no PostgreSQL schema migration or credential transfer.

## Release the EIGOS application without closing the Tunnel

On November 22, 2026, the application cutover stopped the sole `cloudflared` service at 16:51:50 China time. Its last connection unregistered at 16:51:51 and its first replacement connected at 16:52:23. Public health probes observed HTTP 530 during the 33-second cutover window. The [Cloudflare Tunnel troubleshooting guide](https://developers.cloudflare.com/tunnel/troubleshooting/) describes what clients see when Cloudflare has no active connector.

Keep both the Tunnel and agentgateway running. Install the origin handoff on the Tokyo host once, while the application is healthy:

1. Copy the deployment files to private staging and run `sudo bash install-handoff.sh` once. It starts the loopback handoff, checks port 3212, validates and reloads an agentgateway config pointing to port 13213, and verifies the forwarding counter and the unchanged agentgateway invocation ID. It saves the original config under the production deployment directory and restores that config on a failed route check. The control socket is available to root.
2. Verify public health and authenticated MCP and A2A reads after the route reload. The public Cloudflare origin stays on port 13212. If those checks fail, restore the saved route using agentgateway's [file configuration reload](https://agentgateway.dev/docs/standalone/latest/documentation/setup/update/).
3. Run the usual application preflight, builds, backup, and publication rehearsal with traffic flowing. The release hook handles the guarded database publication and application unit changes. Keep the existing exclusive publication and rollback checks. Move the backup and production-independent checks outside the cutover, and keep the previous release ready throughout. Remove the connector stops and starts from the release hook and its rollback path. The wrapper owns `deployment.lock`. The hook inherits that lock on file descriptor 9.
4. Run `sudo bash run-cutover.sh OLD_SHA TARGET_SHA -- bash /private/path/to/application-release-hook.sh` on the production host. The wrapper holds newly arriving HTTP requests, verifies the old origin has drained, and invokes the release hook. The hook should restore a healthy old origin before returning an error. The wrapper reopens traffic after the expected application is healthy and verifies that neither ingress service restarted and no waiting requests expired or exceeded the queue.
5. Keep authenticated MCP and A2A read probes running at regular intervals before, during and after the change. Require zero HTTP, JSON-RPC, timeout or identity errors and the same original task ID. Compare origin and public source commits after the cutover. Check `expired` and `overflow` via `curl --unix-socket /run/eigos-origin-handoff/control.sock http://localhost/status`. Confirm the guarded rollback script before the change. If the wrapper leaves the handoff held because the hook did not restore the old origin, run the guarded application rollback, verify the old application directly on port 3212, then reopen with `curl --unix-socket /run/eigos-origin-handoff/control.sock -X POST http://localhost/serve`.

The handoff accepts at most 128 waiting requests and lets each wait up to 40 seconds. Clients keep their existing request deadline. Requests in flight finish against the original origin, and queued requests are sent to the healthy origin once. A long publication or traffic burst can exceed this budget and return HTTP 503. Use the measured rehearsal duration and ingress request rate to verify capacity before scheduling the release.

Suite 40 exercises continuous authenticated MCP and A2A reads through a 33-second origin gap against EIGOS and synthetic PostgreSQL tasks. CI runs the probe through the pinned agentgateway binary. A local run can set `EIGOS_TEST_CUTOVER_AGENTGATEWAY` to the path of the v1.7.0 executable.
