#!/usr/bin/env bash
set -euo pipefail

# The release hook owns publication, unit changes and guarded recovery. The
# ingress processes are kept running while the hook changes the application.
[[ $# -ge 4 && $1 =~ ^[0-9a-f]{40}$ && $2 =~ ^[0-9a-f]{40}$ && $1 != "$2" && $3 == -- ]]
old=$1
target=$2
shift 3
base=/Users/proerror/.local/share/eigos/primary
socket=/run/eigos-origin-handoff/control.sock
connector=com.eigos.primary.frontend.service

control() { curl -fsS --noproxy "*" --max-time 2 --unix-socket "$socket" "$@"; }
health() {
  curl -fsS --noproxy '*' --max-time 2 -H 'Host: eigos.mandonothing.com' "http://127.0.0.1:$1/health" |
    jq -er 'select(.status == "ok") | .sourceCommit'
}
connector_id() {
  runuser -u eigos-primary -- env XDG_RUNTIME_DIR=/run/user/501 systemctl --user show "$connector" -p InvocationID --value
}
proxy_id() { systemctl show eigos-agentgateway.service -p InvocationID --value; }

exec 9<>"$base/deployment.lock"
flock -n 9
systemctl is-active --quiet eigos-agentgateway.service
systemctl is-active --quiet eigos-origin-handoff.service
before=$(control http://localhost/status)
jq -e '.holding == false' <<<"$before" >/dev/null
# Confirm the running ingress forwards through the handoff before pausing it.
grep -Fxq '      - host: 127.0.0.1:13213' /etc/eigos-agentgateway/config.yaml
[[ $(health 3212) == "$old" && $(health 13212) == "$old" ]]
after=$(control http://localhost/status)
jq -e --argjson before "$before" '.forwarded > $before.forwarded' <<<"$after" >/dev/null
connector_before=$(connector_id)
proxy_before=$(proxy_id)
[[ $connector_before =~ ^[0-9a-f]{32}$ && $proxy_before =~ ^[0-9a-f]{32}$ ]]

recover_ingress() {
  local rc=$? live
  trap - EXIT
  if (( rc != 0 )); then
    live=$(health 3212 || true)
    if [[ $live == "$old" ]]; then
      control -X POST http://localhost/serve >/dev/null ||
        echo "If the handoff is still holding, resume it after checking origin health." >&2
    else
      echo 'The old origin was not restored. Run the guarded application recovery, then resume the handoff.' >&2
    fi
  fi
  exit "$rc"
}
trap recover_ingress EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
control -X POST http://localhost/hold >/dev/null
deadline=$((SECONDS + 8))
while ! control http://localhost/status | jq -e '.holding and .inflight == 0' >/dev/null; do
  (( SECONDS < deadline )) || { echo 'Origin did not drain. The release hook was not run.' >&2; exit 1; }
  sleep 0.1
done

# Pass the held deployment lock to the child by inheritance. The hook must
# leave the rollback origin healthy before returning a failure.
"$@"
[[ $(health 3212) == "$target" ]]
control -X POST http://localhost/serve >/dev/null
trap - EXIT INT TERM

[[ $(health 13212) == "$target" && $(connector_id) == "$connector_before" && $(proxy_id) == "$proxy_before" ]]
control http://localhost/status |
  jq -e --argjson before "$before" 'select(.expired == $before.expired and .overflow == $before.overflow)'
