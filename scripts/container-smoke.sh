#!/usr/bin/env bash
# Checks built EIGOS images without settings, network or registry access.
# Usage: scripts/container-smoke.sh <runtime image> <worker image>
set -euo pipefail
runtime=$1 worker=$2

docker run --rm --network none --entrypoint node "$runtime" \
  -e 'if (process.getuid() === 0) throw new Error("The image must run as a nonroot user")'
test "$(docker image inspect "$worker" --format '{{json .Config.Cmd}}')" = '["node","dist/apps/worker/main.js"]'

for entry in gateway worker indexer; do
  # Static imports load before an entry point reads its settings, so a missing package fails first.
  if output=$(docker run --rm --network none "$runtime" node "dist/apps/$entry/main.js" 2>&1); then
    echo "$entry started without settings" >&2
    exit 1
  fi
  if [[ "$output" == *ERR_MODULE_NOT_FOUND* || "$output" != *DATABASE_URL* ]]; then
    echo "$output" >&2
    echo "$entry did not reach its settings check" >&2
    exit 1
  fi
done
echo 'Every entry point loads as a nonroot user'
