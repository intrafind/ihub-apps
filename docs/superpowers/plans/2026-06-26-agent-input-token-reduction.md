# Agent Input-Token Reduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the O(N²) prompt-token blow-up in the agent tool-calling loop by proactively eliding consumed tool-result bodies from the model input — without losing audit data or citations.

**Architecture:** The agent loop (`PromptNodeExecutor.executeLLMWithTools`) re-sends the entire growing `currentMessages` array every iteration and sums `prompt_tokens` across all iterations. Large tool results (web pages up to 30K chars) stay raw in that array and get re-billed each turn. We add **proactive in-loop microcompaction**: after each tool round, when the accumulated message size crosses a threshold, collapse old (already-consumed) tool/assistant bodies into short placeholders while keeping the last few turns verbatim. This reuses the existing, tested `microcompactMessages` machinery, which today only fires reactively on a context-overflow error that never occurs on large-window models. We also clamp the server-side `webContentExtractor` output ceiling so a single fetch can't inject 30K chars.

**Tech Stack:** Node.js ESM, plain-`node` test scripts (custom `check()` harness, no framework), Prettier for formatting.

## Global Constraints

- ES modules only (`import`/`export`); no CommonJS `require` in `server/` source.
- Tests are standalone scripts run with `node server/tests/<name>.test.js`; they self-report and `process.exit(1)` on failure. Use the existing `check(label, cond, details)` harness pattern.
- Run `npx prettier --write` on every changed file before committing; the repo enforces `prettier --check`.
- End commit messages with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Do NOT touch the audit/citation data paths.** `_previewToolValue` (step-log previews) and `_captureCitationsFromToolResult` (`_citations` ledger) must remain unchanged. This plan only mutates the in-flight `currentMessages` array passed to the model.

---

## Analysis: where the tokens go, what to remove, when

**Measured example** (run `wf-exec-7dedfa45`, step `r2_find-primary-lucidworks-critique-source`): `input: 517,189` tokens, `output: 3,961`, 8 iterations, 7 tool calls. The persisted transcript is only ~12K chars — because the step log stores **previews**, while the model received the **full** tool results.

**Root cause** (`PromptNodeExecutor.executeLLMWithTools`):
- `totalTokens.input += deltaIn` sums `prompt_tokens` across **every** iteration (~line 1545).
- Each iteration re-sends all of `currentMessages`; after each tool call the loop does `currentMessages.push(assistantMessage)` then `currentMessages.push(toolResult)` (~lines 1573–1579), so the array grows monotonically.
- Net effect: with N tool rounds, the stable history is re-billed ~N times → O(N²).

**What to remove from the input, and when:**

| Message | Keep raw? | When it's no longer needed in the input |
|---|---|---|
| `system` prompt | Always | never elide |
| `user` task prompt | Always | never elide |
| Last ~6 messages (recent tool rounds) | Always | the model is actively reasoning over them this turn |
| Older `tool` results (raw web/search bodies, >2K chars) | **No — elide** | once the model has produced ≥1 turn after seeing them; the durable value (URLs + snippets) is already saved to `_citations`, and the audit preview is in the step log |
| Older oversized `assistant` content (>2K chars) | **No — elide** | same — superseded by later turns |
| `assistant` tool-call messages (null/short content, `tool_calls`, `thoughtSignatures`) | Keep structure | never drop the message (provider pairing + Gemini thought signatures); only its long *string* content is collapsed, which these don't have |

**Why eliding is safe (audit preserved by construction):**
- Citations: `_captureCitationsFromToolResult` already persists each result's URLs + snippets to the durable `_citations` ledger, independent of `currentMessages`.
- Audit trail: the step log stores `_previewToolValue(result)` previews, independent of `currentMessages`.
- The elision placeholder still carries a 200-char preview, so the model retains a reference and can re-fetch if it genuinely needs the page again.

**Interventions, by ROI:**
1. **Proactive in-loop microcompaction** (Tasks 1–2) — the primary fix. Bounds every prompt after the threshold, directly killing the O(N²) term. Reuses tested code.
2. **Clamp `webContentExtractor` output** (Task 3) — caps the single biggest result source (model requested `maxLength: 30000`; default is 5000). Reduces the raw bytes that enter the loop in the first place.
3. **Gemini context caching** (Phase 2 — separate plan, see end) — caches the stable prefix so it isn't re-billed. Larger, provider-specific; deferred.

---

## File Structure

- **Modify** `server/services/workflow/ContextSummarizer.js` — add a pure `compactIfOversized(messages, opts)` method (threshold-gated wrapper over the existing `microcompactMessages` + `estimateTokens`). Home of all compaction logic.
- **Modify** `server/services/workflow/executors/PromptNodeExecutor.js` — call `compactIfOversized` inside `executeLLMWithTools` after tool results are appended each round.
- **Modify** `server/tools/webContentExtractor.js` — clamp `maxLength` to a server-side ceiling.
- **Test** `server/tests/agent-context-management.test.js` — extend with `compactIfOversized` unit tests (file already covers `microcompactMessages`).
- **Test (new)** `server/tests/agent-loop-proactive-compaction.test.js` — integration test driving `executeLLMWithTools` with a fake LLM helper.
- **Test (new)** `server/tests/web-content-extractor-cap.test.js` — clamp unit test.

---

### Task 1: `ContextSummarizer.compactIfOversized` (threshold-gated compaction)

**Files:**
- Modify: `server/services/workflow/ContextSummarizer.js` (add method near `microcompactMessages`, ~line 155)
- Test: `server/tests/agent-context-management.test.js`

**Interfaces:**
- Consumes: existing `this.microcompactMessages(messages, { keepRecent, maxChars })` and `this.estimateTokens(text)`.
- Produces: `compactIfOversized(messages, opts?) → { messages, freedChars, collapsed, compacted }` where `opts = { thresholdTokens=16000, keepRecent=6, maxChars=2000 }`. Returns `compacted: false` and the original array untouched when estimated tokens ≤ threshold.

- [ ] **Step 1: Write the failing tests**

Add to `server/tests/agent-context-management.test.js` (inside `run()`, after the existing `microcompactMessages` checks):

```javascript
console.log('\n🧪 compactIfOversized\n');
{
  const big = 'x'.repeat(8000); // ~2000 tokens each
  const small = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'task' },
    { role: 'tool', content: 'short result' }
  ];
  const under = cs.compactIfOversized(small, { thresholdTokens: 16000 });
  check('no-op when under threshold', under.compacted === false && under.collapsed === 0);
  check('returns original messages untouched under threshold', under.messages === small);

  const heavy = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'task' },
    { role: 'assistant', content: null, tool_calls: [{ id: 't1' }] },
    { role: 'tool', content: big },
    { role: 'assistant', content: null, tool_calls: [{ id: 't2' }] },
    { role: 'tool', content: big },
    { role: 'assistant', content: null, tool_calls: [{ id: 't3' }] },
    { role: 'tool', content: big },
    { role: 'assistant', content: null, tool_calls: [{ id: 't4' }] },
    { role: 'tool', content: big }
  ];
  const over = cs.compactIfOversized(heavy, { thresholdTokens: 4000, keepRecent: 4 });
  check('compacts when over threshold', over.compacted === true && over.collapsed > 0);
  check('frees characters', over.freedChars > 0);
  check('system prompt never elided', over.messages[0].content === 'sys');
  check('user prompt never elided', over.messages[1].content === 'task');
  check(
    'last keepRecent messages kept verbatim',
    over.messages[over.messages.length - 1].content === big
  );
  check(
    'old tool body elided to placeholder',
    typeof over.messages[3].content === 'string' && over.messages[3].content.includes('elided')
  );
  check(
    'assistant tool_calls structure preserved',
    Array.isArray(over.messages[2].tool_calls) && over.messages[2].tool_calls[0].id === 't1'
  );
  // Idempotent: running again does nothing new (placeholders are now small).
  const again = cs.compactIfOversized(over.messages, { thresholdTokens: 4000, keepRecent: 4 });
  check('idempotent on already-compacted input', again.collapsed === 0);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node server/tests/agent-context-management.test.js`
Expected: FAIL — `cs.compactIfOversized is not a function` (the new checks error/fail).

- [ ] **Step 3: Write minimal implementation**

In `server/services/workflow/ContextSummarizer.js`, add immediately after `microcompactMessages` (after its closing `}` ~line 155):

```javascript
  /**
   * Proactively microcompact a message array WHEN it exceeds a token
   * threshold — the cure for O(N²) prompt growth in a tool-heavy loop on
   * large-window models (where the reactive overflow path never fires).
   *
   * Pure: estimates the current size, and only when it exceeds
   * `thresholdTokens` does it collapse old bulky tool/assistant bodies via
   * `microcompactMessages`. Under the threshold it returns the original array
   * untouched (referential identity preserved) so callers can cheaply detect
   * the no-op. Idempotent: already-collapsed placeholders are below `maxChars`
   * and won't be touched again.
   *
   * @param {Array<Object>} messages
   * @param {Object} [opts]
   * @param {number} [opts.thresholdTokens=16000] - compact only above this size
   * @param {number} [opts.keepRecent=6] - trailing messages kept verbatim
   * @param {number} [opts.maxChars=2000] - collapse bodies longer than this
   * @returns {{ messages: Array<Object>, freedChars: number, collapsed: number, compacted: boolean }}
   */
  compactIfOversized(messages, opts = {}) {
    const thresholdTokens = opts.thresholdTokens ?? 16000;
    const keepRecent = opts.keepRecent ?? 6;
    const maxChars = opts.maxChars ?? 2000;
    if (!Array.isArray(messages) || messages.length === 0) {
      return { messages, freedChars: 0, collapsed: 0, compacted: false };
    }
    const totalText = messages
      .map(m => (typeof m?.content === 'string' ? m.content : ''))
      .join(' ');
    if (this.estimateTokens(totalText) <= thresholdTokens) {
      return { messages, freedChars: 0, collapsed: 0, compacted: false };
    }
    const result = this.microcompactMessages(messages, { keepRecent, maxChars });
    return { ...result, compacted: result.collapsed > 0 };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node server/tests/agent-context-management.test.js`
Expected: PASS — all `compactIfOversized` checks green, existing checks still green.

- [ ] **Step 5: Format and commit**

```bash
cd /Users/danielmanzke/Workspaces/claude-only/ihub/repo/ihub-apps
npx prettier --write server/services/workflow/ContextSummarizer.js server/tests/agent-context-management.test.js
git add server/services/workflow/ContextSummarizer.js server/tests/agent-context-management.test.js
git commit -m "feat(agent): threshold-gated proactive message compaction helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Wire proactive compaction into the agent loop

**Files:**
- Modify: `server/services/workflow/executors/PromptNodeExecutor.js` (inside `executeLLMWithTools`, right after the tool-result append loop ~line 1579)
- Test (new): `server/tests/agent-loop-proactive-compaction.test.js`

**Interfaces:**
- Consumes: `this.contextSummarizer.compactIfOversized(messages, opts)` from Task 1.
- Produces: no new public signature; behavior change only. After each tool round, `currentMessages` is reassigned to the compacted array when oversized.

- [ ] **Step 1: Write the failing test**

Create `server/tests/agent-loop-proactive-compaction.test.js`:

```javascript
#!/usr/bin/env node

/**
 * Integration test: the agent tool-calling loop proactively compacts the
 * in-flight messages between tool rounds, so old large tool results are not
 * re-billed on every subsequent iteration (the O(N²) fix).
 *
 * Run directly: `node server/tests/agent-loop-proactive-compaction.test.js`.
 */

import { PromptNodeExecutor } from '../services/workflow/executors/PromptNodeExecutor.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

// Spy summarizer: records each compactIfOversized call and actually compacts.
let compactCalls = 0;
const executor = new PromptNodeExecutor();
const realCompact = executor.contextSummarizer.compactIfOversized.bind(
  executor.contextSummarizer
);
executor.contextSummarizer.compactIfOversized = (messages, opts) => {
  compactCalls += 1;
  return realCompact(messages, { ...opts, thresholdTokens: 1000, keepRecent: 4 });
};

// Stub tool execution → returns a huge result body each call.
const HUGE = 'y'.repeat(20000);
executor.executeToolCall = async () => ({ role: 'tool', content: HUGE });

// Fake LLM helper: two rounds of tool calls, then a tool-less final answer.
let turn = 0;
executor.llmHelper = {
  verifyApiKey: async () => ({ success: true, apiKey: 'k' }),
  executeStreamingRequest: async ({ messages }) => {
    turn += 1;
    // Record the largest single prompt the model was asked to ingest.
    const promptChars = messages
      .map(m => (typeof m.content === 'string' ? m.content.length : 0))
      .reduce((a, b) => a + b, 0);
    maxPromptChars = Math.max(maxPromptChars, promptChars);
    if (turn <= 2) {
      return {
        content: '',
        toolCalls: [{ id: `c${turn}`, function: { name: 'webContentExtractor', arguments: '{}' } }],
        usage: { prompt_tokens: Math.round(promptChars / 4), completion_tokens: 10 }
      };
    }
    return { content: 'final answer', toolCalls: [], usage: { prompt_tokens: 100, completion_tokens: 10 } };
  }
};
let maxPromptChars = 0;

const model = { id: 'gemini-flash-latest', provider: 'google', maxOutputTokens: 32768 };
const messages = [
  { role: 'system', content: 'You are an agent.' },
  { role: 'user', content: 'Do the task.' }
];

// Verified signature: executeLLMWithTools({ model, messages, tools, config, context, nodeId }).
// apiKey is resolved INTERNALLY via this.llmHelper.verifyApiKey (stubbed above);
// language defaults from context.language || 'en'. No apiKey/language params.
const response = await executor.executeLLMWithTools({
  model,
  messages,
  tools: [{ function: { name: 'webContentExtractor' } }],
  config: {},
  context: {},
  nodeId: 'test'
});

console.log('🧪 proactive compaction in the agent loop\n');
check('loop ran to a final answer', response.content === 'final answer');
check('compactIfOversized called each tool round', compactCalls >= 2, `calls=${compactCalls}`);
check(
  'largest prompt stayed bounded (no full re-send of both 20k results)',
  maxPromptChars < 40000,
  `maxPromptChars=${maxPromptChars}`
);

console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node server/tests/agent-loop-proactive-compaction.test.js`
Expected: FAIL — `compactCalls === 0` (loop doesn't call `compactIfOversized` yet) and/or `maxPromptChars` ≥ 40000 (both 20K results re-sent).

- [ ] **Step 3: Write minimal implementation**

In `server/services/workflow/executors/PromptNodeExecutor.js`, immediately after the tool-result append loop (after the closing `}` of `for (const toolCall of response.toolCalls) { ... currentMessages.push(toolResult); }`, ~line 1579):

```javascript
      // Proactively compact the in-flight history once it grows large, so old
      // (already-consumed) tool-result bodies are not re-billed on every
      // subsequent iteration — the O(N²) prompt-token fix. Citations are
      // already persisted to _citations and the audit preview to the step log,
      // so eliding the raw bodies here loses nothing durable. Reactive
      // overflow recovery (the catch above) remains as a backstop.
      const compaction = this.contextSummarizer.compactIfOversized(currentMessages, {
        thresholdTokens: config.compactThresholdTokens ?? 16000,
        keepRecent: config.compactKeepRecent ?? 6
      });
      if (compaction.compacted) {
        currentMessages = compaction.messages;
        this.logger.info('Proactively compacted agent context', {
          component: 'PromptNodeExecutor',
          nodeId,
          iteration,
          collapsed: compaction.collapsed,
          freedChars: compaction.freedChars
        });
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node server/tests/agent-loop-proactive-compaction.test.js`
Expected: PASS — `compactCalls >= 2` and `maxPromptChars < 40000`.

- [ ] **Step 5: Run the existing context-management + a regression check**

Run: `node server/tests/agent-context-management.test.js`
Expected: PASS (reactive recovery path untouched).

- [ ] **Step 6: Format and commit**

```bash
cd /Users/danielmanzke/Workspaces/claude-only/ihub/repo/ihub-apps
npx prettier --write server/services/workflow/executors/PromptNodeExecutor.js server/tests/agent-loop-proactive-compaction.test.js
git add server/services/workflow/executors/PromptNodeExecutor.js server/tests/agent-loop-proactive-compaction.test.js
git commit -m "feat(agent): proactively compact tool history between rounds

Elides consumed tool-result bodies once the in-flight prompt grows past a
threshold, killing the O(N^2) re-send that drove single steps to 500k+ input
tokens. Audit previews and the citation ledger are untouched.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Clamp `webContentExtractor` output ceiling

**Files:**
- Modify: `server/tools/webContentExtractor.js` (signature ~line 61-67; both truncation points ~line 186 and ~line 345)
- Test (new): `server/tests/web-content-extractor-cap.test.js`

**Interfaces:**
- Produces: a module-level `MAX_CONTENT_CEILING = 10000` and an effective length `Math.min(requestedMaxLength, MAX_CONTENT_CEILING)` used wherever `maxLength` truncates. The model may request more (it asked for 30000), but the tool never returns more than the ceiling.

- [ ] **Step 1: Write the failing test**

Create `server/tests/web-content-extractor-cap.test.js`:

```javascript
#!/usr/bin/env node

/**
 * webContentExtractor must clamp the caller-requested maxLength to a
 * server-side ceiling, so the model can't inject 30k-char page dumps that
 * then get re-billed every agent iteration.
 *
 * Run directly: `node server/tests/web-content-extractor-cap.test.js`.
 */

import { clampMaxLength, MAX_CONTENT_CEILING } from '../tools/webContentExtractor.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

check('ceiling is 10000', MAX_CONTENT_CEILING === 10000);
check('requested 30000 clamped to ceiling', clampMaxLength(30000) === 10000);
check('requested 4000 passes through', clampMaxLength(4000) === 4000);
check('missing/invalid falls back to default 5000', clampMaxLength(undefined) === 5000);
check('zero/negative falls back to default', clampMaxLength(0) === 5000);

console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node server/tests/web-content-extractor-cap.test.js`
Expected: FAIL — `clampMaxLength`/`MAX_CONTENT_CEILING` are not exported.

- [ ] **Step 3: Write minimal implementation**

In `server/tools/webContentExtractor.js`, add near the top (after imports):

```javascript
/**
 * Hard server-side ceiling on returned content length. The model may request
 * a larger `maxLength` (observed: 30000), but a single tool result that large
 * gets re-billed on every subsequent agent iteration. Clamp it.
 */
export const MAX_CONTENT_CEILING = 10000;

/**
 * Resolve the effective maxLength: a valid positive request, clamped to the
 * ceiling; otherwise the 5000 default.
 * @param {number} [requested]
 * @returns {number}
 */
export function clampMaxLength(requested) {
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= 0) return 5000;
  return Math.min(n, MAX_CONTENT_CEILING);
}
```

Then in the `webContentExtractor` function body, immediately after destructuring params, replace use of the raw `maxLength` with a clamped value:

```javascript
  // Clamp the caller-requested length to the server-side ceiling.
  maxLength = clampMaxLength(maxLength);
```

(Place this as the first statement inside the function so both truncation sites — `fullText.substring(0, maxLength)` ~line 189 and the `textContent.substring(0, maxLength)` ~line 346 — use the clamped value. Leave the destructuring default `maxLength = 5000` as-is.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node server/tests/web-content-extractor-cap.test.js`
Expected: PASS — all 5 checks green.

- [ ] **Step 5: Format and commit**

```bash
cd /Users/danielmanzke/Workspaces/claude-only/ihub/repo/ihub-apps
npx prettier --write server/tools/webContentExtractor.js server/tests/web-content-extractor-cap.test.js
git add server/tools/webContentExtractor.js server/tests/web-content-extractor-cap.test.js
git commit -m "feat(tools): clamp webContentExtractor output to a 10k ceiling

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 2 (separate plan — not implemented here): Gemini context caching

Caching the stable prefix (system prompt + tool definitions + the unchanged early conversation) via Gemini's context-caching API so it is not re-billed each turn. This is a distinct subsystem (provider adapter work in `server/adapters/`, cache lifecycle/TTL management, cost accounting) and should get its own spec + plan. It is complementary to Tasks 1–3, not a substitute: compaction reduces *what* is sent; caching reduces the *price* of what remains stable. Recommend implementing and measuring Tasks 1–3 first (they need no provider changes), then deciding whether caching is still worth it.

## Verification (after all tasks)

- All three new/extended test files pass.
- Re-run a representative agent step and confirm per-step `input` tokens drop sharply (the 517k step should fall by an order of magnitude once old web bodies are elided after ~6 messages).
- Spot-check a run's `_citations` ledger and step-log previews are unchanged (audit intact).
