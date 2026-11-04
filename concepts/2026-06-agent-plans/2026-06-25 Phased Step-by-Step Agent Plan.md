# Phased Step-by-Step Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the claude-style-agent's single-node "plan-is-decorative" loop with a genuine **plan → execute-each-task → compose → adversarially-verify** pipeline, so each subtask runs as its own auditable step with real status transitions, and the answer is composed last.

**Architecture:** Author a new EXTERNAL workflow that uses the existing `planner` node (which decomposes the task and executes each subtask as its own node in a materialized sub-workflow, bubbling up per-task results/citations/step-logs) followed by a top-level `synthesize` node (composes the report from `_taskResults`) and the existing adversarial `verifier` loop. On a non-pass, route back to the planner to re-plan the gaps (reusing the planner's round-aware re-planning), not to a single-node rewrite. Inbox lifecycle stays explicit (`inbox-load` / `inbox-finalize`).

**Tech Stack:** Node.js (ESM) workflow engine; existing executors `PlannerNodeExecutor`, `LoopNodeExecutor` (drain), `SubWorkflowMaterializer`, `VerifierNodeExecutor`, `PromptNodeExecutor`; plain-node test suites under `server/tests/*.test.js`; workflow JSON under `contents/workflows/`.

## Global Constraints

- Tests are plain-node (`node server/tests/x.test.js`), NOT jest — anything importing `uuid` must run this way. Each suite prints `✅ all passed` / `❌ N failed` and `process.exit`s non-zero on failure.
- Lint must stay at **0 errors** (`npx eslint <files>`); pre-existing warnings are acceptable.
- Audit state must stay bounded: per-round history holds LIGHT summaries only (no `messages`, no full `output`), full transcript kept as one copy in `_stepLogs[nodeId]` — see `BaseNodeExecutor.buildStepLogUpdates` / `_summarizeStepLogForHistory` (already implemented). Any new per-iteration state MUST follow this rule.
- The claude-style-agent uses an EXTERNAL workflow (`profile.workflow.ref:'external'`). Profile flags (`planner.enabled`, `synthesizer.enabled`, `review.enabled`) are IGNORED for external workflows — the workflow JSON is the sole source of truth. Resources (tools) and per-node models must be wired explicitly in the workflow JSON (or via `profile.nodeModels`).
- Model resolution precedence (do not regress): node `config.modelId` → `workflow.config.defaultModelId` (= `profile.preferredModel`, set in `runs.js`) → global default. Verifier honors this via `VerifierNodeExecutor.resolveModel`.
- Node `type` strings that exist: `start`, `end`, `prompt`, `planner`, `loop`, `verifier`, `inbox-load`, `inbox-finalize` (+ others). Use these verbatim.

---

## File Structure

- `contents/workflows/claude-style-agent-phased.json` — NEW external phased workflow (the deliverable users run). Keeps the current `claude-style-agent.json` untouched so we can A/B.
- `server/services/workflow/executors/VerifierNodeExecutor.js` — MODIFY: on a conclusive non-pass that routes `retry`, also advance `_reviewRound` so a downstream `planner` re-plans the gaps (the planner already reads `_reviewRound` + `_lastReviewGaps`).
- `server/agents/profile/profileWorkflowSerializer.js` — REFERENCE ONLY: source of the canonical planner/synthesizer/reviewer node configs to copy into the external JSON. Do not change.
- `contents/agents/profiles/claude-style-agent.json` — MODIFY (optional, gated): point `workflow.workflowId` at the phased workflow, set `planner`/`synthesizer` resource hints via `nodeModels` if desired.
- `server/tests/agent-phased-workflow.test.js` — NEW: schema-validates the phased workflow + asserts the graph (planner→synthesize→verify→{pass:inbox-finalize|retry:planner}) and that the planner node carries a `taskTemplate` with the search tools.
- `server/tests/agent-verifier-replan.test.js` — NEW: unit test that a conclusive retry advances `_reviewRound` and preserves `_lastReviewGaps`.
- `server/tests/claude-style-agent-profile.test.js` — MODIFY (only if the profile is switched): update the workflowId assertion.

---

## Task 1: Verifier advances the review round on a retry (enables planner re-planning)

**Why:** The planner re-plans gaps only when `state.data._reviewRound` increments and `_lastReviewGaps` is set (`PlannerNodeExecutor.js:125-127, 616-646`). The verifier already sets `_lastReviewGaps` on a conclusive fail but does NOT touch `_reviewRound`. Without this, routing `verify --retry--> planner` would make the planner think it's round 0 and re-plan from scratch.

**Files:**
- Modify: `server/services/workflow/executors/VerifierNodeExecutor.js` (the `needsRevision` branch of `execute`, where `stateUpdates._lastReviewGaps` is set)
- Test: `server/tests/agent-verifier-replan.test.js`

**Interfaces:**
- Consumes: `VerifierNodeExecutor.interpretResult` (returns `{passed, conclusive, failures, feedback, verdict}`), the existing `needsRevision = !passed && conclusive` flag, and `state.data._reviewRound` (number | undefined).
- Produces: on a conclusive retry, `stateUpdates._reviewRound = (state.data._reviewRound ?? 0) + 1` alongside the existing `_lastReviewGaps`.

- [ ] **Step 1: Write the failing test**

```js
// server/tests/agent-verifier-replan.test.js
import { VerifierNodeExecutor } from '../services/workflow/executors/VerifierNodeExecutor.js';
let failures = 0;
function check(l, c, d) { if (!c) failures++; console.log(`${c ? '✅' : '❌'} ${l}`); if (!c && d) console.log('   ' + d); }
async function run() {
  const v = new VerifierNodeExecutor();
  // interpretResult is pure; assert a conclusive FAIL-with-gaps is a retry.
  const r = v.interpretResult({ verdict: 'FAIL', failures: ['Wrong date for X'] }, { mode: 'adversarial' });
  check('conclusive FAIL with gaps', r.conclusive === true && r.passed === false);
  // The execute() retry path is covered by the existing adversarial suite; here
  // we assert the helper that builds the replan state updates.
  const upd = v.buildReplanUpdates({ data: { _reviewRound: 1 } }, ['Wrong date for X']);
  check('advances the review round', upd._reviewRound === 2);
  check('carries the gaps for the planner', JSON.stringify(upd._lastReviewGaps) === JSON.stringify(['Wrong date for X']));
  const first = v.buildReplanUpdates({ data: {} }, ['g']);
  check('first retry → round 1', first._reviewRound === 1);
  console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
  process.exit(failures ? 1 : 0);
}
run().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run it; expect FAIL** — `node server/tests/agent-verifier-replan.test.js` → `buildReplanUpdates is not a function`.

- [ ] **Step 3: Add the helper + wire it in `execute`'s `needsRevision` branch**

```js
// VerifierNodeExecutor — add method:
buildReplanUpdates(state, gaps) {
  const round = (typeof state?.data?._reviewRound === 'number' ? state.data._reviewRound : 0) + 1;
  return { _reviewRound: round, _lastReviewGaps: Array.isArray(gaps) ? gaps : [] };
}
```

In `execute`, replace the existing `if (needsRevision) { ... stateUpdates._lastReviewGaps = gaps ... }` body so it ALSO merges the round bump:

```js
if (needsRevision) {
  const gaps = failures.length ? failures : feedback ? [feedback] : [];
  Object.assign(stateUpdates, this.buildReplanUpdates(state, gaps));
  // (existing stall/gap-count tracking stays as-is)
  const gapCount = gaps.length;
  const prevGapCount = state.data?.[gapCountKey];
  const improved = typeof prevGapCount !== 'number' || gapCount < prevGapCount;
  stateUpdates[gapCountKey] = gapCount;
  stateUpdates[stallKey] = improved ? 0 : currentStall + 1;
}
```

- [ ] **Step 4: Run it; expect PASS** — `node server/tests/agent-verifier-replan.test.js`.

- [ ] **Step 5: Run the existing verifier suite to confirm no regression** — `node server/tests/agent-adversarial-verifier.test.js` → `✅ all passed`.

- [ ] **Step 6: Commit** — `git add server/services/workflow/executors/VerifierNodeExecutor.js server/tests/agent-verifier-replan.test.js && git commit -m "feat(agent): verifier advances review round on retry to drive planner re-planning"`

---

## Task 2: Author the external phased workflow

**Why:** This is the actual step-by-step pipeline. The `planner` node decomposes the inbox item and executes each subtask as its own node (per-task `_stepLogs`/`_taskResults`/`_taskTimings` bubble up automatically — genuine auditability), `synthesize` composes `draft` last, `verify` adversarially checks it, and a non-pass routes back to `planner` (now round-aware via Task 1).

**Files:**
- Create: `contents/workflows/claude-style-agent-phased.json`
- Test: `server/tests/agent-phased-workflow.test.js`

**Interfaces:**
- Consumes: `inbox-load` writes `currentInboxItem`; `planner` reads `config.goal` (supports `${$.data.currentInboxItem.text}`), `config.taskTemplate` (`{tools, maxIterations, system}`), `config.maxTasks`, `config.synthesize`, and writes `_taskResults`/`_citations`/`planCreated`; `synthesize` (a `prompt` node with `_isSynthesizer:true`) reads `{{previousTaskResults}}`+`{{citations}}` and writes its `outputVariable`; `verifier` reads `config.inputVariable` and emits `branch` `pass`/`retry`/(terminal `end`).
- Produces: a schema-valid workflow whose `verify` pass-branch → `inbox-finalize` → `end`, and retry-branch → `planner`.

- [ ] **Step 1: Write the failing test** (graph + schema assertions)

```js
// server/tests/agent-phased-workflow.test.js
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { workflowConfigSchema } from '../validators/workflowConfigSchema.js';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let failures = 0;
function check(l, c, d) { if (!c) failures++; console.log(`${c ? '✅' : '❌'} ${l}`); if (!c && d) console.log('   ' + d); }
async function run() {
  const wf = JSON.parse(readFileSync(path.join(root, 'contents/workflows/claude-style-agent-phased.json'), 'utf8'));
  check('schema-valid', workflowConfigSchema.safeParse(wf).success, JSON.stringify(workflowConfigSchema.safeParse(wf).error?.issues?.slice(0,3)));
  const byId = Object.fromEntries(wf.nodes.map(n => [n.id, n]));
  check('has inbox-load', byId['inbox-load']?.type === 'inbox-load');
  check('has planner', byId['planner']?.type === 'planner');
  check('planner has a taskTemplate with search tools', Array.isArray(byId['planner']?.config?.taskTemplate?.tools) && byId['planner'].config.taskTemplate.tools.includes('braveSearch'));
  check('has synthesize (prompt, _isSynthesizer)', byId['synthesize']?.type === 'prompt' && byId['synthesize']?.config?._isSynthesizer === true);
  check('synthesize writes draft', byId['synthesize']?.config?.outputVariable === 'draft');
  check('has adversarial verifier over draft', byId['verify']?.type === 'verifier' && byId['verify']?.config?.mode === 'adversarial' && byId['verify']?.config?.inputVariable === 'draft');
  check('has inbox-finalize', byId['inbox-finalize']?.type === 'inbox-finalize');
  const e = (s, t) => wf.edges.find(x => x.source === s && x.target === t);
  check('start→inbox-load', !!e('start', 'inbox-load'));
  check('inbox-load→planner', !!e('inbox-load', 'planner'));
  check('planner→synthesize', !!e('planner', 'synthesize'));
  check('synthesize→verify', !!e('synthesize', 'verify'));
  check('verify pass→inbox-finalize', e('verify', 'inbox-finalize')?.condition?.value === 'pass');
  check('verify retry→planner (re-plan gaps)', e('verify', 'planner')?.condition?.value === 'retry');
  check('inbox-finalize→end', !!e('inbox-finalize', 'end'));
  check('cycles allowed', wf.config?.allowCycles === true);
  console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
  process.exit(failures ? 1 : 0);
}
run().catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run it; expect FAIL** — file does not exist yet.

- [ ] **Step 3: Create the workflow** (`contents/workflows/claude-style-agent-phased.json`). Copy the planner/synthesizer prompt text from `profileWorkflowSerializer.js` `DEFAULT_PLANNER_SYSTEM` / `DEFAULT_PLANNER_GOAL` / `DEFAULT_SYNTHESIZER_SYSTEM` / `DEFAULT_SYNTHESIZER_PROMPT` so behavior matches the proven embedded path.

```json
{
  "id": "claude-style-agent-phased",
  "name": { "en": "Claude-style Agent (Phased)", "de": "Claude-artiger Agent (phasenweise)" },
  "version": "1.0.0",
  "enabled": false,
  "config": { "maxIterations": 14, "allowCycles": true, "maxExecutionTime": 1800000, "persistence": "session", "errorHandling": "fail" },
  "allowedGroups": [],
  "nodes": [
    { "id": "start", "type": "start", "name": { "en": "Start", "de": "Start" }, "position": { "x": 100, "y": 80 }, "config": { "inputVariables": [{ "name": "task", "type": "string", "required": false }] } },
    { "id": "inbox-load", "type": "inbox-load", "name": { "en": "Load Inbox Item", "de": "Posteingang laden" }, "position": { "x": 100, "y": 200 }, "config": {} },
    { "id": "planner", "type": "planner", "name": { "en": "Plan & Execute Steps", "de": "Planen & Schritte ausführen" }, "position": { "x": 100, "y": 320 }, "config": {
        "goal": "Accomplish this task by decomposing it into concrete, ordered research/work steps, then executing each: ${$.data.currentInboxItem.text}",
        "maxTasks": 6,
        "synthesize": false,
        "system": "<<copy DEFAULT_PLANNER_SYSTEM from profileWorkflowSerializer.js>>",
        "taskTemplate": { "tools": ["braveSearch", "webContentExtractor"], "maxIterations": 8, "system": "You are executing ONE step of a larger plan. Do the step thoroughly using your tools; cite every factual claim with a source URL. Return the step's findings." }
      } },
    { "id": "synthesize", "type": "prompt", "name": { "en": "Compose Report", "de": "Bericht verfassen" }, "position": { "x": 100, "y": 440 }, "config": {
        "_isSynthesizer": true,
        "outputVariable": "draft",
        "_persistAsArtifact": true,
        "maxIterations": 1,
        "system": "<<copy DEFAULT_SYNTHESIZER_SYSTEM>>",
        "prompt": "<<copy DEFAULT_SYNTHESIZER_PROMPT — renders {{previousTaskResults}} + {{citations}} + the task>>{{#if verificationResult.feedback}}\n\nA previous review did NOT pass. Address every gap, keeping correct content:\n{{verificationResult.feedback}}{{/if}}"
      } },
    { "id": "verify", "type": "verifier", "name": { "en": "Adversarial Verify", "de": "Adversariale Prüfung" }, "position": { "x": 100, "y": 560 }, "config": {
        "mode": "adversarial", "tools": ["braveSearch", "webContentExtractor"], "maxToolRounds": 6, "maxRetries": 4, "stallLimit": 2, "inputVariable": "draft",
        "criteria": "The report must fully accomplish the task, support every factual claim with a verifiable source, and contain no unsupported or outdated claims. Try to break it: probe dates, roles, and attributions against sources."
      } },
    { "id": "inbox-finalize", "type": "inbox-finalize", "name": { "en": "Mark Inbox Done", "de": "Posteingang abschließen" }, "position": { "x": 100, "y": 680 }, "config": {} },
    { "id": "end", "type": "end", "name": { "en": "Done", "de": "Fertig" }, "position": { "x": 100, "y": 800 }, "config": { "outputVariables": ["draft", "currentInboxItem"] } }
  ],
  "edges": [
    { "id": "e1", "source": "start", "target": "inbox-load" },
    { "id": "e2", "source": "inbox-load", "target": "planner" },
    { "id": "e3", "source": "planner", "target": "synthesize" },
    { "id": "e4", "source": "synthesize", "target": "verify" },
    { "id": "e5", "source": "verify", "target": "inbox-finalize", "condition": { "type": "equals", "field": "result.branch", "value": "pass" } },
    { "id": "e6", "source": "verify", "target": "planner", "condition": { "type": "equals", "field": "result.branch", "value": "retry" } },
    { "id": "e7", "source": "inbox-finalize", "target": "end" }
  ]
}
```

- [ ] **Step 4: Run it; expect PASS** — `node server/tests/agent-phased-workflow.test.js`. If schema fails on node types, confirm `planner` is in `workflowConfigSchema` `nodeTypeEnum` (it is) and `synthesize` is type `prompt` (not a `synthesize` type).

- [ ] **Step 5: Commit** — `git add contents/workflows/claude-style-agent-phased.json server/tests/agent-phased-workflow.test.js && git commit -m "feat(agent): phased plan→execute→compose→verify external workflow"`

---

## Task 3: Confirm per-task auditability survives the loop (integration assertion)

**Why:** The whole point of phased execution is that each subtask is its own auditable step. The planner's sub-workflow tasks write `_taskResults[taskId]` and per-task `_stepLogs[taskId]`. Task 1's `_reviewRound` re-planning prefixes new-round task ids with `r{round}_` (`PlannerNodeExecutor.js:233-258`), so re-plan rounds don't overwrite earlier task logs. Assert that contract with a focused test so a future refactor can't silently regress it.

**Files:**
- Test: `server/tests/agent-phased-audit.test.js`

**Interfaces:**
- Consumes: `PlannerNodeExecutor`'s task-id namespacing (round prefix) — pure-testable via the id-builder if exposed, else assert the documented behavior via a small state fixture.

- [ ] **Step 1: Write the test** — assert that two review rounds produce DISTINCT task-log keys (round 0 ids vs `r1_` ids), so `_stepLogs` / `_taskResults` from round 0 are not overwritten by round 1.

```js
// Pseudocode of the assertion (adapt to the actual id-builder once located):
// const ids0 = planner.buildTaskIds(plan, { reviewRound: 0 }); // e.g. ['task_a','task_b']
// const ids1 = planner.buildTaskIds(plan, { reviewRound: 1 }); // e.g. ['r1_task_a', ...]
// check('round 1 task ids are namespaced', ids1.every(id => id.startsWith('r1_')));
// check('no overlap with round 0', ids0.every(id => !ids1.includes(id)));
```

- [ ] **Step 2: If the id-builder is private, extract a pure `namespaceTaskId(id, reviewRound)` helper in PlannerNodeExecutor and test it directly** (TDD: failing test → extract → pass).

- [ ] **Step 3: Run + Commit** — `node server/tests/agent-phased-audit.test.js`; commit.

---

## Task 4: Wire the profile to the phased workflow (gated rollout)

**Files:**
- Modify: `contents/agents/profiles/claude-style-agent.json`
- Modify (if profile switched): `server/tests/claude-style-agent-profile.test.js`

**Interfaces:**
- Consumes: `runs.js` external resolution (`workflow.ref:'external'` + `workflow.workflowId`), `workflow.config.defaultModelId` from `preferredModel`, `applyNodeModels`.

- [ ] **Step 1:** Add a second profile (e.g. `claude-style-agent-phased.json`) OR flip the existing profile's `workflow.workflowId` to `claude-style-agent-phased`. Recommended: NEW profile so the single-node version stays runnable for comparison.
- [ ] **Step 2:** Set `nodeModels` so the costly steps use the right model, e.g. `{ "planner": "gemini-3.0-flash", "synthesize": "gemini-3.0-flash", "verify": "claude-4-sonnet" }` (stronger verifier).
- [ ] **Step 3:** Schema-validate the profile (`agentProfileSchema.safeParse`) via the profile test; assert `workflow.workflowId === 'claude-style-agent-phased'`.
- [ ] **Step 4: Commit.**

---

## Task 5: Live validation + comparison

**Files:** none (operational).

- [ ] **Step 1:** Restart backend, reload config. Run the phased profile on the "ausführlicher Bericht über Daniel Manzke" inbox item.
- [ ] **Step 2:** In `/admin/agents/runs/:id`, confirm: each planner subtask appears as its OWN step with its own status/timing/transcript; `synthesize` runs last; `verify` loops with the round timeline; on pass, tasks are done + inbox finalized.
- [ ] **Step 3:** Confirm the audit trail shows the per-task work (not just the final round) and that state size stays bounded (history entries are light per the global constraint).
- [ ] **Step 4:** Compare quality/auditability against the single-node `claude-style-agent`. Decide which becomes the default.

---

## Open design decisions (resolve during Task 2/4)

1. **Retry target — planner vs synthesize.** This plan routes `verify --retry--> planner` (re-research gaps) because the observed failures were factual (wrong dates/roles) that need fresh evidence. Alternative: `--retry--> synthesize` (recompose from existing `_taskResults`) is cheaper but can't fix missing evidence. If re-planning proves too expensive, add a decision node that routes to `synthesize` for "composition" gaps and `planner` for "evidence" gaps.
2. **Synthesizer inside the planner sub-workflow vs top-level.** This plan uses a TOP-LEVEL `synthesize` (so `verify` can re-run it). Keep `planner.config.synthesize:false` to avoid a redundant sub-workflow synthesizer.
3. **Per-task live status.** The drain/sub-workflow path already emits per-task `workflow.node.start/complete` events; confirm the run-detail page renders planner-task rows live (it has `planTasks` handling). If not, that's a small UI follow-up, not a blocker.

## Self-Review notes

- Spec coverage: step-by-step execution (Task 2 planner), per-task update/status (planner sub-workflow + drain), auditability (Task 3 + bounded history already shipped), compose-last (top-level synthesize), verify+converge (Task 1 + verify retry→planner). Covered.
- The only NEW code is Task 1 (verifier round bump) + Task 3 helper extraction; everything else is configuration (workflow JSON) reusing proven executors.
- Type consistency: `synthesize` is a `prompt` node with `_isSynthesizer:true` (matches `PromptNodeExecutor` detection), NOT a `synthesize` node type. `verify` branch values are `pass`/`retry` (match `VerifierNodeExecutor`).
