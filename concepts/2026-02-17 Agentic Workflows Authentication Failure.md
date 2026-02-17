# Agentic Workflows Authentication Failure

**Date**: 2026-02-17  
**Status**: Platform Issue - Cannot be fixed in repository  
**Affected Workflows**: daily-doc-updater, glossary-maintainer

## Problem Summary

All agentic workflows in the repository are failing with authentication errors. The Copilot CLI cannot authenticate despite the COPILOT_GITHUB_TOKEN secret being properly configured and validated.

## Root Cause

The COPILOT_GITHUB_TOKEN environment variable is accessed by the one-shot-token library but is not being properly passed through to the Copilot CLI when running in chroot mode.

### Evidence from Logs

```
[one-shot-token] Token COPILOT_GITHUB_TOKEN accessed and cached (value: ghp_...)
```

But then:

```
Error: No authentication information found.

Copilot can be authenticated with GitHub using an OAuth Token or a Fine-Grained Personal Access Token.

To authenticate, you can use any of the following methods:
  • Start 'copilot' and run the '/login' command
  • Set the COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN environment variable
  • Run 'gh auth login' to authenticate with the GitHub CLI
```

## Failed Workflow Runs

- **Daily Documentation Updater**: https://github.com/intrafind/ihub-apps/actions/runs/22107456364
  - Failed at step 26: Execute GitHub Copilot CLI
  - Exit code: 1
  
- **Glossary Maintainer**: https://github.com/intrafind/ihub-apps/actions/runs/22107089174
  - Failed at step 26: Execute GitHub Copilot CLI
  - Exit code: 1

## Validation Status

- ✅ COPILOT_GITHUB_TOKEN secret exists
- ✅ Secret validation passed (`GH_AW_SECRET_VERIFICATION_RESULT: success`)
- ✅ One-shot-token library can access the token
- ❌ Copilot CLI cannot access the token in chroot environment

## Impact

All agentic workflows are currently non-functional. This includes:
- Daily Documentation Updater
- Glossary Maintainer
- Any future agentic workflows

## Technical Details

### Chroot Environment Issue

The entrypoint logs show:

```
[entrypoint] Chroot mode enabled - dropping CAP_NET_ADMIN, CAP_SYS_CHROOT, and CAP_SYS_ADMIN
[entrypoint] Switching to awfuser (UID: 1001, GID: 1001)
[entrypoint] Executing command: /usr/local/bin/copilot --add-dir /tmp/gh-aw/ ...
[entrypoint] Chroot mode: running command inside host filesystem (/host)
```

The token is available to the one-shot-token library but not passed through the chroot boundary to the Copilot CLI process.

### Environment Variable Cleanup

The logs also show:

```
[entrypoint] Unsetting sensitive tokens from parent shell environment...
[entrypoint] Unset COPILOT_GITHUB_TOKEN from /proc/1/environ
```

This cleanup happens AFTER the Copilot CLI fails, but it suggests there might be environment variable handling issues in the chroot setup.

## Conclusion

This is a **platform infrastructure issue** with the gh-aw (GitHub Agentic Workflows) system, specifically related to how environment variables are passed into chroot environments. 

**This cannot be fixed at the repository level.**

## Recommendation

1. Report this issue to the gh-aw platform maintainers (github/gh-aw repository)
2. Disable scheduled runs of affected workflows until the platform issue is resolved
3. Wait for a platform fix before re-enabling the workflows

## Related Issues

- Issue #931: [agentics] Daily Documentation Updater failed
- Parent Issue #926: [agentics] Failed runs

## Repository Configuration

The workflow configurations themselves are correct:
- ✅ Proper frontmatter with correct fields
- ✅ Valid cron schedules (automatically converted from "daily" to proper cron expressions)
- ✅ Correct permissions configuration
- ✅ COPILOT_GITHUB_TOKEN secret properly configured

No changes needed in the repository workflows - they are configured correctly.
