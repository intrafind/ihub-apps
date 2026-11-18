#!/usr/bin/env bash
# SPDX-FileCopyrightText: IntraFind Software AG
# SPDX-License-Identifier: LicenseRef-iHub-Apps

# Collect the shard results of the loadtest-run Job and merge them into
# tests/load/results/<runId>/report.md.
#
#   tests/load/k8s/collect.sh [namespace] [job] [report.mjs options, e.g. --target 400]
#
# Reliable path: each runner pod stays up after its run (run-job.yaml) and marks the end
# with /loadtest/results/DONE; this script waits for DONE per pod and copies
# results/<runId>/shard-*.json out with `kubectl cp`.
# Fallback, when no pod is still running: the ##LT-RESULT## lines of `kubectl logs`.
# kubectl logs splits very long lines, so a larger shard result can arrive incomplete
# ("incomplete result for …"); then rerun with the pods kept alive.
#
# Environment: KUBECTL (default `kubectl`, e.g. "kubectl --context k3s01"),
# COLLECT_TIMEOUT_MIN (default 120): how long to wait for the runs to end.
set -euo pipefail
NS="${1:-ihub-loadtest}"
JOB="${2:-loadtest-run}"
shift $(($# < 2 ? $# : 2))
read -r -a KUBECTL <<<"${KUBECTL:-kubectl}"
K=("${KUBECTL[@]}" -n "$NS")
HERE="$(cd "$(dirname "$0")" && pwd)"
RESULTS="$HERE/../results"
deadline=$((SECONDS + ${COLLECT_TIMEOUT_MIN:-120} * 60))

pods=$("${K[@]}" get pods -l "job-name=$JOB" -o name)
[ -n "$pods" ] || { echo "no pods of job $JOB in $NS" >&2; exit 1; }

phase() { "${K[@]}" get "$1" -o jsonpath='{.status.phase}' 2>/dev/null || true; }

dir=""
copied=0
for pod in $pods; do
  name=${pod#pod/}
  # Wait for the run to end; every exec is bounded, a hung API call must not block forever.
  until "${K[@]}" exec --request-timeout=30s "$name" -- test -f /loadtest/results/DONE 2>/dev/null; do
    p=$(phase "$pod")
    if [ "$p" != Running ] && [ "$p" != Pending ]; then
      echo "$name is $p: no file to copy" >&2
      continue 2
    fi
    if [ $SECONDS -gt $deadline ]; then
      echo "$name: no DONE after ${COLLECT_TIMEOUT_MIN:-120} min" >&2
      continue 2
    fi
    sleep 20
  done
  for f in $("${K[@]}" exec --request-timeout=30s "$name" -- sh -c 'ls /loadtest/results/*/shard-*.json' 2>/dev/null); do
    run_id=$(basename "$(dirname "$f")")
    dir="$RESULTS/$run_id"
    mkdir -p "$dir"
    "${K[@]}" cp "$name:$f" "$dir/$(basename "$f")" >/dev/null
    copied=$((copied + 1))
  done
done

if [ "$copied" -gt 0 ]; then
  echo "copied $copied shard file(s) to $dir" >&2
  node "$HERE/../report.mjs" "$dir" "$@"
  exit
fi

# ponytail: all-or-nothing fallback; a run with some pods gone and some alive keeps only the copies.
echo "no shard files copied, falling back to the pod logs" >&2
OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT
for pod in $pods; do
  "${K[@]}" logs "$pod" --tail=-1 >>"$OUT"
done
node "$HERE/../report.mjs" --from-log "$OUT" "$@"
