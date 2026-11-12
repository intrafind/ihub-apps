#!/usr/bin/env bash
# SPDX-FileCopyrightText: IntraFind Software AG
# SPDX-License-Identifier: LicenseRef-iHub-Apps

# Collect the shard results of the loadtest-run Job from the pod logs and
# merge them into tests/load/results/<runId>/report.md.
#   tests/load/k8s/collect.sh [namespace] [job]
set -euo pipefail
NS="${1:-ihub-loadtest}"
JOB="${2:-loadtest-run}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(mktemp)"
for pod in $(kubectl -n "$NS" get pods -l "job-name=$JOB" -o name); do
  kubectl -n "$NS" logs "$pod" --tail=-1 >>"$OUT"
done
node "$HERE/../report.mjs" --from-log "$OUT" "${@:3}"
rm -f "$OUT"
