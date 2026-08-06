# Fix for Summary Workflow Shell Quoting Issue

**Date**: 2026-02-17  
**Issue**: [agentics] Failed runs - Summary workflow failure  
**Workflow Run**: https://github.com/intrafind/ihub-apps/actions/runs/22102095918

## Problem

The `summary.yml` workflow was failing with a shell parsing error:

```
unexpected EOF while looking for matching `''
```

### Root Cause

The workflow used single quotes to wrap the AI-generated response in the shell command:

```yaml
gh issue comment $ISSUE_NUMBER --body '${{ steps.inference.outputs.response }}'
```

When the AI response contained apostrophes or single quotes (e.g., "Glossary Maintainer" with the apostrophe in "Maintainer"), it broke the shell command syntax. The single quote in the response terminated the string early, causing a shell parsing error.

### Error Example

```bash
# This breaks when response contains: "The GitHub issue reports a failure in the \"Glossary Maintainer\" workflow"
gh issue comment 924 --body 'The GitHub issue reports a failure in the "Glossary Maintainer" workflow'
#                                                                            ^ This apostrophe breaks the command
```

## Solution

Changed the command to use double quotes and reference the environment variable:

```yaml
- name: Comment with AI summary
  run: |
    gh issue comment "$ISSUE_NUMBER" --body "$RESPONSE"
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    ISSUE_NUMBER: ${{ github.event.issue.number }}
    RESPONSE: ${{ steps.inference.outputs.response }}
```

### Why This Works

1. **Double quotes** allow variable expansion while handling most special characters
2. **Environment variables** provide proper escaping by the shell environment
3. **No direct interpolation** of GitHub Actions output in the shell command

## Files Changed

- `.github/workflows/summary.yml` - Fixed shell quoting in the comment step

## Testing

The fix was validated by simulating the failure scenario:

```bash
# Simulated response with quotes and apostrophes
RESPONSE="The GitHub issue reports a failure in the \"Glossary Maintainer\" workflow"
ISSUE_NUMBER="924"

# New approach (fixed)
gh issue comment "$ISSUE_NUMBER" --body "$RESPONSE"  # Works correctly
```

## Related Workflows

Reviewed all workflows in `.github/workflows/` and confirmed this was the only instance of this problematic pattern.

## Prevention

For future workflow development:
- Always use double quotes with environment variables when passing user-generated or AI-generated content
- Avoid direct interpolation of GitHub Actions outputs into shell commands with single quotes
- Test workflows with content containing special characters (quotes, apostrophes, backticks)
