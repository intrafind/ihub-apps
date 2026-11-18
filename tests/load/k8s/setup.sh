#!/usr/bin/env bash
# SPDX-FileCopyrightText: IntraFind Software AG
# SPDX-License-Identifier: LicenseRef-iHub-Apps

# Setup in the cluster (setup-job.yaml) with this call's LT_* settings, and optionally keep
# the prepared contents/ as a snapshot in the seed pod (seed.yaml) for run.sh SEED_SNAPSHOT=…
#
#   # 4,000 users on top of a smaller snapshot, kept as c4000.tgz
#   SEED_SNAPSHOT=prepared.tgz SAVE_SNAPSHOT=c4000.tgz \
#   LT_USER_COUNT=4000 LT_TARGET_CONCURRENT_USERS=4000 tests/load/k8s/setup.sh
#
#   # register a GPU model before a capacity-gpu run
#   LT_PROFILE=capacity-gpu LT_LLM_URL=https://gpu.example.com tests/load/k8s/setup.sh
#
# Settings (environment):
#   LT_*            override loadtest.env for this setup (ConfigMap loadtest-run-overrides)
#   NS, KUBECTL     namespace (ihub-loadtest), kubectl command ("kubectl --context lab")
#   RUNNER_IMAGE    runner image (default: the one in setup-job.yaml)
#   IHUB_DEPLOYMENT iHub under test (default ihub)
#   SEED_SNAPSHOT   restore this snapshot from /seed before setup; SEED_OWNER (default 100:101)
#   SAVE_SNAPSHOT   after setup: stop iHub, write contents/ to /seed/<name>, start iHub again
#   SETUP_TIMEOUT   seconds to wait for the setup job (default 3600)
set -euo pipefail
NS="${NS:-ihub-loadtest}"
DEPLOY="${IHUB_DEPLOYMENT:-ihub}"
read -r -a KUBECTL_CMD <<<"${KUBECTL:-kubectl}"
K=("${KUBECTL_CMD[@]}" -n "$NS")
HERE="$(cd "$(dirname "$0")" && pwd)"

restart_ihub() {
  "${K[@]}" scale "deploy/$DEPLOY" --replicas=1 >/dev/null
  "${K[@]}" rollout status "deploy/$DEPLOY" --timeout=300s >/dev/null
  sleep "${SETTLE_SEC:-30}"
}
stop_ihub() {
  "${K[@]}" scale "deploy/$DEPLOY" --replicas=0 >/dev/null
  "${K[@]}" wait --for=delete pod -l "app=$DEPLOY" --timeout=180s >/dev/null 2>&1 || true
}

if [ -n "${SEED_SNAPSHOT:-}" ]; then
  echo "restoring $SEED_SNAPSHOT into contents/" >&2
  stop_ihub
  "${K[@]}" exec seed -- sh -c "cd /contents && find . -mindepth 1 -maxdepth 1 -exec rm -rf {} + \
    && tar xzf '/seed/$SEED_SNAPSHOT' -C /contents && chown -R ${SEED_OWNER:-100:101} /contents"
  restart_ihub
fi

overrides="$(mktemp)"
trap 'rm -f "$overrides"' EXIT
env | grep '^LT_' >"$overrides" || true
"${K[@]}" create configmap loadtest-run-overrides --from-env-file="$overrides" \
  --dry-run=client -o yaml | "${K[@]}" apply -f - >/dev/null
"${K[@]}" delete job loadtest-setup --ignore-not-found --wait=true >/dev/null
if [ -n "${RUNNER_IMAGE:-}" ]; then
  sed -E "s|^( +image: ).*|\1$RUNNER_IMAGE|" "$HERE/setup-job.yaml"
else
  cat "$HERE/setup-job.yaml"
fi | "${K[@]}" apply -f - >/dev/null
echo "setup started; follow with ${KUBECTL:-kubectl} -n $NS logs -f job/loadtest-setup" >&2
if ! "${K[@]}" wait --for=condition=complete job/loadtest-setup --timeout="${SETUP_TIMEOUT:-3600}s" >/dev/null; then
  "${K[@]}" logs job/loadtest-setup --tail=30 >&2 || true
  echo "setup did not complete" >&2
  exit 1
fi
"${K[@]}" logs job/loadtest-setup --tail=5 >&2

if [ -n "${SAVE_SNAPSHOT:-}" ]; then
  stop_ihub # consistent files: nothing writes while tar reads
  "${K[@]}" exec seed -- tar czf "/seed/$SAVE_SNAPSHOT" -C /contents .
  echo "saved /seed/$SAVE_SNAPSHOT" >&2
  restart_ihub
fi
