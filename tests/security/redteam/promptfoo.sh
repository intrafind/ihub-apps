#!/usr/bin/env bash
# SPDX-FileCopyrightText: IntraFind Software AG
# SPDX-License-Identifier: LicenseRef-iHub-Apps
#
# Runs promptfoo of the nightly red team (.github/workflows/redteam.yml) from its official
# container image, pinned by digest in the workflow (PROMPTFOO_IMAGE): no packages are resolved
# or installed on the runner, so the run never picks up a new transitive dependency. Both
# promptfoo runs of the workflow go through here, so they get the same settings.
#
#   PROMPTFOO_IMAGE=<image@sha256:...> bash tests/security/redteam/promptfoo.sh eval -c <config> ...
#
# The image runs promptfoo as self-hosted, which turns `{{env.X}}` in a config into an empty
# string (the token header became a bare "Bearer", so every call was anonymous and answered 404
# for the apps). The configs read the token, the model and the endpoint that way, so it is
# switched back on; only the variables passed with -e below exist in the container.

set -euo pipefail

: "${PROMPTFOO_IMAGE:?PROMPTFOO_IMAGE must name the pinned promptfoo image}"

exec docker run --rm --network host --user "$(id -u):$(id -g)" \
  -v "${GITHUB_WORKSPACE:-$PWD}:/work" -w /work -e HOME=/tmp \
  -e IHUB_TOKEN -e REDTEAM_BASE_URL -e REDTEAM_MODEL -e REDTEAM_GRADER_KEY \
  -e PROMPTFOO_DISABLE_TEMPLATE_ENV_VARS=false \
  -e PROMPTFOO_DISABLE_TELEMETRY -e PROMPTFOO_DISABLE_SHARING \
  -e PROMPTFOO_DISABLE_REMOTE_GENERATION -e PROMPTFOO_DISABLE_UPDATE \
  --entrypoint node "$PROMPTFOO_IMAGE" /app/dist/src/entrypoint.js "$@"
