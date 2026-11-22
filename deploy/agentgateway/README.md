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
