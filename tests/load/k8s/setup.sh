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
#
# One setup or run per namespace at a time: setup.sh and run.sh share the Job and ConfigMap
# names and stop iHub for snapshots. A failed restore leaves iHub stopped; restore a
# known-good snapshot (SEED_SNAPSHOT=…) before scaling it up again.
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
  # Never touch contents/ while iHub still writes it.
  if [ -n "$("${K[@]}" get pod -l "app=$DEPLOY" -o name)" ]; then
    echo "iHub pods still running; not touching contents/" >&2
    exit 1
  fi
}

if [ -n "${SEED_SNAPSHOT:-}" ]; then
  echo "restoring $SEED_SNAPSHOT into contents/" >&2
  stop_ihub
  "${K[@]}" exec seed -- sh -c 'gzip -t "/seed/$1" && cd /contents && find . -mindepth 1 -maxdepth 1 -exec rm -rf {} + \
    && tar xzf "/seed/$1" -C /contents && chown -R "$2" /contents' sh "$SEED_SNAPSHOT" "${SEED_OWNER:-100:101}"
  restart_ihub
fi

# Per-call settings for this Job only; credentials stay in loadtest-secrets.
overrides="$(mktemp)"
trap 'rm -f "$overrides"; "${K[@]}" delete configmap loadtest-setup-overrides --ignore-not-found >/dev/null 2>&1 || true' EXIT
env | grep '^LT_' | grep -vE '^LT_(ADMIN_USER|ADMIN_PASSWORD|USER_PASSWORD|LLM_API_KEY|PROM_TOKEN)=' >"$overrides" || true
"${K[@]}" create configmap loadtest-setup-overrides --from-env-file="$overrides" \
  --dry-run=client -o yaml | "${K[@]}" apply -f - >/dev/null
"${K[@]}" delete job loadtest-setup --ignore-not-found --wait=true >/dev/null
image_edit=()
[ -n "${RUNNER_IMAGE:-}" ] && image_edit=(-e "s|^( +image: ).*|\1$RUNNER_IMAGE|")
# The overrides ConfigMap is added to this Job only, after the shared config and secrets.
sed -E ${image_edit[@]+"${image_edit[@]}"} \
  -e 's|^( +)- secretRef: \{ name: loadtest-secrets \}$|&\n\1- configMapRef: { name: loadtest-setup-overrides }|' \
  "$HERE/setup-job.yaml" | "${K[@]}" apply -f - >/dev/null
echo "setup started; follow with ${KUBECTL:-kubectl} -n $NS logs -f job/loadtest-setup" >&2
if ! "${K[@]}" wait --for=condition=complete job/loadtest-setup --timeout="${SETUP_TIMEOUT:-3600}s" >/dev/null; then
  "${K[@]}" logs job/loadtest-setup --tail=30 >&2 || true
  echo "setup did not complete" >&2
  exit 1
fi
"${K[@]}" logs job/loadtest-setup --tail=5 >&2 || true

if [ -n "${SAVE_SNAPSHOT:-}" ]; then
  stop_ihub # consistent files: nothing writes while tar reads
  "${K[@]}" exec seed -- sh -c 'tar czf "/seed/$1.tmp" -C /contents . && mv "/seed/$1.tmp" "/seed/$1"' sh "$SAVE_SNAPSHOT"
  echo "saved /seed/$SAVE_SNAPSHOT" >&2
  restart_ihub
fi
