#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
[[ $(id -u) == 0 && $(uname -sm) == 'Linux x86_64' ]]
unit=eigos-agentgateway.service
release=/opt/eigos-agentgateway/v1.7.0
config=/etc/eigos-agentgateway
unit_file=/etc/systemd/system/$unit

# First installation only. Preserve any existing operator-managed instance.
for path in "$release" "$config" "$unit_file"; do
  [[ ! -e $path && ! -L $path ]] || { echo "Already exists: $path" >&2; exit 1; }
done
for port in 13212 15120 15121; do
  [[ -z $(ss -H -ltn "sport = :$port") ]] || { echo "Port in use: $port" >&2; exit 1; }
done

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  --max-time 180 --retry 2 --output "$scratch/agentgateway" \
  https://github.com/agentgateway/agentgateway/releases/download/v1.7.0/agentgateway-linux-amd64
printf '%s  %s\n' 1b2fc01a2de29ca113bbb6258b5cae7b1eb3c724071c09d687a449132f2f42f8 \
  "$scratch/agentgateway" | sha256sum --check
chmod 0755 "$scratch/agentgateway"
"$scratch/agentgateway" --validate-only -f config.yaml

install -d -m 0755 "$release" "$config"
install -m 0755 "$scratch/agentgateway" "$release/agentgateway"
install -m 0644 config.yaml "$config/config.yaml"
install -m 0644 "$unit" "$unit_file"
systemd-analyze verify "$unit_file"
systemctl daemon-reload
systemctl enable --now "$unit"
