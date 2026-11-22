#!/usr/bin/env bash
set -euo pipefail
umask 077

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
[[ $(id -u) == 0 ]]
base=/Users/proerror/.local/share/eigos/primary
config=/etc/eigos-agentgateway/config.yaml
binary=/opt/eigos-agentgateway/v1.7.0/agentgateway
unit=eigos-origin-handoff.service
code=/opt/eigos-agentgateway/origin-handoff.mjs
unit_file=/etc/systemd/system/$unit
socket=/run/eigos-origin-handoff/control.sock

exec 9<>"$base/deployment.lock"
flock -n 9
[[ ! -e $unit_file && ! -e $code ]]
[[ $(grep -Fxc '      - host: 127.0.0.1:3212' "$config") == 1 ]]
[[ -z $(ss -H -ltn 'sport = :13213') ]]
systemctl is-active --quiet eigos-agentgateway.service
health() {
  curl -fsS --noproxy '*' --max-time 2 -H 'Host: eigos.mandonothing.com' "http://127.0.0.1:$1/health" |
    jq -er 'select(.status == "ok") | .sourceCommit'
}
forwarded() {
  curl -fsS --noproxy '*' --max-time 2 --unix-socket "$socket" http://localhost/status | jq -er '.forwarded'
}
sha=$(health 3212)
[[ $(health 13212) == "$sha" ]]
invocation=$(systemctl show eigos-agentgateway.service -p InvocationID --value)

backup=$(mktemp -d "$base/rollback-agentgateway-handoff.XXXXXX")
cp -p "$config" "$backup/config.yaml"
printf 'Gateway route backup at %s\n' "$backup/config.yaml"
candidate=$(mktemp "${config}.candidate.XXXXXX")
switched=0
replace_config() {
  chmod --reference="$config" "$candidate"
  chown --reference="$config" "$candidate"
  mv -f -- "$candidate" "$config"
}
# shellcheck disable=SC2329 # Invoked by the EXIT trap.
finish() {
  local rc=$?
  if (( rc != 0 && switched )); then
    candidate=$(mktemp "${config}.recovery.XXXXXX")
    cp "$backup/config.yaml" "$candidate"
    replace_config
    echo 'Restored original gateway route. The handoff remains available while agentgateway reloads.' >&2
  fi
  if [[ -f $candidate ]]; then unlink "$candidate"; fi
  exit "$rc"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

sed 's/      - host: 127\.0\.0\.1:3212$/      - host: 127.0.0.1:13213/' "$config" > "$candidate"
"$binary" --validate-only -f "$candidate"
install -m 0644 origin-handoff.mjs "$code"
install -m 0644 "$unit" "$unit_file"
systemd-analyze verify "$unit_file"
systemctl daemon-reload
systemctl enable --now "$unit"
for _ in {1..20}; do
  if [[ $(health 13213 2>/dev/null) == "$sha" ]]; then break; fi
  sleep 0.25
done
[[ $(health 13213) == "$sha" ]]
switched=1
replace_config
for _ in {1..20}; do
  before=$(forwarded)
  if [[ $(health 13212 2>/dev/null) == "$sha" ]] && (( $(forwarded) > before )); then
    [[ $(systemctl show eigos-agentgateway.service -p InvocationID --value) == "$invocation" ]]
    echo 'The production listener is forwarding through the handoff.'
    exit 0
  fi
  sleep 0.5
done
exit 1
