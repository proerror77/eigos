#!/usr/bin/env bash
set -euo pipefail
umask 077
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

host=eigos.mandonothing.com
direct=http://127.0.0.1:3212
candidate=http://127.0.0.1:13212
public=https://$host

probe() {
  local base=$1 path=$2 prefix=$3
  shift 3
  curl --silent --show-error --max-time 10 --noproxy '*' \
    --header "Host: $host" --dump-header "$scratch/$prefix.headers" \
    --output "$scratch/$prefix.body" --write-out '%{http_code}' "$@" "$base$path"
}

compare() {
  local path=$1 status=$2
  shift 2
  [[ $(probe "$direct" "$path" direct "$@") == "$status" ]]
  [[ $(probe "$candidate" "$path" candidate "$@") == "$status" ]]
  cmp "$scratch/direct.body" "$scratch/candidate.body"
  diff -u <(sed 's/\r$//' "$scratch/direct.headers" | grep -Ei '^(www-authenticate|allow|location|content-type|cache-control):' | sort -f) \
    <(sed 's/\r$//' "$scratch/candidate.headers" | grep -Ei '^(www-authenticate|allow|location|content-type|cache-control):' | sort -f)
  printf '%s %s parity\n' "$status" "$path"
}

compare /health 200
jq -e '.status == "ok"' "$scratch/candidate.body" >/dev/null
compare /.well-known/agent-card.json 200
compare /.well-known/oauth-protected-resource 200
compare /.well-known/oauth-protected-resource/mcp 200
compare / 302
compare /identity 401
compare /ontology 401
compare /mcp 401 --request POST --header 'Content-Type: application/json' \
  --header 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"migration-check","version":"1"}}}'
compare /mcp 401 --header 'Authorization: Bearer synthetic-invalid-token'
compare /a2a 401 --request POST --header 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"GetTask","params":{"id":"migration-check"}}'
compare /health 403 --header 'Origin: https://invalid.example'

unknown_host=$(curl --silent --show-error --max-time 5 --output /dev/null \
  --write-out '%{http_code}' --header 'Host: invalid.example' "$candidate/health")
[[ $unknown_host == 404 ]]
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:15121/healthz/ready
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:15120/metrics > "$scratch/metrics"
grep -q '^# ' "$scratch/metrics"
[[ $(probe "$public" /health public) == 200 ]]
[[ $(probe "$candidate" /health candidate) == 200 ]]
cmp "$scratch/public.body" "$scratch/candidate.body"
printf 'Unexpected Host rejected, readiness and metrics reachable, public health matches\n'
