---
name: deep-review-pr
description: Deep review of a GitHub pull request with parallel sub-agent investigation
user-invocable: true
---

# Deep PR Review

Input: PR number or URL (e.g. `/deep-review-pr 1234`)

This skill performs a thorough, multi-pass review that spends significantly more
tokens than `/review-pr`. Use it for larger, riskier, or more complex PRs.

## Phase 1 — First-pass review

Run the `/review-pr` skill with the given PR number — **follow all of its steps,
including checking out the branch**. This produces the standard review output
(summary, issues table, details, verdict).

> **Always diff against the merge-base, never against `main`/`origin/main`.**
> `main` may have advanced past the point where the PR branched, so `git diff main`
> attributes *main's* later changes to the PR (showing them inverted — an addition
> on main appears as a deletion in the PR). Compute the base once and reuse it:
>
> ```bash
> BASE=$(git merge-base origin/main HEAD)   # the branch's actual root
> git diff "$BASE"...HEAD                    # the PR's true changes
> ```
>
> Prefer `gh pr diff <number>` (already merge-base-correct). When a finding hinges
> on a single line, confirm provenance with `git log -S '<snippet>' "$BASE"..HEAD`
> before reporting it — a line that doesn't appear there is not this PR's doing.
> **Pass `$BASE` (or this instruction) to every sub-agent** so their local diffs
> use the same base.

**Do not show this output to the user yet** — treat it as preliminary input for
the next phases. The final output will replace it.

## Phase 2 — Identify deep-dive areas

Based on the first pass, identify **0–10 areas** that warrant deeper investigation.
Use your judgement to pick whatever areas are most valuable for this specific PR.
Examples of the kinds of things that might warrant a deep dive (not exhaustive):

- **Generic concerns**: API backwards compatibility, data model compatibility,
  concurrency/thread-safety, security implications, cross-module ripple effects,
  missing documentation or migration steps, error handling gaps.
- **Specific code areas**: A class with complex logic, a method that does something
  subtle, a package where the changes interact with tricky existing code.
- **Ambiguous findings**: A first-pass finding whose actual severity depends on
  context you haven't fully explored yet.

For each area, write a focused investigation prompt: what exactly should be checked,
what files/classes are relevant, and what the concern is.

**Skip this phase** (and Phase 3) if the PR is trivial and the first pass found
nothing worth investigating further.

## Phase 3 — Parallel sub-agent investigation

Spawn one Agent (subagent_type: "general-purpose") per deep-dive area, **in parallel**.
Each sub-agent receives:

- The investigation prompt from Phase 2.
- The PR diff (or relevant portion).
- Instruction to read source files as needed for context.
- Instruction to report back with: finding confirmed/downgraded/dismissed, evidence,
  and suggested severity (high/medium/low/none).

Important: tell each sub-agent to be **skeptical** — the goal is to verify whether
a concern is real, not to confirm it. False positives waste the author's time.

## Phase 4 — Synthesize and produce final output

Merge sub-agent findings with first-pass results:
- **Upgrade** findings where a sub-agent found the issue is worse than initially thought.
- **Downgrade or drop** findings where a sub-agent determined the concern is not real.
- **Add new findings** discovered by sub-agents that the first pass missed.

Before finalizing severity ratings, critically re-evaluate each one:
- **high** should be reserved for things that are clearly wrong or will cause
  production issues. When in doubt, it's medium.
- Ask yourself: "Would a senior engineer on this team push back on this rating?"

## Output format

Use the same output format as `/review-pr`, with these additions:

- Add a **### Deep-dive areas investigated** section (after Summary, before Issues).
  Brief list of what was investigated in Phase 3, so the user knows where extra
  scrutiny was applied. If Phase 3 was skipped, say so and why.
- In the Details section, mention sub-agent findings where relevant.
- **high** priority should be used sparingly — when in doubt, use medium.
