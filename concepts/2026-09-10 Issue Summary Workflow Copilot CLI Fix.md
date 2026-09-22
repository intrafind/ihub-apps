# Issue summary workflow: root cause and fix

**Status:** implemented
**Scope:** `.github/workflows/summary.yml` (CI only, no product code)
**Failing run that triggered this:** [run 34451347753](https://github.com/intrafind/ihub-apps/actions/runs/34451347753)

## Symptom

Every issue opened since 2026-08-27 produced a red **Summarize new issues** run and
no summary comment. The job log ended with a single, unexplained line:

```
##[error]Copilot CLI exited with code 1. Re-run the workflow with ACTIONS_STEP_DEBUG=true to see the CLI's stderr output.
```

The 15 most recent runs (`#633`–`#647`) all failed the same way, always ~3 seconds
after the inference step started.

## Root cause

The workflow pinned `model: gpt-4.1` on `actions/ai-inference@v3`, which shells out to
`copilot -p <prompt> -s --no-ask-user --model gpt-4.1`.

**GPT-4.1 was removed from every GitHub Copilot surface on 2026-06-01**
([changelog](https://github.blog/changelog/2026-06-02-gpt-4-1-deprecated/); GitHub's
[supported models](https://docs.github.com/en/copilot/reference/ai-models/supported-models)
list no longer contains it, and names GPT-5.5 as the replacement). The Copilot CLI
therefore rejects the model and exits 1.

Two things turned that into a silent, long-lived breakage:

1. `gpt-4.1` is also `actions/ai-inference@v3`'s **documented default**, so the pin
   looked correct — but the migration off the retired GitHub Models endpoint landed on
   2026-08-27, nearly three months *after* GPT-4.1 was already gone. The Copilot path
   never worked, not once.
2. The action **discards the CLI's stderr** unless the whole run is repeated with
   `ACTIONS_STEP_DEBUG`, so nothing in the log said which of the plausible causes
   (model, token type, token expiry, lost Copilot seat) had actually fired.

The token itself cannot be verified from outside the repository. If
`COPILOT_GITHUB_TOKEN` has also expired — or is a classic `ghp_` PAT, which the CLI
refuses outright — the next run now says so in plain text instead of exiting 1
anonymously.

## Fix

The workflow calls the Copilot CLI itself instead of going through
`actions/ai-inference@v3`:

- **No model pin.** `--model` is only passed when the optional repository variable
  `ISSUE_SUMMARY_MODEL` is set (e.g. `claude-haiku-4.5`). Unset — the default — lets
  Copilot pick, so a future model retirement cannot break this workflow again.
- **Failures are diagnosable.** The CLI's stderr goes to the job log *and* the run
  summary, next to a warning that lists the usual causes.
- **Failures are not fatal.** A missing summary is a missing nice-to-have, not a red X
  on someone's newly opened issue: the step warns and exits 0, and the comment step is
  skipped.
- **Untrusted issue text never reaches the script as a workflow expression.** Title and
  body arrive as environment variables and are read as shell variables, capped at 500
  and 8000 characters.
- **`@mentions` in the model's output are neutralized** (wrapped in code spans) before
  the summary is posted, so a prompt-injected summary cannot notify users or teams.
  E-mail addresses are left alone.
- **The agent stays text-only.** No `--allow-tool`/`--allow-all-tools`, plus
  `--disable-builtin-mcps` so the bundled GitHub MCP server never starts under the PAT
  identity, and `--no-color` so no ANSI escapes can land in a comment.
- `timeout-minutes: 10` caps a stuck agentic session, and the posted comment is
  labelled as an automated Copilot summary.

## Verification

Live inference cannot be exercised outside CI (it needs a Copilot-entitled token), so
the parts that can be tested were tested:

- Flag set accepted by Copilot CLI 1.0.83 — `-p … -s --no-ask-user --no-color
  --disable-builtin-mcps` parses and proceeds to authentication, no unknown-option
  error.
- The step script was run against a stubbed `copilot` for all three outcomes: success
  (comment file written, mentions neutralized, `summarized=true`), non-zero exit
  (stderr surfaced, warning emitted, step exits 0, no comment), and empty response
  (treated as a failure).
- Shell-injection probes in the title (`$(…)`, backticks, quotes) and a
  workflow-expression probe in the body pass through as literal prompt data.

## Follow-ups for maintainers

- The next opened issue shows whether the token is also stale: if the run is green and
  a summary appears, the model pin was the whole problem; if the warning names a token
  problem, rotate `COPILOT_GITHUB_TOKEN` (fine-grained PAT, personal account, "Copilot
  Requests" account permission, no repository scopes).
- Optional: set the `ISSUE_SUMMARY_MODEL` repository variable to a cheap model if
  premium-request consumption on the default model matters.
- The `author_association` gate in the workflow is still commented out, so summaries
  are generated for issues from anyone. The mention neutralizer and the tool-free
  invocation limit the blast radius, but enabling the gate remains the stronger
  control.
