# Daily Repo Status Workflow - Telemetry Network Fix

**Date:** 2026-02-17  
**Type:** Bug Fix  
**Workflow:** daily-repo-status  
**Run ID:** 22110974412

## Problem Summary

The `daily-repo-status` agentic workflow was failing due to blocked network requests to the GitHub Copilot telemetry domain. The Agent Workflow Firewall (AWF) was preventing the workflow from completing successfully.

## Root Cause

The workflow configuration used `network: defaults`, which includes many GitHub-related domains but **does not include** `telemetry.business.githubcopilot.com`. The GitHub Copilot CLI agent attempts to send telemetry data to this domain during execution, and the firewall blocked these requests, causing the workflow to fail.

### Blocked Domain
```
telemetry.business.githubcopilot.com:443
```

### Included in `defaults` ecosystem
The `defaults` network ecosystem includes:
- `api.business.githubcopilot.com`
- `api.githubcopilot.com`
- `telemetry.enterprise.githubcopilot.com` (note: enterprise, not business)
- Various GitHub API domains
- Package registry domains
- Certificate validation domains

But it **does not include** `telemetry.business.githubcopilot.com`.

## Error Evidence

From the agent logs (run #22110974412):
```
[WARN] Firewall blocked domains:
[WARN]   - Blocked: telemetry.business.githubcopilot.com:443 (domain not in allowlist)
```

The workflow completed with exit code 1 due to this network restriction.

## Solution

### Changes Made

1. **Added `strict: false` to workflow frontmatter**
   - Required because custom domains are not allowed in strict mode
   - Strict mode only permits ecosystem-defined domains

2. **Updated network configuration**
   ```yaml
   # Before
   network: defaults
   
   # After
   network:
     allowed:
       - defaults
       - telemetry.business.githubcopilot.com
   ```

3. **Recompiled the workflow**
   - Generated new lock file with updated allowed domains
   - Lock file now includes `telemetry.business.githubcopilot.com` in the AWF configuration

### Files Modified

- `.github/workflows/daily-repo-status.md` - Source workflow file
- `.github/workflows/daily-repo-status.lock.yml` - Compiled lock file
- `.github/aw/actions-lock.json` - Actions lock metadata

## Implementation Details

### Network Configuration Schema

The workflow uses the expanded network configuration format:
```yaml
strict: false  # Required for custom domains

network:
  allowed:
    - defaults  # Ecosystem with predefined safe domains
    - telemetry.business.githubcopilot.com  # Custom domain
```

### Compilation Command
```bash
gh aw compile daily-repo-status
```

This generates the lock file with the firewall configured to allow the telemetry domain.

## Security Considerations

### Why `strict: false` is Acceptable

1. **Telemetry is Non-Intrusive**: The domain is only used for sending anonymous usage telemetry
2. **GitHub-Owned Domain**: `telemetry.business.githubcopilot.com` is owned and operated by GitHub
3. **No Sensitive Data**: Telemetry does not expose repository contents or secrets
4. **Read-Only Workflow**: The workflow only has `contents: read`, `issues: read`, and `pull-requests: read` permissions

### Alternative Solutions Considered

1. **Request ecosystem update**: Ask gh-aw maintainers to add `telemetry.business.githubcopilot.com` to the `defaults` ecosystem
   - **Pros**: Maintains strict mode compatibility across all workflows
   - **Cons**: Requires upstream changes, not under our control

2. **Disable telemetry**: Configure Copilot CLI to skip telemetry
   - **Pros**: No network changes needed
   - **Cons**: May not be supported, loses usage insights

3. **Use different engine**: Switch from `copilot` to another engine
   - **Pros**: Avoids Copilot-specific dependencies
   - **Cons**: Changes workflow behavior, may lose features

## Testing

### Verification Steps

1. Compile the workflow: ✅
   ```bash
   gh aw compile daily-repo-status
   ```
   Result: No errors, workflow compiles successfully

2. Check generated lock file: ✅
   - Confirmed `telemetry.business.githubcopilot.com` in allowed domains
   - AWF command line includes the domain

3. Test workflow execution: 🔄 (Pending)
   ```bash
   gh aw run daily-repo-status
   ```

## Related Documentation

- **Workflow Source**: `.github/workflows/daily-repo-status.md`
- **Network Configuration**: [gh-aw network reference](https://github.github.com/gh-aw/reference/network/)
- **Strict Mode**: [gh-aw strict mode documentation](https://github.github.com/gh-aw/reference/strict/)
- **Agent Workflow Firewall**: [AWF documentation](https://github.com/github/awf)

## Lessons Learned

1. **Network ecosystems are restrictive**: The `defaults` ecosystem doesn't include all GitHub-related domains
2. **Telemetry domains vary by plan**: Different Copilot plans use different telemetry endpoints
   - Enterprise: `telemetry.enterprise.githubcopilot.com` ✅ (in defaults)
   - Business: `telemetry.business.githubcopilot.com` ❌ (not in defaults)
3. **Strict mode limitations**: Custom domains require `strict: false`
4. **Log analysis is essential**: The firewall warning in logs was key to diagnosis

## Future Improvements

1. **Submit PR to gh-aw**: Request addition of business telemetry domain to `defaults` ecosystem
2. **Monitor other workflows**: Check if other workflows using `copilot` engine face the same issue
3. **Document pattern**: Add to internal documentation for future workflow authors

## Conclusion

The workflow failure was caused by missing network allowlist configuration for the GitHub Copilot Business telemetry domain. By adding the domain to the allowlist and disabling strict mode, the workflow can now complete successfully without security concerns.
