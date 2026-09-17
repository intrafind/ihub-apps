# Workflow Input Strategies

**Date:** 2026-06-10
**Status:** Concept / decision record
**Context:** Many workflows declare multiple `start.config.inputVariables`, but the chat trigger path (web-chat → `workflowRunner`) only auto-maps the chat message to a single text variable. Everything else arrives empty. The `stellungnahmen-review-ifinder` workflow surfaced this: `searchProfile` is `required: true` but no UI/path supplies it from chat.

This document maps the available levers for supplying additional workflow inputs, when each one fits, and what is already implemented vs. what would need to be built.

## Today's baseline: `config.defaults` on the start node

Already supported by `StartNodeExecutor` (`server/services/workflow/executors/StartNodeExecutor.js:94-97`):

```json
"config": {
  "defaults": { "searchProfile": "searchprofile-standard" },
  "inputVariables": [ ... ]
}
```

Defaults are applied first; anything in `initialData` (chat input, tool args, modal form values) overrides them. This is the floor — every other strategy is about **overriding** a default with a context-appropriate value.

The rest of the doc covers the three richer strategies.

---

## Strategy 1 — Variable mapping (UI form before run)

### How it works today

`client/src/features/workflows/components/StartWorkflowModal.jsx` already renders a typed form from `start.config.inputVariables`. Supported field types:

- `string`, `textarea`, `number`, `date`, `boolean`
- `select` with `options: [{ value, label }]`
- `file` / `image` via `UnifiedUploader`
- Localized `label`, `description`, `placeholder`
- `required: true` triggers a red asterisk + client-side validation

This modal fires when a workflow is launched from the **Workflows page** (`/workflows/.../run`). The values land directly in `initialData` and override `config.defaults`.

### What it does **not** cover

- The **chat trigger** path (web-chat → `workflowRunner.js`) bypasses the modal entirely. Only the chat message text gets mapped (to the first non-file `inputVariable`).
- There is no "pre-flight form" injected into the chat panel before a workflow runs from within a chat.

### Build options to fill the gap

**Option A — Pre-flight form in chat (medium effort)**

Before invoking the workflow, the chat client GETs the workflow's `inputVariables` and, if any are `required` and not yet supplied, renders the same `StartWorkflowModal` (or a lightweight inline variant) above the chat input. Submitted values feed into `extraInputVars` on the chat → workflow request.

- Touchpoints: chat invocation site (`client/src/features/chat/...`), `workflowRunner.js` (already accepts `extraInputVars`).
- UX: explicit, discoverable, type-safe via `select`.
- Cost: a new client-side flow + persistence (remember choices across messages in a session).

**Option B — App-level variable presets (small effort, narrow fit)**

Wrap the workflow in an `app` whose `variables` array mirrors the workflow's required inputs. The app stores the values per user/session; chat invocation forwards them as `extraInputVars`.

- Touchpoints: new `contents/apps/<wrapper>.json` per use case.
- UX: one-time setup in the app's settings panel; transparent during chat.
- Cost: an app per use case. Good when the values are **stable per app** (e.g. "this app always searches the legal corpus"), not when they vary per query.

**Option C — Inline variables panel in chat (high effort, high ceiling)**

The redesigned three-column ChatGPT-like layout already plans a right-side "variables/artifacts" panel (`project_ui_redesign` memory). Surface workflow inputs there: editable fields, persistent within the conversation, auto-applied to every workflow invocation.

- Touchpoints: the new chat layout + variables panel + workflowRunner.
- UX: the strongest — values stay visible and editable, the user always knows what context the workflow has.
- Cost: depends on UI redesign progress.

### When to use

- The user **knows** the value (e.g. a profile they pick from a small list).
- The value is **session-scoped or app-scoped** (set once, reuse many times).
- The variable benefits from a typed UI (a `select` with enum options is much better than free text).

---

## Strategy 2 — Tool invocation (LLM @mention with JSON schema)

### How it works today

`server/toolLoader.js:24-90` turns every workflow's `start.config.inputVariables` into a JSON Schema and registers the workflow as an LLM-callable tool. When an LLM-driven app `@mentions` the workflow, the LLM is given the schema and **must fill every required field** from the user's free text (or from tool-defined defaults).

For `stellungnahmen-review-ifinder`, the generated schema today is roughly:

```json
{
  "type": "object",
  "properties": {
    "input":         { "type": "string" },
    "userPrompt":    { "type": "string", "description": "Free-form prompt: ..." },
    "searchProfile": { "type": "string", "description": "ID of the iFinder search profile ..." },
    "agentProfileId":{ "type": "string", "description": "If set, the workflow reads ..." }
  },
  "required": ["input", "userPrompt", "searchProfile"]
}
```

Once the LLM produces a tool-call with `searchProfile: "searchprofile-stellungnahmen"`, the value goes straight into `initialData` and overrides any default.

### What is already strong

- Schema generation is automatic — no extra wiring per workflow.
- `select` types lower a JSON Schema `enum`, so the LLM gets the closed set of valid profile IDs and can't hallucinate.
- Localized `description` is forwarded — the LLM sees the same hint a human would in the form modal.

### What is fragile

- **LLM extraction quality**: free text like "look at krankengeld in the stellungnahmen corpus" must yield `searchProfile: "searchprofile-stellungnahmen"`. Without a closed `enum`, this is a guess. The mitigation is to switch the variable to `type: select` with the list of valid profiles — then the LLM picks from a fixed set.
- **Discoverability**: the user must @mention the workflow from inside an LLM-driven app, not call it directly. Outside that context, no LLM is in the loop and tool-call is unavailable.
- **Latency / cost**: the LLM round-trip adds time and tokens before the workflow even starts.

### When to use

- The user **shouldn't have to know** the variable names — they describe what they want in natural language and the LLM picks the right profile/topic/etc.
- A "concierge" app sits in front of multiple workflows and dispatches based on intent.
- The variable space is **closed and discoverable** by the LLM (use `enum`!).

### Suggested implementation for the iFinder case

Convert `searchProfile` to `type: "select"` with the active iFinder profiles as `options`. Keep `userPrompt` as free text. Now both direct UI form (Strategy 1) and LLM tool-call (Strategy 2) work — the LLM is bounded to valid profiles, and the UI gets a dropdown.

```json
{
  "name": "searchProfile",
  "type": "select",
  "required": true,
  "options": [
    { "value": "searchprofile-standard",       "label": { "en": "Standard corpus" } },
    { "value": "searchprofile-stellungnahmen", "label": { "en": "Stellungnahmen corpus" } }
  ],
  "default": "searchprofile-standard"
}
```

This needs a small extension to `StartNodeExecutor` (or the workflow loader) so per-variable `default` is honored, not just `config.defaults`. Today only `config.defaults` is consumed; `inputVariables[i].default` is ignored. The fix is a 5-line loop that hoists each variable's `default` into the `defaults` map before merging. Worth doing because it lets the schema describe a default in-place rather than duplicated in `config.defaults`.

---

## Strategy 3 — Human-in-the-loop node

### What already exists

`server/services/workflow/executors/HumanNodeExecutor.js` is implemented and registered. It supports:

- A localized `message` shown to the user.
- A multiple-choice `options` array (approve/reject style).
- A free-form `inputSchema` (JSON Schema) for collecting structured data when options aren't enough.
- `showData` for displaying state context alongside the question.
- A `timeout` (ms) for auto-resolving stale checkpoints.

When executed, the node returns `status: 'paused'`, emits `workflow.human.required`, and the workflow halts until the checkpoint API receives a response.

### How it would fix the chat-input gap

Insert a `human` node at the top of the graph that asks "Which search profile?" and stores the answer in state. Sketch:

```json
{
  "id": "ask-search-profile",
  "type": "human",
  "name": { "en": "Choose search profile" },
  "config": {
    "message": { "en": "Which iFinder search profile should I query?" },
    "options": [
      { "value": "searchprofile-standard",       "label": { "en": "Standard" } },
      { "value": "searchprofile-stellungnahmen", "label": { "en": "Stellungnahmen" } }
    ],
    "storeResponseAs": "searchProfile",
    "skipIfSet": "searchProfile"
  }
}
```

Two config knobs that need to be added to `HumanNodeExecutor`:

1. **`storeResponseAs`** — write the chosen `value` into `state.data[<key>]` so downstream nodes (like `corpus-search` reading `$.data.searchProfile`) can resolve it. The executor already records the response in checkpoint state; this just promotes it.
2. **`skipIfSet`** — short-circuit the node if the variable is already populated (from a `default`, an LLM tool-call, or a prior modal submission). This is what makes the human node a **fallback** rather than a forced detour for every invocation.

With those two knobs, the node is a graceful "only ask if you don't already know" prompt.

### Workflow-config caveat

The workflow currently declares `config.humanInLoop: "none"`. That's a top-level engine policy. To use a human node, switch to `"none"` → `"checkpoint"` (or whatever the existing enum value is — verify with `WorkflowEngine`'s config validator). Worth confirming this is just metadata; if it actively blocks human nodes, the policy needs an explicit enum.

### When to use

- The variable has **no sensible default** and isn't reliably extractable from chat context (e.g. "which user account to operate on", "which approval threshold to apply").
- An **interactive correction** is needed mid-flow ("the LLM chose corpus X — did you mean Y?").
- The flow involves an **approval gate** (review generated report before publishing).

### Cost

- The two `HumanNodeExecutor` knobs above (~30 LoC).
- A chat-side renderer for "checkpoint pending" prompts so the user sees the question inline (verify what's already wired via `actionTracker` events — this may already exist for other human-checkpoint use cases).

---

## Composition: how the strategies stack

These aren't mutually exclusive. The robust pattern is to **layer them** so every invocation path supplies the variable some way:

```
default (config.defaults)
      ↓ overridden by
LLM tool-call argument  (Strategy 2 — when reached via @mention)
      ↓ overridden by
StartWorkflowModal form (Strategy 1A — when launched from Workflows page)
      ↓ overridden by
app/session variables   (Strategy 1B/1C — when set in the chat UI)
      ↓ overridden by
human checkpoint reply  (Strategy 3 — when value is still missing at runtime)
```

Implemented this way, the workflow runs unattended for happy-path defaults, lets power users override via the UI, lets the LLM fill values in tool-call mode, and only stops to ask the user when nothing else has supplied the value.

### Recommended next steps for `stellungnahmen-review-ifinder` specifically

1. **Done** — added `config.defaults.searchProfile = "searchprofile-standard"` (unblocks today's chat trigger).
2. **Small**: change `searchProfile` to `type: "select"` with an `options` list so the modal renders a dropdown AND the LLM tool-call gets a closed `enum`.
3. **Small**: teach `StartNodeExecutor` to honor per-variable `default` (hoist into the defaults merge).
4. **Medium**: add `storeResponseAs` + `skipIfSet` to `HumanNodeExecutor`; prepend an optional `ask-search-profile` human node for workflows where the value must be confirmed.

Steps 1–3 are quick wins and unlock most of the value. Step 4 is the right move when we add workflows whose inputs have no defensible default.

## Open questions

- **Where does the source of truth for "valid search profiles" live?** Today the values are hand-typed in JSON. Ideally they'd be discovered from the iFinder integration at workflow-load time (or admin-edit time) and rendered into `options` automatically. Out of scope for this concept, but worth tracking.
- **Per-variable `default` in `inputVariables`** vs. top-level `config.defaults`: pick one canonical form. Per-variable is more self-contained (schema + default in one place); top-level is simpler for the executor. Recommendation: support both, with per-variable winning when both are present.
- **Human-node renderer in chat**: needs to be confirmed working end-to-end before we recommend it as a fallback. If only the Workflows-page UI knows how to render checkpoints, chat-triggered runs would silently hang.
