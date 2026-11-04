# Configurable Agent Review Behavior — Design

**Date:** 2026-06-25
**Status:** Approved (pending spec review)
**Repo:** ihub-apps

## Goal

Let operators configure, **per agent profile**, how strict the adversarial review
is and how many iterations are acceptable — surfaced in the admin UI — so
different agents can have different bars for "good enough." Today these are
hard-coded in the workflow JSON (`verify.config.maxRetries`, `stallLimit`,
`criteria`) and in the verifier's accept/retry logic, so every agent shares one
behavior and operators can't tune it without editing gitignored workflow files.

Bundled: a planner-prompt fix that stops the planner emitting a redundant
"write the final report" task (the top-level `synthesize` node owns
composition).

## Decisions (from brainstorming)

- **Strictness model:** preset levels (`lenient` / `balanced` / `strict`) with
  optional per-field overrides. Default `balanced` ≈ current behavior.
- **Acceptance bar:** verdict + rounds based. NO per-gap severity, NO new
  verdict types — the verifier's output contract is unchanged. Strictness only
  changes which verdicts are accepted and how many rounds run.

## Preset → behavior mapping

| Preset | Accepts | maxRounds | stallLimit |
|---|---|---|---|
| `lenient` | first PASS **or PARTIAL** | 2 | 1 |
| `balanced` | PASS; else PARTIAL **after stall** | 4 | 2 |
| `strict` | **PASS only** (never PARTIAL) | 6 | 2 |

Per-field overrides (`maxRounds`, `stallLimit`, `criteria`) win over the preset
when set.

These map to four verifier knobs:
- `acceptPartial` — accept a conclusive PARTIAL immediately (lenient only).
- `acceptPartialAfterStall` — accept PARTIAL once the gap count stops shrinking
  for `stallLimit` rounds (balanced).
- `requirePass` — never accept PARTIAL; only a PASS ends the loop (strict).
- `maxRetries` / `stallLimit` — the round budget.

Preset resolution:

| Preset | acceptPartial | acceptPartialAfterStall | requirePass | maxRetries | stallLimit |
|---|---|---|---|---|---|
| lenient | true | true | false | 2 | 1 |
| balanced | false | true | false | 4 | 2 |
| strict | false | false | true | 6 | 2 |

## Components & data flow

### 1. Profile schema — `server/validators/agentProfileSchema.js`
New optional `review` object on the profile:
```
review: {
  strictness: z.enum(['lenient','balanced','strict']).default('balanced'),
  maxRounds:  z.number().int().min(1).max(10).optional(),
  stallLimit: z.number().int().min(1).max(5).optional(),
  criteria:   z.string().optional()   // overrides verify node criteria text
}
```
Backward compatible: omitting `review` → `balanced` defaults.

### 2. Preset resolver — new pure helper
A pure function `resolveReviewSettings(review)` (e.g. in a small new module
`server/agents/profile/reviewSettings.js`, or alongside the serializer) maps
`{strictness, overrides}` → the concrete knob object
`{ acceptPartial, acceptPartialAfterStall, requirePass, maxRetries, stallLimit, criteria? }`.
Pure → unit-testable directly.

### 3. Run-start wiring — `server/routes/agents/runs.js`
External workflows ignore profile flags, so — exactly like `applyNodeModels`
and the durable `_agentModelConfig` — inject the resolved review settings:
- Set them on the **verify node's** `config` (find node(s) of type `verifier`):
  `maxRetries`, `stallLimit`, `acceptPartial`, `acceptPartialAfterStall`,
  `requirePass`, and `criteria` (only if overridden).
- Also publish into durable run state (`initialData._agentReviewConfig`) so the
  values survive the config-cache TTL refresh (same root cause as the model
  fix), and the verifier can read them from state as a fallback if the node
  config was wiped.
Applied in BOTH the start path and the resume path.

### 4. VerifierNodeExecutor — `server/services/workflow/executors/VerifierNodeExecutor.js`
The executor already classifies PASS / FAIL / PARTIAL / INCONCLUSIVE and tracks
gap-count stall. Add acceptance gating driven by the injected knobs (read from
`config`, falling back to `state.data._agentReviewConfig`):
- A conclusive PARTIAL → accept (branch `pass`) when `acceptPartial` is true.
- A conclusive PARTIAL whose gap count has plateaued for `stallLimit` rounds →
  accept when `acceptPartialAfterStall` is true (this is roughly today's
  stall behavior, now gated).
- `requirePass` → only a PASS accepts; PARTIAL always retries until the round
  budget is exhausted, then terminal not-passed (existing clean-terminal path).
- `maxRetries` / `stallLimit` already consumed by the executor — now sourced
  from config/state instead of being hard-coded in the workflow JSON.
Output contract (verdict shape, branch values `pass`/`retry`/terminal)
unchanged.

### 5. Admin UI — agent profile editor
New "Review" section in the profile editor (same page that edits
`preferredModel` / `nodeModels`):
- **Strictness** dropdown (Lenient / Balanced / Strict), default Balanced.
- **Advanced** disclosure: numeric **Max rounds**, **Stall limit**, and a
  **Custom acceptance criteria** textarea (maps to `review.criteria`).
- Saves into `profile.review`. Empty advanced fields = use preset.
Follow the existing profile-editor form patterns and i18n.

### 6. Bundled planner-prompt fix — `server/services/workflow/executors/PlannerNodeExecutor.js` (`DEFAULT_PLANNER_SYSTEM`) and the external workflow's planner `system`
Add an explicit instruction: do NOT emit a final-report / synthesis /
"compile the report" task — final composition is owned by the downstream
`synthesize` node. The planner emits only research/verification/analysis tasks.
(The phased workflow JSON carries its own copy of the planner system prompt, so
update both the canonical constant and the gitignored workflow JSON.)

## Testing

- `reviewSettings` resolver: plain-node test asserting each preset → knob map,
  and that overrides win (`maxRounds`/`stallLimit`/`criteria`).
- VerifierNodeExecutor: extend the adversarial test — `acceptPartial` accepts a
  PARTIAL immediately; `requirePass` never accepts PARTIAL; `acceptPartialAfterStall`
  accepts only after the stall threshold. (Plain-node, mirrors existing
  `agent-adversarial-verifier.test.js`.)
- runs.js injection: assert resolved review settings land on the verify node
  config + `_agentReviewConfig` (schema-level / unit where practical).
- Profile schema: `review` validates; omission defaults to balanced.
- Planner prompt: assert the system prompt forbids final-report tasks
  (string-contains guard), consistent with how other prompt invariants are tested.
- Lint 0 errors; all tests plain-node (`node server/tests/x.test.js`).

## Out of scope (YAGNI)

- Per-gap severity classification / new verdict types.
- Changing the verifier's verdict-parsing or tool-enabled loop.
- A global (non-per-agent) strictness setting.
- Migrating the hard-coded numbers out of serializer-built (non-external)
  workflows beyond what the profile injection already covers.

## Backward compatibility

- Profiles without `review` behave as `balanced`. The `balanced` preset
  (maxRetries 4, stallLimit 2, accept PARTIAL after stall) matches the current
  phased workflow's hard-coded values, so existing agents are unchanged.
- Verifier output contract unchanged → UI and downstream nodes unaffected.
