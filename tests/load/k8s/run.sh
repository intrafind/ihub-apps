#!/usr/bin/env bash
# SPDX-FileCopyrightText: IntraFind Software AG
# SPDX-License-Identifier: LicenseRef-iHub-Apps

# One load-test run in the cluster, runners inside it (indexed Job → iHub Service):
#   1. optional: restore a prepared contents/ snapshot and give iHub a new CPU/RAM budget
#   2. start run-job.yaml with SHARDS pods and this run's LT_* settings
#   3. wait, copy the shard files out and write the report (collect.sh)
#
#   LT_RUN_ID=c-1500-w6 LT_PROFILE=company LT_STAGES=1500:180:420 \
#   IHUB_CPU=7 IHUB_MEMORY=8Gi IHUB_WORKERS=6 SEED_SNAPSHOT=prepared.tgz \
#   tests/load/k8s/run.sh
#
# Settings (environment):
#   LT_RUN_ID            required; a new one per run (results/<runId>)
#   LT_*                 every LT_* variable set here overrides loadtest.env for this run
#                        (ConfigMap loadtest-run-overrides), e.g. LT_PROFILE, LT_STAGES,
#                        LT_TARGET_CONCURRENT_USERS, LT_STOP_ON_FAILURE, LT_POST_STREAM
#   SHARDS               runner pods (default 4); sets LT_SHARD_COUNT
#   NS, KUBECTL          namespace (ihub-loadtest), kubectl command ("kubectl --context k3s01")
#   RUNNER_IMAGE         runner image (default: the one in run-job.yaml)
#   IHUB_DEPLOYMENT      iHub under test (default ihub, see ihub-under-test.yaml)
#   IHUB_CPU, IHUB_MEMORY  set requests = limits of iHub (restarts it)
#   IHUB_WORKERS, IHUB_NODE_OPTIONS  set WORKERS / NODE_OPTIONS of iHub (restarts it)
#   SEED_SNAPSHOT        file in the seed pod's /seed (seed.yaml) to restore into contents/
#                        before the run; SEED_OWNER (default 100:101 = the image's ihub user)
#   SETTLE_SEC           wait after an iHub restart (default 30)
#   COLLECT_TIMEOUT_MIN  how long collect.sh waits for the runs (default 120)
set -euo pipefail
: "${LT_RUN_ID:?set LT_RUN_ID (a new one per run)}"
NS="${NS:-ihub-loadtest}"
SHARDS="${SHARDS:-4}"
DEPLOY="${IHUB_DEPLOYMENT:-ihub}"
read -r -a KUBECTL_CMD <<<"${KUBECTL:-kubectl}"
K=("${KUBECTL_CMD[@]}" -n "$NS")
HERE="$(cd "$(dirname "$0")" && pwd)"
export LT_SHARD_COUNT="$SHARDS"

"${K[@]}" delete job loadtest-run --ignore-not-found --wait=true >/dev/null

# --- 1. iHub: snapshot and budget (only what is asked for) --------------------
if [ -n "${SEED_SNAPSHOT:-}" ]; then
  echo "restoring $SEED_SNAPSHOT into contents/" >&2
  "${K[@]}" scale "deploy/$DEPLOY" --replicas=0 >/dev/null
  "${K[@]}" wait --for=delete pod -l "app=$DEPLOY" --timeout=180s >/dev/null 2>&1 || true
  "${K[@]}" exec seed -- sh -c "cd /contents && find . -mindepth 1 -maxdepth 1 -exec rm -rf {} + \
    && tar xzf '/seed/$SEED_SNAPSHOT' -C /contents && chown -R ${SEED_OWNER:-100:101} /contents"
  "${K[@]}" scale "deploy/$DEPLOY" --replicas=1 >/dev/null
fi
if [ -n "${IHUB_CPU:-}${IHUB_MEMORY:-}" ]; then
  res=()
  [ -n "${IHUB_CPU:-}" ] && res+=("cpu=$IHUB_CPU")
  [ -n "${IHUB_MEMORY:-}" ] && res+=("memory=$IHUB_MEMORY")
  list=$(IFS=,; echo "${res[*]}")
  "${K[@]}" set resources "deploy/$DEPLOY" -c ihub --requests="$list" --limits="$list" >/dev/null
  # The report's sizing needs the budget the server ran with.
  [ -n "${IHUB_CPU:-}" ] && export LT_SERVER_VCPUS="${LT_SERVER_VCPUS:-$IHUB_CPU}"
fi
envs=()
[ -n "${IHUB_WORKERS:-}" ] && envs+=("WORKERS=$IHUB_WORKERS") && export LT_SERVER_WORKERS="${LT_SERVER_WORKERS:-$IHUB_WORKERS}"
[ -n "${IHUB_NODE_OPTIONS+x}" ] && envs+=("NODE_OPTIONS=$IHUB_NODE_OPTIONS")
[ ${#envs[@]} -gt 0 ] && "${K[@]}" set env "deploy/$DEPLOY" -c ihub "${envs[@]}" >/dev/null
if [ -n "${SEED_SNAPSHOT:-}${IHUB_CPU:-}${IHUB_MEMORY:-}" ] || [ ${#envs[@]} -gt 0 ]; then
  "${K[@]}" rollout status "deploy/$DEPLOY" --timeout=300s >/dev/null
  sleep "${SETTLE_SEC:-30}"
fi

# --- 2. the run ----------------------------------------------------------------
overrides="$(mktemp)"
trap 'rm -f "$overrides"' EXIT
env | grep '^LT_' >"$overrides"
"${K[@]}" create configmap loadtest-run-overrides --from-env-file="$overrides" \
  --dry-run=client -o yaml | "${K[@]}" apply -f - >/dev/null
edits=(-e "s/^(  (completions|parallelism)): [0-9]+/\1: $SHARDS/")
[ -n "${RUNNER_IMAGE:-}" ] && edits+=(-e "s|^( +image: ).*|\1$RUNNER_IMAGE|")
sed -E "${edits[@]}" "$HERE/run-job.yaml" | "${K[@]}" apply -f - >/dev/null
echo "run $LT_RUN_ID: $SHARDS shards started; follow with" >&2
echo "  ${KUBECTL:-kubectl} -n $NS logs -f -l job-name=loadtest-run --max-log-requests $SHARDS | grep -v '##LT-RESULT##'" >&2
# A pod that is not ready in time is reported by collect.sh; do not stop here.
"${K[@]}" wait --for=condition=Ready pod -l job-name=loadtest-run --timeout=300s >/dev/null || true

# --- 3. collect ----------------------------------------------------------------
KUBECTL="${KUBECTL:-kubectl}" "$HERE/collect.sh" "$NS" loadtest-run >/dev/null
echo "report: tests/load/results/$LT_RUN_ID/report.md" >&2
pod=$("${K[@]}" get pod -l "app=$DEPLOY" -o name | head -1)
if [ -n "$pod" ]; then
  peak=$("${K[@]}" exec "${pod#pod/}" -- cat /sys/fs/cgroup/memory.peak 2>/dev/null || true)
  restarts=$("${K[@]}" get "$pod" -o jsonpath='{.status.containerStatuses[0].restartCount}')
  echo "iHub: memory peak $((${peak:-0} / 1048576)) MiB, restarts $restarts" >&2
fi
# The runner pods sleep for an hour after the run; free their CPU now.
"${K[@]}" delete job loadtest-run --wait=false >/dev/null
