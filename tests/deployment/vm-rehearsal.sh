#!/usr/bin/env bash
# Disposable Ubuntu GitHub-hosted runner and its own PostgreSQL 17 service.
set -euo pipefail
[[ ${RUNNER_ENVIRONMENT:-} == github-hosted && ${RUNNER_OS:-} == Linux && ${POSTGRES_CONTAINER:-} =~ ^[0-9a-f]{12,64}$ ]]
[[ ! -e /etc/eigos && ! -e /opt/eigos && ! -e /var/lib/eigos ]]
archive=$(realpath "$1")
candidate=$(sha256sum "$archive" | cut -d' ' -f1)
cd "$(dirname "$archive")"
sha256sum --check "$(basename "$archive").sha256"
cd "$GITHUB_WORKSPACE"
work=$(mktemp -d)
units=(eigos@gateway eigos@worker eigos@indexer)
on_failure() { sudo journalctl --no-pager -n 35 -u eigos@gateway -u eigos@worker -u eigos@indexer >&2; }
trap on_failure ERR

# Build a distinct prior publication using the same native binaries. Only B is a release candidate.
jq '.version="vm-rehearsal-baseline"' dist/vm/solution/ontology.json >"$work/baseline.json"
EIGOS_KERNEL_BIN="$PWD/dist/vm/engine/bin/kernel" EIGOS_FUNCTION_HOST_BIN="$PWD/dist/vm/engine/bin/function-host" \
  node scripts/package-vm.mjs "$work/baseline" "$work/baseline.json" >/dev/null
tar -C "$work/baseline" -czf "$work/baseline.tgz" .
baseline=$(sha256sum "$work/baseline.tgz" | cut -d' ' -f1)
[[ $candidate != "$baseline" ]]
sudo useradd --system --user-group --no-create-home eigos
sudo install -d -m 0700 /etc/eigos /var/lib/vm-rehearsal-backup
sudo install dist/engine/deployment/eigos-rollout /usr/local/sbin/eigos-rollout
sudo install -m 0644 dist/vm/eigos@.service /etc/systemd/system/eigos@.service
if [[ $(realpath /usr/bin/node 2>/dev/null || true) != "$(realpath "$(command -v node)")" ]]; then
  sudo ln -sfn "$(command -v node)" /usr/bin/node
fi
sudo systemctl daemon-reload
printf '%s\n' rehearsal | sudo tee /etc/eigos/deployment-target >/dev/null
printf '%s\n' "$POSTGRES_CONTAINER" | sudo tee /etc/eigos/pg-container >/dev/null
docker exec -i "$POSTGRES_CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres <<'SQL'
CREATE DATABASE vm_rehearsal;
CREATE ROLE rehearsal_app LOGIN PASSWORD 'synthetic-only';
CREATE ROLE rehearsal_reader LOGIN BYPASSRLS PASSWORD 'synthetic-only';
REVOKE CONNECT ON DATABASE vm_rehearsal FROM PUBLIC;
GRANT CONNECT ON DATABASE vm_rehearsal TO rehearsal_app,rehearsal_reader;
SQL
umask 077
cat >"$work/common.env" <<ENV
EIGOS_MODEL_MODE=actions-only
EIGOS_INSTALLATION_ID=$(cat /proc/sys/kernel/random/uuid)
EIGOS_RUNTIME_ROLE=rehearsal_app
EIGOS_KERNEL_ROLE=rehearsal_reader
EIGOS_KERNEL_DATABASE_URL=postgres://rehearsal_reader:synthetic-only@127.0.0.1:5432/vm_rehearsal
EIGOS_ENFORCE_OWNER_RLS=true
EIGOS_DIDI_PA_READS_ENABLED=true
HOST=127.0.0.1
PORT=39117
PUBLIC_URL=https://127.0.0.1:39117
OAUTH_ISSUER=https://rehearsal.invalid/
OAUTH_AUDIENCE=rehearsal
OAUTH_JWKS_URL=https://rehearsal.invalid/jwks
OAUTH_MEMBER_CLIENT_ID=portal
OAUTH_MEMBER_CLIENT_SECRET=$(openssl rand -hex 32)
OAUTH_MEMBER_MCP_CLIENT_ID=pa
OAUTH_EXISTING_CLIENT_IDS=operator
EIGOS_PORTAL_SECRET=$(openssl rand -hex 32)
EIGOS_ACCOUNT_LINK_SECRET=$(openssl rand -hex 32)
ENV
for entry in administration:postgres installation:rehearsal_app; do
  { cat "$work/common.env"; echo "DATABASE_URL=postgres://${entry#*:}:synthetic-only@127.0.0.1:5432/vm_rehearsal"; } |
    sudo tee "/etc/eigos/${entry%:*}.env" >/dev/null
done
# Loopback ingress has one test client whose task must finish before each upgrade.
cat >"$work/before-upgrade" <<'HOOK'
#!/bin/bash
set -eu
test -f /etc/eigos/pa-task-completed
HOOK
cat >"$work/backup" <<'HOOK'
#!/bin/bash
set -eu
for role in gateway worker indexer; do
  test "$(systemctl is-active eigos@"$role" || true)" = inactive
done
cd /var/lib/vm-rehearsal-backup
docker exec "$(cat /etc/eigos/pg-container)" pg_dump -U postgres -Fc --create vm_rehearsal > db.dump
tar -C /var/lib -czf state.tar.gz eigos
readlink -f /opt/eigos/current > release-path
HOOK
cat >"$work/health-check" <<'HOOK'
#!/bin/bash
set -eu
if [[ -e /etc/eigos/fail-candidate-health ]]; then exit 75; fi
release=$(jq -er .release /var/lib/eigos/installation.json)
for attempt in {1..60}; do
  if curl -fsS --max-time 2 http://127.0.0.1:39117/health 2>/dev/null | jq -e --arg r "$release" '.ontologyRelease==$r' >/dev/null; then exit 0; fi
  sleep 1
done
exit 1
HOOK
sudo install "$work"/{before-upgrade,backup,health-check} /etc/eigos/
cat >"$work/adapter" <<'ADAPTER'
#!/bin/bash
set -eu
if [[ $1 == apply ]]; then
  receipt=$(sudo env "PATH=$PATH" /usr/local/sbin/eigos-rollout apply "$2" "$3" <"$4")
  if [[ -f $VM_REHEARSAL_LOSE_REPLY ]]; then exit 76; fi
  printf '%s\n' "$receipt"
else
  sudo env "PATH=$PATH" /usr/local/sbin/eigos-rollout verify "$2" "$3"
fi
ADAPTER
chmod +x "$work/adapter"
export VM_REHEARSAL_LOSE_REPLY="$work/lost-reply"
jq -n --arg db "$work/controller.sqlite" --arg adapter "$work/adapter" \
  '{solution:"eigos",database:$db,adapter:$adapter,targets:{dev:"rehearsal",staging:"unused-stage",production:"unused-prod"}}' >"$work/config.json"
controller() { node dist/engine/deployment/deploy.mjs "$1" "$work/config.json" "${@:2}"; }
plan() { controller plan dev "$1" "$2" | jq -er .id; }
must_fail() { if "$@"; then echo "Unexpected success: $1 $2" >&2; exit 1; fi; }
old=$(plan "$work/baseline.tgz" "$baseline")
controller apply "$old" >"$work/old.json"
task=$(node tests/deployment/vm-pa.mjs seed "$work/pa.json")
sudo touch /etc/eigos/pa-task-completed

start=$SECONDS
failed=$(plan "$archive" "$candidate")
sudo touch /etc/eigos/fail-candidate-health
must_fail controller apply "$failed"
must_fail controller status dev
[[ $(sudo readlink -f /opt/eigos/current) == "/opt/eigos/releases/$candidate" ]]
sudo systemctl stop "${units[@]}"
backup=/var/lib/vm-rehearsal-backup
sudo cat "$backup/db.dump" | docker exec -i "$POSTGRES_CONTAINER" pg_restore -U postgres --exit-on-error --clean --if-exists --create -d postgres
sudo mv /var/lib/eigos /var/lib/vm-rehearsal-failed-state
sudo tar -C /var/lib -xzf "$backup/state.tar.gz"
prior=$(sudo cat "$backup/release-path")
[[ $prior == "/opt/eigos/releases/$baseline" ]]
sudo ln -sfn "$prior" /opt/eigos/current
sudo unlink /etc/eigos/fail-candidate-health
sudo systemctl start "${units[@]}"
controller recover "$failed" >"$work/restored.json"
diff -u "$work/old.json" "$work/restored.json"
[[ $(node tests/deployment/vm-pa.mjs read "$work/pa.json") == "$task" ]]
restore_seconds=$((SECONDS - start))

start=$SECONDS
retry=$(plan "$archive" "$candidate")
touch "$VM_REHEARSAL_LOSE_REPLY"
must_fail controller apply "$retry"
must_fail controller status dev
controller verify "$retry" >"$work/candidate.json"
controller status dev >"$work/live.json"
diff -u "$work/candidate.json" "$work/live.json"
[[ $(node tests/deployment/vm-pa.mjs read "$work/pa.json") == "$task" ]]
controller events "$failed" | jq -e 'map(.state)==["planned","applying","uncertain","verifying","recovered"]'
controller events "$retry" | jq -e 'map(.state)==["planned","applying","uncertain","verifying","verified"]'
jq -en --slurpfile a "$work/old.json" --slurpfile b "$work/candidate.json" \
  --arg digest "$candidate" --arg source "$(git rev-parse HEAD)" --arg task "$task" \
  --argjson recoverySeconds "$restore_seconds" --argjson upgradeSeconds "$((SECONDS - start))" '
  $a[0].installation as $old | $b[0].installation as $new |
  select($b[0].digest==$digest and $old.storage==$new.storage and $old.instance==$new.instance
    and $old.release!=$new.release and $new.source==$source) |
  {source:$source,archiveSha256:$digest,baselineSha256:$a[0].digest,baselineRelease:$old.release,
   candidateRelease:$new.release,originalTask:$task,recoverySeconds:$recoverySeconds,
   upgradeSeconds:$upgradeSeconds,restored:true,reconciled:true}' >"$RUNNER_TEMP/vm-rehearsal.json"
cat "$RUNNER_TEMP/vm-rehearsal.json"
