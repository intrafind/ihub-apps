# Agentic Workflows Edit Tool Configuration Fix

**Date:** 2026-02-17  
**Type:** Bug Fix  
**Affected Workflows:** daily-doc-updater, glossary-maintainer

## Problem

The agentic workflows `daily-doc-updater` and `glossary-maintainer` were consistently failing with the error:

```
Unable to download artifact(s): Artifact not found for name: agent-output
```

This was a symptom of the agent job failing during execution, which prevented the creation of the required output artifact.

## Root Cause

Both workflows had a critical configuration mismatch:

1. **Configuration:** The frontmatter specified `edit: null`, explicitly disabling the edit tool
2. **Prompt Instructions:** The workflow prompts instructed the agent to "use the edit tool" to update files
3. **Failure Mode:** When the agent attempted to edit files, the tool was unavailable, causing the agent to fail

**Example from daily-doc-updater.md (line 130):**
```markdown
3. **Update the appropriate file(s)** using the edit tool:
   - Add new sections for new features
   - Update existing sections for modified features
```

**Configuration (line 41):**
```yaml
tools:
  bash:
    # ... other tools
  edit: null  # ❌ Tool explicitly disabled!
```

## Solution

Changed `edit: null` to `edit: {}` in both workflow files:

### Files Modified

1. **`.github/workflows/daily-doc-updater.md`**
   - Line 41: Changed `edit: null` → `edit: {}`
   
2. **`.github/workflows/glossary-maintainer.md`**
   - Line 40: Changed `edit: null` → `edit: {}`

### Compilation

After modifying the markdown workflow definitions, recompiled using:

```bash
gh aw compile .github/workflows/daily-doc-updater.md
gh aw compile .github/workflows/glossary-maintainer.md
```

This updated the corresponding `.lock.yml` files with new frontmatter hashes:
- `daily-doc-updater.lock.yml` - Hash changed to `00044f6c92eea5bdc572908e5094bd29aeb3ac97735c667aa08331ff1df081b4`
- `glossary-maintainer.lock.yml` - Hash updated similarly

## Technical Details

### Agentic Workflow Tool Configuration

In agentic workflows, tools can be configured in several ways:

- **Disabled:** `tool_name: null` - Tool is not available to the agent
- **Enabled (default settings):** `tool_name: {}` - Tool is available with default configuration
- **Enabled (custom settings):** `tool_name: { option: value }` - Tool with custom configuration
- **Enabled (list config):** `tool_name: [item1, item2]` - Tool with list-based configuration

The `edit` tool is essential for workflows that need to modify repository files. Setting it to `null` completely disables it, even if the prompt instructions expect it to be available.

## Impact

### Before Fix
- Agent jobs would fail silently when attempting file edits
- No `agent-output` artifact created
- Conclusion job would fail trying to download missing artifact
- Workflow marked as failed with unclear error messages

### After Fix
- Agent can successfully use the edit tool to modify files
- Agent job completes successfully, creating the agent-output artifact
- Conclusion job can process the results properly
- Workflow completes successfully with documentation updates

## Testing

To test the fix:

1. Manually trigger the `daily-doc-updater` workflow:
   ```bash
   gh workflow run daily-doc-updater.lock.yml
   ```

2. Monitor the workflow run at: https://github.com/intrafind/ihub-apps/actions/workflows/daily-doc-updater.lock.yml

3. Verify:
   - Agent job completes with status "success"
   - Agent-output artifact is created
   - Conclusion job successfully downloads and processes the artifact
   - If changes are detected, a PR is automatically created

## Related Issues

- GitHub Issue #931: `[agentics] Daily Documentation Updater failed`
- Multiple failed workflow runs:
  - Run #22107456364 (Feb 17, 16:52 UTC)
  - Run #22108475783 (Feb 17, 17:22 UTC)
  - Run #22108591255 (Feb 17, 17:26 UTC)
  - Run #22108781907 (Feb 17, 17:32 UTC)
  - Run #22108978737 (Feb 17, 17:35 UTC)

## Prevention

To prevent similar issues in the future:

1. **Validation:** Add validation to check that tools mentioned in the prompt are enabled in the frontmatter
2. **Documentation:** Clearly document which tools are required for each workflow type
3. **Testing:** Test workflows after configuration changes by triggering manual runs
4. **Code Review:** Review frontmatter and prompt instructions together to ensure consistency

## References

- Agentic Workflows Documentation: https://github.github.com/gh-aw/
- Workflow Source Files:
  - `daily-doc-updater.md`: https://github.com/github/gh-aw/blob/main/.github/workflows/daily-doc-updater.md
  - `glossary-maintainer.md`: https://github.com/github/gh-aw/blob/main/.github/workflows/glossary-maintainer.md
