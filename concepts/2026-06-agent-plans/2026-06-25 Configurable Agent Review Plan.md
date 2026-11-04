# Configurable Agent Review Behavior — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let operators configure per-agent review strictness (lenient/balanced/strict + overrides) and iteration budget, surfaced in the admin UI, plus stop the planner emitting a redundant final-report task.

**Architecture:** A pure preset resolver maps `profile.review.strictness` (+ optional `maxRounds`/`stallLimit`/`criteria` overrides) to concrete verifier knobs. At agent-run start these are injected onto the `verifier` node's config and published into durable run state (`_agentReviewConfig`) — the same pattern as `applyNodeModels`/`_agentModelConfig`, required because external workflows ignore profile flags. The VerifierNodeExecutor gates acceptance on those knobs. The admin profile editor gains strictness + advanced fields.

**Tech Stack:** Node.js (ESM) workflow engine, Zod schemas, React admin UI, plain-node test suites under `server/tests/*.test.js`.

## Global Constraints

- Tests are plain-node (`node server/tests/x.test.js`), NOT jest — each prints `✅ all passed` / `❌ N failed` and `process.exit`s non-zero on failure.
- Lint must stay at **0 errors** (`npx eslint <files>`); pre-existing warnings are acceptable.
- The verifier's output contract is UNCHANGED: verdicts stay PASS/FAIL/PARTIAL/INCONCLUSIVE; branch values stay `pass`/`retry`/`end`. No per-gap severity, no new verdict types.
- `balanced` is the default and must reproduce today's behavior: `maxRetries 4`, `stallLimit 2`, accept PARTIAL after stall.
- External workflows ignore profile flags — per-node config must be injected at run start (runs.js), not assumed from the profile. Durable values go in run state (survives the config-cache TTL refresh).
- `contents/` is gitignored: the phased workflow + profile JSON live on disk only; `git add contents/...` is a no-op (do NOT use `-f`). Only commit tracked files.

## Preset → knobs (authoritative)

| strictness | acceptPartial | acceptPartialAfterStall | requirePass | maxRetries | stallLimit |
|---|---|---|---|---|---|
| lenient | true | true | false | 2 | 1 |
| balanced | false | true | false | 4 | 2 |
| strict | false | false | true | 6 | 2 |

Overrides (`review.maxRounds` → maxRetries, `review.stallLimit`, `review.criteria`) win over the preset when defined.

---

## File Structure

- `server/agents/profile/reviewSettings.js` — NEW. `REVIEW_PRESETS` + pure `resolveReviewSettings(review)`.
- `server/validators/agentProfileSchema.js` — MODIFY `reviewSchema`: add `strictness`, `stallLimit`, `criteria`; raise `maxRounds` max to 10 and drop its `.default(3)`.
- `server/agents/profile/profileWorkflowSerializer.js` — MODIFY: the one read of `review.maxRounds` must fall back to `?? 3` now that the schema default is gone. Also update `DEFAULT_PLANNER_SYSTEM` (planner no-final-report rule).
- `server/services/workflow/executors/VerifierNodeExecutor.js` — MODIFY: acceptance gating from injected knobs (config, fallback to `state.data._agentReviewConfig`).
- `server/routes/agents/runs.js` — MODIFY: inject resolved review settings onto the verifier node config + `initialData._agentReviewConfig` (start path) and the resume path.
- `server/services/workflow/executors/PlannerNodeExecutor.js` — MODIFY `DEFAULT_PLANNER_SYSTEM` (planner no-final-report rule), if the canonical constant lives here rather than the serializer (verify which; update whichever holds it).
- `client/src/features/admin/pages/AdminAgentEditPage.jsx` — MODIFY: add strictness select + stall-limit number + acceptance-criteria textarea to the existing review Section; `handleReview` already exists.
- `contents/workflows/claude-style-agent-phased.json` — MODIFY (gitignored): planner `system` no-final-report rule.
- `contents/agents/profiles/claude-style-agent-phased.json` — MODIFY (gitignored): add a `review` block for live testing.
- Tests: `server/tests/agent-review-settings.test.js` (NEW), extend `server/tests/agent-adversarial-verifier.test.js`, `server/tests/agent-planner-no-final-report.test.js` (NEW).

---

## Task 1: Preset resolver + schema extension

**Files:**
- Create: `server/agents/profile/reviewSettings.js`
- Modify: `server/validators/agentProfileSchema.js` (the `reviewSchema` object, currently ~line 121)
- Modify: `server/agents/profile/profileWorkflowSerializer.js` (the `review.maxRounds` read — grep for `review?.maxRounds` / `review.maxRounds`)
- Test: `server/tests/agent-review-settings.test.js`

**Interfaces:**
- Produces: `REVIEW_PRESETS` (object keyed by `lenient|balanced|strict`) and `resolveReviewSettings(review)` → `{ strictness, acceptPartial, acceptPartialAfterStall, requirePass, maxRetries, stallLimit, criteria }` (criteria is `undefined` when not overridden). Consumed by Task 3 (runs.js) and indirectly by Task 2 (verifier reads the resulting knobs).

- [ ] **Step 1: Write the failing test**

```js
// server/tests/agent-review-settings.test.js
import { resolveReviewSettings, REVIEW_PRESETS } from '../agents/profile/reviewSettings.js';
let failures = 0;
function check(l, c, d) { if (!c) failures++; console.log(`${c ? '✅' : '❌'} ${l}`); if (!c && d) console.log('   ' + d); }
function run() {
  // Defaults: no review block → balanced (today's behavior).
  const bal = resolveReviewSettings(undefined);
  check('default → balanced', bal.strictness === 'balanced');
  check('balanced maxRetries 4', bal.maxRetries === 4, JSON.stringify(bal));
  check('balanced stallLimit 2', bal.stallLimit === 2);
  check('balanced accepts partial after stall, not immediately',
    bal.acceptPartial === false && bal.acceptPartialAfterStall === true && bal.requirePass === false);

  const len = resolveReviewSettings({ strictness: 'lenient' });
  check('lenient maxRetries 2 / stall 1', len.maxRetries === 2 && len.stallLimit === 1);
  check('lenient accepts partial immediately', len.acceptPartial === true && len.requirePass === false);

  const strict = resolveReviewSettings({ strictness: 'strict' });
  check('strict maxRetries 6 / stall 2', strict.maxRetries === 6 && strict.stallLimit === 2);
  check('strict requires pass', strict.requirePass === true && strict.acceptPartial === false && strict.acceptPartialAfterStall === false);

  // Overrides win when defined.
  const ov = resolveReviewSettings({ strictness: 'strict', maxRounds: 8, stallLimit: 3, criteria: 'be lenient on citations' });
  check('maxRounds override → maxRetries', ov.maxRetries === 8);
  check('stallLimit override', ov.stallLimit === 3);
  check('criteria override carried', ov.criteria === 'be lenient on citations');

  // Unset overrides do NOT clobber the preset.
  const noov = resolveReviewSettings({ strictness: 'lenient' });
  check('no maxRounds override → preset value', noov.maxRetries === 2);
  check('criteria undefined when unset', noov.criteria === undefined);

  console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
  process.exit(failures ? 1 : 0);
}
run();
```

- [ ] **Step 2: Run it; expect FAIL** — `node server/tests/agent-review-settings.test.js` → `Cannot find module '../agents/profile/reviewSettings.js'`.

- [ ] **Step 3: Create the resolver**

```js
// server/agents/profile/reviewSettings.js
/**
 * Preset strictness → concrete verifier knobs. Pure; see the design doc
 * docs/superpowers/specs/2026-06-25-configurable-agent-review-design.md.
 */
export const REVIEW_PRESETS = {
  lenient:  { acceptPartial: true,  acceptPartialAfterStall: true,  requirePass: false, maxRetries: 2, stallLimit: 1 },
  balanced: { acceptPartial: false, acceptPartialAfterStall: true,  requirePass: false, maxRetries: 4, stallLimit: 2 },
  strict:   { acceptPartial: false, acceptPartialAfterStall: false, requirePass: true,  maxRetries: 6, stallLimit: 2 }
};

/**
 * Resolve a profile's `review` block into verifier knobs.
 * @param {Object} [review] - profile.review ({ strictness, maxRounds, stallLimit, criteria })
 * @returns {{strictness:string, acceptPartial:boolean, acceptPartialAfterStall:boolean, requirePass:boolean, maxRetries:number, stallLimit:number, criteria?:string}}
 */
export function resolveReviewSettings(review) {
  const strictness = REVIEW_PRESETS[review?.strictness] ? review.strictness : 'balanced';
  const preset = REVIEW_PRESETS[strictness];
  const out = { strictness, ...preset };
  if (typeof review?.maxRounds === 'number') out.maxRetries = review.maxRounds;
  if (typeof review?.stallLimit === 'number') out.stallLimit = review.stallLimit;
  if (typeof review?.criteria === 'string' && review.criteria.trim()) out.criteria = review.criteria.trim();
  return out;
}

export default { REVIEW_PRESETS, resolveReviewSettings };
```

- [ ] **Step 4: Extend `reviewSchema` in `server/validators/agentProfileSchema.js`**

Replace the existing `reviewSchema` object's field list with (keep the leading comment):

```js
const reviewSchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    // Strictness preset for the adversarial review acceptance bar + round budget.
    // See server/agents/profile/reviewSettings.js. Applies to agent runs via
    // run-start injection onto the verifier node.
    strictness: z.enum(['lenient', 'balanced', 'strict']).optional().default('balanced'),
    // Round budget. Optional (NO default) so an unset value means "use the
    // strictness preset"; when set it overrides the preset's maxRetries.
    maxRounds: z.number().int().min(1).max(10).optional(),
    // Optional override of the preset's stall limit.
    stallLimit: z.number().int().min(1).max(5).optional(),
    // Optional free-text acceptance criteria; overrides the verify node's
    // criteria prompt for this agent.
    criteria: z.string().optional(),
    modelId: z.string().optional(),
    system: optionalLocalizedStringSchema.optional()
  })
  .strict();
```

- [ ] **Step 5: Fix the serializer's `maxRounds` read (default removed)**

In `server/agents/profile/profileWorkflowSerializer.js`, find the read of `review.maxRounds` (grep `maxRounds`). Ensure it tolerates `undefined`:

```js
// before: const maxRounds = profile.review?.maxRounds;  // could now be undefined
const maxRounds = profile.review?.maxRounds ?? 3;
```

(If multiple reads exist, apply `?? 3` to each.)

- [ ] **Step 6: Run it; expect PASS** — `node server/tests/agent-review-settings.test.js` → `✅ all passed`.

- [ ] **Step 7: Schema smoke + lint** — `node -e "import('./server/validators/agentProfileSchema.js').then(m=>{const r=m.agentProfileSchema.safeParse({id:'x',name:{en:'X'},review:{strictness:'strict',maxRounds:6}}); console.log('schema ok:', r.success, r.error?.issues?.[0])})"` → `schema ok: true`. Then `npx eslint server/agents/profile/reviewSettings.js server/validators/agentProfileSchema.js server/agents/profile/profileWorkflowSerializer.js server/tests/agent-review-settings.test.js` → 0 errors.

- [ ] **Step 8: Commit** — `git add server/agents/profile/reviewSettings.js server/validators/agentProfileSchema.js server/agents/profile/profileWorkflowSerializer.js server/tests/agent-review-settings.test.js && git commit -m "feat(agent): review strictness presets resolver + schema"`

---

## Task 2: Verifier acceptance gating

**Why:** The verifier must accept/retry based on the resolved knobs. Today it always retries a conclusive PARTIAL until `maxRetries`/`stallLimit`, then ends not-passed. The knobs change this: lenient accepts PARTIAL immediately; balanced accepts on stall; strict never accepts a PARTIAL.

**Files:**
- Modify: `server/services/workflow/executors/VerifierNodeExecutor.js`
- Test: `server/tests/agent-adversarial-verifier.test.js` (extend)

**Interfaces:**
- Consumes: knobs read from `config` (injected by Task 3) with fallback to `state.data._agentReviewConfig`: `acceptPartial`, `acceptPartialAfterStall`, `requirePass`, `maxRetries`, `stallLimit`. Existing `interpretResult` returns `{passed, conclusive, verdict, failures, feedback}`.
- Produces: a new pure helper `resolveAcceptance({verdict, passed, conclusive, stalled, knobs})` → `{ accept: boolean }` used inside `execute`, so the decision is unit-testable.

- [ ] **Step 1: Add the failing test (append to `agent-adversarial-verifier.test.js`)**

```js
// --- acceptance gating (configurable strictness) ---
{
  const v = new VerifierNodeExecutor();
  const partial = { verdict: 'PARTIAL', passed: false, conclusive: true };
  // lenient: accept a conclusive PARTIAL immediately
  check('lenient accepts PARTIAL immediately',
    v.resolveAcceptance({ ...partial, stalled: false, knobs: { acceptPartial: true, acceptPartialAfterStall: true, requirePass: false } }).accept === true);
  // balanced: PARTIAL retries until stalled, then accepts
  check('balanced PARTIAL retries before stall',
    v.resolveAcceptance({ ...partial, stalled: false, knobs: { acceptPartial: false, acceptPartialAfterStall: true, requirePass: false } }).accept === false);
  check('balanced PARTIAL accepts on stall',
    v.resolveAcceptance({ ...partial, stalled: true, knobs: { acceptPartial: false, acceptPartialAfterStall: true, requirePass: false } }).accept === true);
  // strict: never accept PARTIAL, even on stall
  check('strict never accepts PARTIAL',
    v.resolveAcceptance({ ...partial, stalled: true, knobs: { acceptPartial: false, acceptPartialAfterStall: false, requirePass: true } }).accept === false);
  // a real PASS always accepts regardless of knobs
  check('PASS always accepts',
    v.resolveAcceptance({ verdict: 'PASS', passed: true, conclusive: true, stalled: false, knobs: { requirePass: true } }).accept === true);
}
```

- [ ] **Step 2: Run it; expect FAIL** — `node server/tests/agent-adversarial-verifier.test.js` → `resolveAcceptance is not a function`.

- [ ] **Step 3: Add the pure helper to `VerifierNodeExecutor`**

```js
/**
 * Decide whether to accept the current draft given the verdict and the
 * resolved review knobs. Pure (no I/O) so it is unit-testable.
 * - PASS always accepts.
 * - requirePass: never accept a non-PASS.
 * - acceptPartial: accept a conclusive PARTIAL immediately.
 * - acceptPartialAfterStall: accept a conclusive PARTIAL once gaps have stalled.
 * @param {{verdict:string, passed:boolean, conclusive:boolean, stalled:boolean, knobs:Object}} args
 * @returns {{accept:boolean}}
 */
resolveAcceptance({ verdict, passed, conclusive, stalled, knobs = {} }) {
  if (passed) return { accept: true };
  if (knobs.requirePass) return { accept: false };
  if (verdict === 'PARTIAL' && conclusive) {
    if (knobs.acceptPartial) return { accept: true };
    if (knobs.acceptPartialAfterStall && stalled) return { accept: true };
  }
  return { accept: false };
}
```

- [ ] **Step 4: Wire it into `execute`**

Near the top of `execute` where `maxRetries`/`stallLimit` are read (~lines 74/118), read the knobs once:

```js
const reviewKnobs = {
  acceptPartial: config.acceptPartial ?? state.data?._agentReviewConfig?.acceptPartial ?? false,
  acceptPartialAfterStall: config.acceptPartialAfterStall ?? state.data?._agentReviewConfig?.acceptPartialAfterStall ?? true,
  requirePass: config.requirePass ?? state.data?._agentReviewConfig?.requirePass ?? false
};
const maxRetries = config.maxRetries ?? state.data?._agentReviewConfig?.maxRetries ?? 3;
const STALL_LIMIT = config.stallLimit ?? state.data?._agentReviewConfig?.stallLimit ?? 2;
```

Two integration points:

(a) After `interpretResult` (where `needsRevision = !passed && conclusive` is computed, ~line 272), replace the `needsRevision`/`branch` computation with acceptance-gated versions. Evaluate immediate acceptance here with `stalled: false` — stall-based acceptance is handled only in the terminal block (b), so do NOT pass a stall flag here (avoids double-handling):

```js
const { accept } = this.resolveAcceptance({ verdict, passed, conclusive, stalled: false, knobs: reviewKnobs });
const needsRevision = !accept && conclusive && !passed;
const branch = needsRevision ? 'retry' : 'pass';
```

(b) In the stall/maxRetries terminal block (~lines 120-153), today both stall and maxRetries produce a terminal not-passed `branch:'end'`. Split them: when the loop stops because of STALL (`currentStall >= STALL_LIMIT`) AND `acceptPartialAfterStall` AND NOT `requirePass`, accept instead — return `passed:true, branch:'pass'` (routes to inbox-finalize) with the preserved draft. When it stops due to `maxRetries` (hard cap), or `requirePass` is set, keep the existing terminal not-passed behavior.

```js
const stalledOut = currentStall >= STALL_LIMIT;
const retriesOut = currentRetries >= maxRetries;
if (stalledOut || retriesOut) {
  const acceptOnStall = stalledOut && reviewKnobs.acceptPartialAfterStall && !reviewKnobs.requirePass;
  if (acceptOnStall) {
    return this.createSuccessResult(
      { passed: true, branch: 'pass', verdict: 'PARTIAL', feedback: 'Accepted after gaps stalled', score: 0.7 },
      { stateUpdates: { verificationResult: { passed: true, verdict: 'PARTIAL', accepted: 'stall' } }, branch: 'pass' }
    );
  }
  // existing terminal not-passed path stays here (branch 'end', draft preserved)
}
```

- [ ] **Step 5: Run it; expect PASS** — `node server/tests/agent-adversarial-verifier.test.js` → `✅ all passed` (the new acceptance checks + all existing checks).

- [ ] **Step 6: Lint** — `npx eslint server/services/workflow/executors/VerifierNodeExecutor.js server/tests/agent-adversarial-verifier.test.js` → 0 errors.

- [ ] **Step 7: Commit** — `git add server/services/workflow/executors/VerifierNodeExecutor.js server/tests/agent-adversarial-verifier.test.js && git commit -m "feat(agent): verifier acceptance gating from review knobs"`

---

## Task 3: Inject review settings at run start (durable)

**Files:**
- Modify: `server/routes/agents/runs.js` (start path ~line 237-244 near `applyNodeModels`; resume path ~line 667-672)
- Test: `server/tests/agent-review-injection.test.js`

**Interfaces:**
- Consumes: `resolveReviewSettings` (Task 1). Produces: a reusable `applyReviewSettings(workflow, resolved)` that sets, on every `verifier`-type node's `config`: `maxRetries`, `stallLimit`, `acceptPartial`, `acceptPartialAfterStall`, `requirePass`, and `criteria` (only when defined); and returns the resolved object so the caller can also stash it in `initialData._agentReviewConfig`.

- [ ] **Step 1: Write the failing test**

```js
// server/tests/agent-review-injection.test.js
import { applyReviewSettings } from '../routes/agents/runs.js';
import { resolveReviewSettings } from '../agents/profile/reviewSettings.js';
let failures = 0;
function check(l, c, d) { if (!c) failures++; console.log(`${c ? '✅' : '❌'} ${l}`); if (!c && d) console.log('   ' + d); }
function run() {
  const wf = { nodes: [
    { id: 'planner', type: 'planner', config: {} },
    { id: 'verify', type: 'verifier', config: { criteria: 'orig' } },
    { id: 'end', type: 'end', config: {} }
  ] };
  const resolved = resolveReviewSettings({ strictness: 'strict' });
  applyReviewSettings(wf, resolved);
  const v = wf.nodes.find(n => n.id === 'verify');
  check('maxRetries injected', v.config.maxRetries === 6, JSON.stringify(v.config));
  check('stallLimit injected', v.config.stallLimit === 2);
  check('requirePass injected', v.config.requirePass === true);
  check('acceptPartial injected false', v.config.acceptPartial === false);
  check('criteria NOT overwritten when no override', v.config.criteria === 'orig');
  // with criteria override
  applyReviewSettings(wf, resolveReviewSettings({ strictness: 'lenient', criteria: 'cites optional' }));
  check('criteria overwritten when override set', wf.nodes.find(n=>n.id==='verify').config.criteria === 'cites optional');
  check('non-verifier nodes untouched', wf.nodes.find(n=>n.id==='planner').config.maxRetries === undefined);
  console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
  process.exit(failures ? 1 : 0);
}
run();
```

- [ ] **Step 2: Run it; expect FAIL** — `node server/tests/agent-review-injection.test.js` → `applyReviewSettings is not a function` (or import error).

- [ ] **Step 3: Add `applyReviewSettings` to `runs.js` and export it** (place next to `applyNodeModels`)

```js
/**
 * Inject resolved review knobs onto every verifier node's config. Mirrors
 * applyNodeModels: external workflows ignore profile flags, so the run-start
 * code wires per-node config. Mutates and returns the workflow.
 * @param {Object} workflow
 * @param {Object} resolved - from resolveReviewSettings()
 */
export function applyReviewSettings(workflow, resolved) {
  if (!workflow || !Array.isArray(workflow.nodes) || !resolved) return workflow;
  for (const node of workflow.nodes) {
    if (node?.type !== 'verifier') continue;
    node.config = {
      ...(node.config || {}),
      maxRetries: resolved.maxRetries,
      stallLimit: resolved.stallLimit,
      acceptPartial: resolved.acceptPartial,
      acceptPartialAfterStall: resolved.acceptPartialAfterStall,
      requirePass: resolved.requirePass,
      ...(resolved.criteria ? { criteria: resolved.criteria } : {})
    };
  }
  return workflow;
}
```

- [ ] **Step 4: Call it + publish durable state at the START path**

In the start path, after `applyNodeModels(workflow, profile.nodeModels);` (~line 244), add:

```js
const resolvedReview = resolveReviewSettings(profile.review);
applyReviewSettings(workflow, resolvedReview);
```

And in the `initialData` object (next to `_agentModelConfig`), add:

```js
_agentReviewConfig: resolvedReview,
```

Import at top of file: `import { resolveReviewSettings } from '../../agents/profile/reviewSettings.js';` (verify the relative path from `server/routes/agents/runs.js`).

- [ ] **Step 5: Mirror at the RESUME path**

After `applyNodeModels(workflow, profile.nodeModels);` in the resume handler (~line 672), add `applyReviewSettings(workflow, resolveReviewSettings(profile.review));`. (Resume reuses existing state, which already holds `_agentReviewConfig` for runs started after this change; injecting onto the node config covers the re-fetched workflow.)

- [ ] **Step 6: Run it; expect PASS** — `node server/tests/agent-review-injection.test.js` → `✅ all passed`.

- [ ] **Step 7: Lint** — `npx eslint server/routes/agents/runs.js server/tests/agent-review-injection.test.js` → 0 errors.

- [ ] **Step 8: Commit** — `git add server/routes/agents/runs.js server/tests/agent-review-injection.test.js && git commit -m "feat(agent): inject review settings onto verifier node + durable state"`

---

## Task 4: Planner stops emitting a final-report task

**Why:** The planner decomposes a redundant "write the final report" task on report-style briefs; the top-level `synthesize` node owns composition. This wastes a task and double-composes.

**Files:**
- Modify: the canonical planner system prompt constant. Grep both `server/agents/profile/profileWorkflowSerializer.js` (`DEFAULT_PLANNER_SYSTEM`) and `server/services/workflow/executors/PlannerNodeExecutor.js` — update whichever defines the constant. (Per the existing handoff it is `DEFAULT_PLANNER_SYSTEM` in profileWorkflowSerializer.js.)
- Modify: `contents/workflows/claude-style-agent-phased.json` (gitignored) — the planner node's `system` carries its own copy; append the same rule.
- Test: `server/tests/agent-planner-no-final-report.test.js`

- [ ] **Step 1: Write the failing test**

```js
// server/tests/agent-planner-no-final-report.test.js
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let failures = 0;
function check(l, c, d) { if (!c) failures++; console.log(`${c ? '✅' : '❌'} ${l}`); if (!c && d) console.log('   ' + d); }
function run() {
  const src = readFileSync(path.join(root, 'server/agents/profile/profileWorkflowSerializer.js'), 'utf8');
  // The DEFAULT_PLANNER_SYSTEM must instruct the planner NOT to emit a final
  // report / synthesis / compile task — the synthesize node owns composition.
  check('canonical planner prompt forbids final-report tasks',
    /do not (emit|create|include).{0,80}(final report|synthesis|compile)/i.test(src) ||
    /synthesize node owns/i.test(src), 'no no-final-report rule found in DEFAULT_PLANNER_SYSTEM');
  console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
  process.exit(failures ? 1 : 0);
}
run();
```

- [ ] **Step 2: Run it; expect FAIL** — `node server/tests/agent-planner-no-final-report.test.js`.

- [ ] **Step 3: Add the rule to `DEFAULT_PLANNER_SYSTEM`** (append to the bullet list, near the existing "DO NOT include workflow plumbing steps" bullet):

```
- DO NOT emit a "write the final report", "compile/assemble the report", "final synthesis", or "assessment write-up" task. Final composition of the report is owned by a separate synthesis step that runs after your plan. Your tasks produce RESEARCH, VERIFICATION, and ANALYSIS findings only — never the final deliverable document itself.
```

- [ ] **Step 4: Mirror the rule into the gitignored phased workflow JSON** — append the same sentence to `contents/workflows/claude-style-agent-phased.json` planner node `config.system`. (Gitignored — on disk only; not committed.)

- [ ] **Step 5: Run it; expect PASS** — `node server/tests/agent-planner-no-final-report.test.js` → `✅ all passed`.

- [ ] **Step 6: Lint + Commit** — `npx eslint server/tests/agent-planner-no-final-report.test.js` (0 errors); `git add server/agents/profile/profileWorkflowSerializer.js server/tests/agent-planner-no-final-report.test.js && git commit -m "feat(agent): planner no longer emits a final-report task"` (JSON change is gitignored; note in commit body).

---

## Task 5: Admin UI — strictness + advanced fields

**Files:**
- Modify: `client/src/features/admin/pages/AdminAgentEditPage.jsx` (the review `<Section>` ~lines 918-1012; `handleReview` already exists at ~line 183; default form state ~line 60)
- Modify: i18n locale files for the new labels (follow how `admin.agents.edit.review*` keys are added — grep an existing key like `admin.agents.edit.reviewMaxRounds` to find the locale JSON).

**Interfaces:**
- Consumes: `profile.review` (`strictness`, `stallLimit`, `criteria`) and `handleReview(partial)`.

- [ ] **Step 1: Add `strictness` to default form state** (~line 60, the `review: {` block): add `strictness: 'balanced',`.

- [ ] **Step 2: Add a strictness `<select>` at the TOP of the review Section's `<div className="space-y-4">`** (before the existing `enabled` checkbox), NOT gated on `planner.enabled` (it applies to external workflows too):

```jsx
<div>
  <label className="block text-sm text-gray-600 dark:text-gray-400">
    {t('admin.agents.edit.reviewStrictness', 'Review strictness')}
  </label>
  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
    {t('admin.agents.edit.reviewStrictnessHint', 'How strict the adversarial review is and how many rounds it runs. Lenient: accept a partial result fast (2 rounds). Balanced: accept once gaps stop shrinking (4 rounds). Strict: require a full pass (6 rounds).')}
  </p>
  <select
    value={profile.review?.strictness || 'balanced'}
    onChange={e => handleReview({ strictness: e.target.value })}
    className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
  >
    <option value="lenient">{t('admin.agents.edit.reviewLenient', 'Lenient')}</option>
    <option value="balanced">{t('admin.agents.edit.reviewBalanced', 'Balanced')}</option>
    <option value="strict">{t('admin.agents.edit.reviewStrict', 'Strict')}</option>
  </select>
</div>
```

- [ ] **Step 3: Add a stall-limit number + criteria textarea** (after the strictness select). These are the "advanced overrides"; empty = use preset:

```jsx
<div>
  <label className="block text-sm text-gray-600 dark:text-gray-400">
    {t('admin.agents.edit.reviewStallLimit', 'Stall limit (advanced, optional)')}
  </label>
  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
    {t('admin.agents.edit.reviewStallLimitHint', 'Stop early after this many rounds with no reduction in gaps. Leave blank to use the strictness preset.')}
  </p>
  <input
    type="number" min="1" max="5"
    value={profile.review?.stallLimit ?? ''}
    onChange={e => handleReview({ stallLimit: e.target.value === '' ? undefined : (Number(e.target.value) || undefined) })}
    className="mt-1 block w-24 rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
  />
</div>
<div>
  <label className="block text-sm text-gray-600 dark:text-gray-400">
    {t('admin.agents.edit.reviewCriteria', 'Acceptance criteria (advanced, optional)')}
  </label>
  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
    {t('admin.agents.edit.reviewCriteriaHint', 'Free-text description of what the reviewer should treat as "good enough" for this agent. Overrides the default review criteria.')}
  </p>
  <textarea
    rows={3}
    value={profile.review?.criteria || ''}
    onChange={e => handleReview({ criteria: e.target.value })}
    className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
  />
</div>
```

- [ ] **Step 4: Relabel the existing `maxRounds` field** so it reads as an optional override (change its label to "Max rounds (advanced, optional)") and change its `value` to `profile.review?.maxRounds ?? ''` and `onChange` to write `undefined` when blank (so unset → preset):

```jsx
value={profile.review?.maxRounds ?? ''}
onChange={e => handleReview({ maxRounds: e.target.value === '' ? undefined : (Number(e.target.value) || undefined) })}
```

(Also raise the input `max` from `5` to `10`.)

- [ ] **Step 5: Clean empty advanced fields on save** — in the save handler's `review` cleanup (~line 287), delete `stallLimit`/`maxRounds`/`criteria` when empty so they don't persist as null:

```js
['maxRounds', 'stallLimit'].forEach(k => { if (payload.review[k] == null || payload.review[k] === '') delete payload.review[k]; });
if (typeof payload.review.criteria === 'string' && !payload.review.criteria.trim()) delete payload.review.criteria;
```

- [ ] **Step 6: Add the i18n keys** to the locale JSON (grep for `"reviewMaxRounds"` to find the file; add `reviewStrictness`, `reviewStrictnessHint`, `reviewLenient`, `reviewBalanced`, `reviewStrict`, `reviewStallLimit`, `reviewStallLimitHint`, `reviewCriteria`, `reviewCriteriaHint` with the English defaults shown above; mirror to `de` if the project requires it — check whether other `admin.agents.edit.*` keys have `de` entries).

- [ ] **Step 7: Lint + build check** — `npx eslint client/src/features/admin/pages/AdminAgentEditPage.jsx` → 0 errors (pre-existing warnings OK). If a client test/build command exists (`npm run lint`), run it.

- [ ] **Step 8: Commit** — `git add client/src/features/admin/pages/AdminAgentEditPage.jsx <locale files> && git commit -m "feat(admin): review strictness + advanced overrides in agent editor"`

---

## Task 6: Live validation (operational — no LLM keys in CI env)

**Files:** none tracked (gitignored profile/workflow edits + manual run).

- [ ] **Step 1:** In `contents/agents/profiles/claude-style-agent-phased.json` add a `review` block, e.g. `{ "strictness": "balanced" }`. Restart backend, reload config.
- [ ] **Step 2:** Run the phased profile; confirm in `/admin/agents/runs/:id` that the verify node honors the round budget (balanced = up to 4 rounds, accepts on stall) and the planner no longer creates a `*final report*`/`*assessment*` task.
- [ ] **Step 3:** Set the profile to `strict` and re-run; confirm it requires a PASS (more rounds, no early partial-accept). Set `lenient`; confirm it accepts the first partial fast.
- [ ] **Step 4:** Confirm models stay Gemini across rounds (no local-vllm) — the durable-model fix should be unaffected.

---

## Self-Review notes

- Spec coverage: strictness presets+override (Task 1), acceptance semantics verdict+rounds (Task 2), external-workflow injection + durable state (Task 3), planner no-final-report (Task 4), admin UI (Task 5), live validation (Task 6). Covered.
- The only behavioral subtlety is Task 2's two integration points (immediate accept vs accept-on-stall); the pure `resolveAcceptance` helper is unit-tested, and the stall-terminal split is described against the existing line ranges. The implementer must read the current `execute` flow before editing — flagged in the task.
- Backward compat: `balanced` defaults reproduce today's `maxRetries 4`/`stallLimit 2`/accept-after-stall; profiles without `review` get `balanced`. Removing `maxRounds`'s schema default is compensated by the serializer `?? 3` fallback (Task 1 Step 5).
- Type consistency: `resolveReviewSettings` output keys (`acceptPartial`, `acceptPartialAfterStall`, `requirePass`, `maxRetries`, `stallLimit`, `criteria`) are used verbatim by `applyReviewSettings` (Task 3) and the verifier knob-read (Task 2).
