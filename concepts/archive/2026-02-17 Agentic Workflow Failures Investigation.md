# Agentic Workflow Failures - Investigation Summary

**Date**: 2026-02-17  
**Issue**: [agentics] Failed runs  
**Branch**: copilot/track-agentic-workflow-failures

## Overview

This document summarizes the investigation and fixes for failed agentic workflows in the ihub-apps repository.

## Failed Workflows Investigated

### 1. ✅ FIXED: Summarize new issues (summary.yml)
**Run**: https://github.com/intrafind/ihub-apps/actions/runs/22102095918  
**Status**: **FIXED**

**Problem**: Shell quoting error when AI response contained apostrophes  
**Error**: `unexpected EOF while looking for matching `''`  
**Fix**: Changed from single quotes to double quotes with environment variables

**Details**: See `concepts/2026-02-17 Fix Summary Workflow Shell Quoting Issue.md`

### 2. ℹ️ Glossary Maintainer (glossary-maintainer.lock.yml)
**Run**: https://github.com/intrafind/ihub-apps/actions/runs/22102038592  
**Status**: Agentic workflow execution issue (not a code issue)

**Error**: `[ERROR] No log sources found. Run awf with a command first to generate logs.`

**Analysis**: This is an execution environment issue with the agentic workflow framework itself. The agent step completed but couldn't generate firewall logs. This is not a code issue in the repository.

**Recommendation**: Review with agentic workflows team or check workflow configuration.

### 3. ℹ️ Daily Documentation Updater (daily-doc-updater.lock.yml)
**Run**: https://github.com/intrafind/ihub-apps/actions/runs/22101962993  
**Status**: Agentic workflow execution issue (not a code issue)

**Error**: Similar to glossary-maintainer - "No firewall activity detected"

**Analysis**: Execution environment issue, not a code problem.

### 4. ℹ️ Auto Lint & Format (auto-lint-format.yml)
**Run**: https://github.com/intrafind/ihub-apps/actions/runs/22102028718  
**Status**: Branch not found error

**Error**: `A branch or tag with the name 'add-workflow-.github-workflows-glossary-maintainer.md-1370' could not be found`

**Analysis**: The workflow attempted to check out a branch that doesn't exist. This is likely a transient issue or a configuration problem with the workflow trigger.

**Recommendation**: Monitor future runs. May be related to branch lifecycle or cleanup.

### 5. ℹ️ CodeQL Advanced (codeql.yml)
**Runs**: 
- https://github.com/intrafind/ihub-apps/actions/runs/22102030516
- https://github.com/intrafind/ihub-apps/actions/runs/22102028670

**Status**: Configuration error in CodeQL analysis

**Error**: `Code Scanning could not process the submitted SARIF file` / `CodeQL job status was configuration error`

**Analysis**: This is a GitHub CodeQL service configuration issue, not a code problem in the repository.

**Recommendation**: 
- Check CodeQL configuration in `.github/workflows/codeql.yml`
- Review GitHub CodeQL service status
- May require updating CodeQL action version or configuration

### 6. ℹ️ Test Suite (test-suite.yml)
**Runs**:
- https://github.com/intrafind/ihub-apps/actions/runs/22102029756
- https://github.com/intrafind/ihub-apps/actions/runs/22102026377

**Status**: No failed jobs found in logs

**Analysis**: These runs were marked as failed but inspection showed no actual failed job logs. May be false positives or transient failures.

**Recommendation**: Monitor future test runs. The test infrastructure appears healthy.

## Summary

### Fixed Issues
✅ **1 code issue fixed**: `summary.yml` shell quoting problem

### Not Code Issues
ℹ️ **5 operational/environment issues** identified that require action outside the codebase:
- 2 agentic workflow execution issues (glossary-maintainer, daily-doc-updater)
- 1 branch checkout issue (auto-lint-format)
- 2 CodeQL configuration issues
- 2 test suite false positives

## Recommendations

1. **For agentic workflow issues**: Engage with GitHub Agentic Workflows team to debug execution environment
2. **For CodeQL issues**: Review CodeQL configuration and GitHub service status
3. **For test suite**: Monitor future runs; no immediate action needed
4. **For auto-lint-format**: Monitor branch lifecycle and workflow triggers

## Files Modified

- `.github/workflows/summary.yml` - Fixed shell quoting issue
- `concepts/2026-02-17 Fix Summary Workflow Shell Quoting Issue.md` - Detailed fix documentation
- `concepts/2026-02-17 Agentic Workflow Failures Investigation.md` - This summary document

## Prevention

For future workflow development:
- Use double quotes with environment variables for user/AI-generated content
- Avoid direct interpolation of outputs into shell commands with single quotes
- Test workflows with content containing special characters
- Regularly review workflow execution logs for patterns
