# Completeness Analysis Workflows — Handoff & Open Questions

**Date:** 2026-06-03
**Status:** Shipped (working end-to-end), needs review before deeming done.
**Predecessor:** `concepts/2026-06-02 Completeness Analysis Workflows.md`

This document captures the state after the second day of iteration, the issues
we hit and fixed, and the questions a reviewer needs to look at before this
slice can be called complete.

## What works (verified by user)

End-to-end on real data:

- User drops N PDF Stellungnahmen into chat, types `@stellungnahmen-review …`.
- Workflow extracts demanded legislative changes from each document with
  verbatim source quotes, produces a Markdown report (one table per document)
  matching the customer's hand-tuned prompt format.
- Report streams into chat as the final assistant message and is also
  persisted as a run artifact.
- Per-document progress events show in the chat step indicator
  ("📄 Analysiere Dokument N / M: …") and auto-complete when the next one starts.

Three workflows are deployed:

- `stellungnahmen-review` — production target, customer-shaped output.
- `corpus-analysis-direct` — generic flat completeness analysis (query plan
  → iFinder search → loop over docs).
- `corpus-analysis-decomposed` — nested variant: planner emits sub-questions,
  per-subquestion search, per-doc analysis.

Plus one agent profile (`completeness-analyst-stellungnahmen`) for the
workflow-vs-agent comparison, and a `progress` node type usable in any workflow.

## What's deployed in this repo

### Server-side primitives (new node types)

| Node type | File | Notes |
|---|---|---|
| `evidence-collect` | `server/services/workflow/executors/EvidenceCollectNodeExecutor.js` | Validates LLM extraction against a named schema, builds structured record |
| `quote-validator` | `server/services/workflow/executors/QuoteValidatorNodeExecutor.js` | Hybrid: normalize+substring → LLM fallback (no longer used in stellungnahmen-review) |
| `report-compose` | `server/services/workflow/executors/ReportComposeNodeExecutor.js` | Template render + artifact write |
| `query-plan` | `server/services/workflow/executors/QueryPlanNodeExecutor.js` | LLM expands user input into search plan |
| `corpus-search` | `server/services/workflow/executors/CorpusSearchNodeExecutor.js` | Multi-query iFinder execution + dedup |
| `progress` | `server/services/workflow/executors/ProgressNodeExecutor.js` | Generic — emits a chat-visible progress event with template interpolation |

### Core logic

`server/services/evidence/` — shared modules used by both node executors and (planned) agent tools:

- `collectEvidence.js`, `validateQuotes.js`, `composeReport.js`, `renderTemplate.js`, `extractionSchemas.js`, `index.js`

### Schemas + bridges

- `server/validators/evidenceRecordSchema.js` — Zod envelope
- `server/validators/workflowConfigSchema.js` — node-type enum extended
- `server/services/workflow/executors/index.js` — executors registered
- `server/services/workflow/executors/LoopNodeExecutor.js` — hard cap raised 200 → 500
- `server/tools/evidence.js` — agent tool family + registered in `tools.json`
- `server/tools/workflowRunner.js` — bridge for `workflow.node.progress` events, dot-notation `primaryOutput`, `coerceErrorMessage` for chat error display, `_fileData` no longer duplicates the input variable's payload

### Reference workflows + agent

- `server/defaults/workflows/stellungnahmen-review.json` (v1.2.0)
- `server/defaults/workflows/corpus-analysis-direct.json`
- `server/defaults/workflows/corpus-analysis-decomposed.json`
- `contents/agents/profiles/completeness-analyst-stellungnahmen.json`

### Frontend

- `client/src/features/workflows/pages/WorkflowExecutionPage.jsx` — new `InputValueRenderer` for collapsed file display + null-safety fix in the existing accordion panel

### Cross-cutting fix worth noting

- `server/services/workflow/executors/PromptNodeExecutor.js` — `outputSchema` is now also forwarded to the LLM call as `responseSchema` (was previously only used for post-parse validation). Benefits every workflow with `outputSchema`, not just ours.

## Architectural concern flagged by the user

> "The render template looks generic. I'm not even sure we have built anything
> specific to evidence — it's all about a prompt running in a loop."

This is correct and worth a deliberate decision before merging.

What's actually evidence/audit-specific:

- `validateQuotes.js` — substring + LLM verdict for verbatim quote checking.
  Genuinely about quote provenance.
- `extractionSchemas.js` — `stellungnahmenReview/v1` and `corpusAnalysis/v1` —
  named domain schemas. Tiny.
- `QuoteValidatorNodeExecutor` — orchestrates the above.

What's generic and probably misnamed:

- `renderTemplate.js` — pure Handlebars subset, nothing to do with evidence.
- `composeReport.js` — `composeReport({evidence, coverage, synthesis, template})`
  — but the names are just variable names; it's a template renderer with a
  context-building convention.
- `collectEvidence.js` — validate-against-schema + envelope construction.
  Could be reframed as "structured record collector."
- `EvidenceCollectNodeExecutor` — same.
- `ReportComposeNodeExecutor` — same.
- `progress` node — already generic.

**Recommendation for the review:** decide whether to:

1. **Leave naming as-is** — accept that "evidence" is the first concrete
   application and we'll rename if a second use case demands it. (Lowest
   immediate effort. Risk: cognitive friction when reusing for non-audit
   contexts.)
2. **Rename and split** — split `services/evidence/` into:
   - `services/templating/` (renderTemplate, composeReport's template plumbing)
   - `services/structuredRecord/` (collectEvidence-but-generic, schema registry)
   - `services/auditQuotes/` (validateQuotes — actually evidence-specific)

   Rename node types: `evidence-collect` → `structured-record`,
   `report-compose` → `template-render`, keep `quote-validator` and
   `progress` as-is. Migrate existing workflow JSONs.

The user explicitly flagged this — should not be a silent decision.

## Open issues / things to investigate

### From this session

- **`_fileData` vs input variable duplication** — fixed for the chat-trigger
  path (workflowRunner only writes one or the other). Worth checking other
  callers of the workflow engine for the same pattern.
- **State-size limit (50 MB hard cap in `StateManager.js:23`)** — we hit
  this on 12 large PDFs. Mitigations applied: corpus item only carries one
  copy of content, `_corpusRaw` / `_fileData` / `_extractionOutput` nulled
  in mid-run cleanups. Not configurable today. If a customer regularly
  processes hundreds of large PDFs, this needs a structural fix (offload
  large data to disk, reference it by id in state).
- **LLM truncation on long quotes** — bumped `maxTokens` 8 000 → 16 000 for
  extract-evidence. May still happen on edge cases. `coerceLlmJson` falls
  back to status='failed' which is honest but the record is unusable.
  Possible follow-up: attempt JSON repair (close trailing braces/brackets)
  to recover partial structure.
- **Missing per-iteration progress events** observed during heavy runs. We
  worked around it by collapsing to one event per iteration (announce-doc
  with status='running', auto-completed by next iter). Suspected cause:
  React `setState` batching in the chat client's workflow-step accumulator
  (`useAppChat.js:198-209`). Not yet investigated client-side.

### Architectural debt

- **Two template-rendering engines.** `PromptNodeExecutor.js:798+` has its
  own Handlebars-subset renderer for prompt templates. My
  `renderTemplate.js` has a separate one for report templates. Same syntax,
  different implementations. Consolidation is on the open-items list from
  day 1.
- **`_loopItem` / `_loopIndex` / `_loopTotal`** — hardcoded variable names
  in `LoopNodeExecutor.js`. Config options like `itemVar`/`indexVar` exist
  in some places but the executor ignores them. We worked around by always
  using the hardcoded names.
- **Workflow output convention** — the client filter
  (`client/src/features/workflows/utils/filterInternalFields.js:35`) hides
  any state key starting with `_`. Workflows must end with an unprefixed
  string variable on `outputVariables` to surface output in the UI and
  enable "Chat with results." This convention isn't documented anywhere
  obvious. Add to workflow-authoring guide.

## Code review focus list

When the user does the review:

1. **Naming/genericity decision** (the architectural concern above) — single
   biggest item.
2. **`workflowRunner.js`** — the bridge handler grew several event-type
   cases; verify the executionId/chatId routing logic is still coherent.
3. **`PromptNodeExecutor.js` `responseSchema` wiring** — confirm Gemini
   adapter handles complex schemas correctly; OpenAI/Anthropic paths not
   tested by me.
4. **`StateManager` size limit** — is 50 MB the right cap? Should it be
   configurable per-workflow or per-deployment?
5. **`EvidenceCollectNodeExecutor.coerceLlmJson`** — fallback behaviour on
   truncated JSON. Acceptable as-is or worth a repair attempt?
6. **`renderTemplate.js` whitespace control** — standalone-block strip
   handles common cases but has edge cases (e.g., adjacent blocks). Pure
   Handlebars uses `{{~ ~}}`; we don't support those.
7. **All three workflow JSONs** — convention consistency, schema names,
   maxTokens settings, template content.

## Recommended next session

In order of value:

1. **Code review** — focus list above. Decide on the genericity question.
2. **Refactor based on review decisions.** Likely rename + split modules,
   migrate workflow JSONs.
3. **`document-feature` skill** — generate the changelog entry for
   `docs/releases/5.4.0/features.md` (the entry I drafted previously
   covers v1.0, this slice has added a lot).
4. **Workflow-authoring guide update** — document:
   - `progress` node type
   - `evidence-collect`, `quote-validator`, `report-compose`, `query-plan`,
     `corpus-search` (or their renamed successors)
   - Output convention (use unprefixed top-level string for `primaryOutput`
     + `outputVariables`; underscore-prefix everything internal)
   - `outputSchema` now drives native LLM structured output
5. **Workflow execution view polish** (lower priority) — outputs section
   inherits some of the same expanded-JSON problems the inputs panel had;
   the `InputValueRenderer` pattern could be applied to outputs too.
6. **Investigate the chat step-rendering missing-events issue** — not blocking
   but the workaround (one event per iteration) feels like covering up
   rather than fixing.

## Things explicitly out of scope (still)

- Per-evidence-record disk persistence under `evidence/` subdirectory
  (requires extending `artifactStore.safeArtifactName` to allow paths).
- Within-topic pagination of `iFinderService.search()` (still capped at
  100 results per call).
- Multi-doc support in `corpus-analysis-*` was implemented (case A flat,
  case B nested) but only the Stellungnahmen workflow has been exercised
  end-to-end on real data; the corpus-analysis variants need an iFinder
  instance with permissioned content to test.

## Files modified in this session (day 2)

Summary of touch points not already in the day-1 doc:

**Server:**

- `server/tools/workflowRunner.js` — `coerceErrorMessage`, `extractReadableOutput` dot-notation, `workflow.node.progress` bridge, `_fileData` no-duplicate
- `server/services/workflow/executors/PromptNodeExecutor.js` — `responseSchema` forwarding
- `server/services/workflow/executors/EvidenceCollectNodeExecutor.js` — `coerceLlmJson`, status='completed' silencing
- `server/services/workflow/executors/QuoteValidatorNodeExecutor.js` — same emit pattern (now unused by the live workflow)
- `server/services/workflow/executors/ReportComposeNodeExecutor.js` — same emit pattern
- `server/services/workflow/executors/ProgressNodeExecutor.js` — NEW
- `server/services/evidence/renderTemplate.js` — standalone-block whitespace stripping, `{{#unless}}` support
- `server/services/workflow/executors/index.js` — `progress` registration
- `server/validators/workflowConfigSchema.js` — `progress` added to enum

**Workflows:**

- `server/defaults/workflows/stellungnahmen-review.json` — v1.0 → v1.2 with multi-doc, progress, state-cleanup, customer-shaped report, `_unless`, filename in header, `expose-output` step
- `server/defaults/workflows/corpus-analysis-direct.json` — same `expose-output` + unprefixed output convention
- `server/defaults/workflows/corpus-analysis-decomposed.json` — same

**Client:**

- `client/src/features/workflows/pages/WorkflowExecutionPage.jsx` — `InputValueRenderer`, null-safety in accordion panel
