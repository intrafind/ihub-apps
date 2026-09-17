# Completeness Analysis Workflows

**Status:** in progress (Stellungnahmen slice shipped; corpus-analysis workflows + iFinder-backed search in follow-up commits)
**Date:** 2026-06-02
**Plan file:** `~/.claude/plans/i-need-you-and-sharded-wreath.md`

## Context

Several customers run human-driven review processes that don't scale. The
clearest case is government law-change consultation: when a draft is
published, every affected party submits a written Stellungnahme; a
ministry analyst must read each one, extract the demanded changes, cite
each demand against the source verbatim, sort by paragraph, and compile a
single report. A customer is already doing this with a hand-tuned LLM
prompt on uploaded PDFs — the output is plausible but not auditable, and
the prompt doesn't generalise across laws.

A related, broader pattern came up in Franz's "Vollständigkeitsmodus"
sketch: form a candidate document set from a structured search, run
per-document evidence extraction in a map-reduce shape, and produce a
final report whose coverage statistics let a reader see exactly which
documents were considered. Same building blocks; different orchestration.

This work introduces a small set of reusable workflow primitives in iHub
that express **corpus-completeness analysis** as composable nodes, and
ships two reference surfaces (a workflow and an agent profile) for the
Stellungnahmen use case. Corpus-search-driven variants land alongside.

## Out of scope

- iAssistant-style quick RAG answers — already covered by iAssistant as a
  separate app. We don't ship a "Quick vs Completeness" mode toggle.
- Dynamic workflow authoring by end users. Admins author workflows; users
  consume them.
- A separate permission/filter layer on top of search results — iFinder
  owns permissions.
- Parallel/batched LLM execution. Sequential `forEach` up to 500
  iterations is enough for the realistic scale (50–500 docs per run).
- Hard-blocking on failed quote validation. Validation failures are
  flagged inline in the report; hard-block stays a per-workflow opt-in.
- PDF re-parsing for offset/page locators — out of scope for v1.
- Backwards-compat shims for the customer's existing monolithic prompt.

## Architecture

```
trigger (chat @mention or agent inbox)
   │
   ▼
[optional] query-plan node ── user input + optional topic seeds
   │
   ▼
corpus-search node ─── iFinder search; populates _coverage.candidates
   │                   (skip for upload-driven workflows like Stellungnahmen)
   ▼
forEach docs (cap raised to 500)
   ├── iFinder.getContent              ─ fetch per-doc fulltext on demand
   ├── prompt                          ─ per-doc structured extractor
   └── evidence-collect node           ─ build Evidence record
   ▼
quote-validator node ─── hybrid: normalize + substring → LLM fallback
   │
   ▼
[optional] prompt (cross-document synthesis)
   │
   ▼
report-compose node ─── Handlebars-subset template → Markdown artifact
   │
   ▼
end
```

The same primitives are exposed as agent tools (`evidence_collect`,
`evidence_validateQuotesFastPath`, `evidence_composeReport`) so an agent
profile can drive the same job dynamically via planner + drain-loop. The
two surfaces share a single core implementation in
`server/services/evidence/`.

## Data model

### Evidence record

One record per `(document × analysis step)`. In-state during a run at
`state.data._evidence[]`. Persisted-to-disk evidence (one JSON per docId)
is a follow-up — the existing `artifactStore.safeArtifactName` rejects
sub-directories.

```
{
  evidenceId, runId, nodeId, iterationIndex,
  source: { docId, sourceSystem, title?, url?, retrievedAt? },
  extraction: { schemaName, schemaVersion, data: <named-schema shape> },
  quotes: [ { text, locator?, validated, closestMatch?, confidence? } ],
  classification?, llm?,
  status: 'ok' | 'partial' | 'failed',
  failures: [ { code, message } ]
}
```

`extraction.data` is free-shape per workflow. Two named schemas to start
(registered in `server/services/evidence/extractionSchemas.js`):

- `stellungnahmenReview/v1` — `{ organisation, title, demandedChanges: [{ paragraphReference?, summary, sourceQuote? }] }`
- `corpusAnalysis/v1` — `{ keyStatements[], entities[], position?, evidenceQuotes[] }`

### Coverage state

`state.data._coverage`:

```
{
  candidates: { total, source, queryPlan? },
  processed, skipped: [{docId, reason}], failed: [{docId, error}],
  quotesChecked, quotesValidated,
  startedAt, completedAt
}
```

Populated by `corpus-search` (or the upload-driven workflow's `init-corpus`
transform), incremented per-iteration, finalised by `quote-validator`.

## Primitives

Core logic in `server/services/evidence/` is shared between the workflow
node executors and the agent tools.

| Primitive            | Node type           | Tool                                     | Behavior                                                                                                                                                                            |
| -------------------- | ------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Query planner        | `query-plan`        | (planning is the agent's own LLM call)   | LLM expands a user question into `{topics, synonyms, entities, filters, expansions}`. Optional — workflows with static seeds skip this node.                                       |
| Corpus search        | `corpus-search`     | (deterministic; no agent tool)           | Calls `iFinderService.search()` per topic, dedupes by docId, optionally pre-fetches fulltext. Populates `_coverage.candidates`. Loop-aware via Handlebars interpolation in config. |
| Evidence collect     | `evidence-collect`  | `evidence_collect`                       | Validates the prompt's structured output against the declared schema, enriches with source/llm metadata, pushes to `_evidence[]`. Soft-fail (record kept with `status: 'failed'`). |
| Quote validator      | `quote-validator`   | `evidence_validateQuotesFastPath` (+ agent reasoning) | Hybrid: normalize + substring → LLM fallback. Updates each quote's `validated`/`closestMatch`/`confidence`. No hard-block; surfaces flags in the report.                  |
| Report composer      | `report-compose`    | `evidence_composeReport`                 | Renders a Handlebars-subset template (`{{var}}`, `{{#if}}`, `{{#each}}`) into Markdown. Persists via `writeArtifactDirect`. Has a safe default template for misconfigured runs.    |

### Other changes

- `LoopNodeExecutor` hard cap: 200 → **500**. Default per-node
  `maxIterations` stays 50.
- New node-type enum entries in `server/validators/workflowConfigSchema.js`:
  `query-plan`, `corpus-search`, `evidence-collect`, `quote-validator`,
  `report-compose`.
- Tools registered in `server/defaults/config/tools.json` under the new
  `evidence` tool ID with three functions.

## Reference workflows

All in `server/defaults/workflows/`.

### `stellungnahmen-review.json` (shipped)

Single-document audit-grade workflow. Upload → transform-init-corpus →
extract-evidence (prompt emitting `stellungnahmenReview/v1`) →
evidence-collect → quote-validator → report-compose → end. Bypasses
`query-plan` and `corpus-search` entirely — the source is the uploaded
document. Generalises across laws via runtime input (`lawReference`,
`topicSeeds`).

### `corpus-analysis-direct.json` (follow-up)

Case A — flat. Free-form question → `query-plan` → `corpus-search` →
`forEach` over docs (`iFinder.getContent` + per-doc extractor +
`evidence-collect`) → `quote-validator` → cross-document synthesis prompt
→ `report-compose`.

### `corpus-analysis-decomposed.json` (follow-up)

Case B — nested. The planner emits sub-questions; outer `forEach` over
sub-questions, each with its own `corpus-search` + nested `forEach` over
docs. Same downstream pipeline.

## Agent profile

`contents/agents/profiles/completeness-analyst-stellungnahmen.json`
(shipped).

Inbox-driven (`stellungnahmen-inbox`). Single prompt step with the three
evidence tools attached. The agent extracts demanded changes, calls
`evidence_collect`, runs `evidence_validateQuotesFastPath`, decides on
each fast-path miss using its own reasoning over the source text (NOT
the workflow's separate LLM fallback — keeps the agent's reasoning in
its own context), and calls `evidence_composeReport` to produce the
final artifact.

Same evidence schema, same report shape as the workflow — that's what
makes the **workflow-vs-agent comparison** meaningful. The two surfaces
are intentionally maintained as a product experiment.

## Files

**Created:**

- `server/services/evidence/` — `collectEvidence.js`, `validateQuotes.js`, `composeReport.js`, `renderTemplate.js`, `extractionSchemas.js`, `index.js`
- `server/services/workflow/executors/` — `EvidenceCollectNodeExecutor.js`, `QuoteValidatorNodeExecutor.js`, `ReportComposeNodeExecutor.js`
- `server/validators/evidenceRecordSchema.js`
- `server/tools/evidence.js`
- `server/defaults/workflows/stellungnahmen-review.json`
- `contents/agents/profiles/completeness-analyst-stellungnahmen.json`
- `concepts/2026-06-02 Completeness Analysis Workflows.md` (this file)

**Modified:**

- `server/services/workflow/executors/LoopNodeExecutor.js` — hard cap 200 → 500
- `server/services/workflow/executors/index.js` — registered three new executors
- `server/validators/workflowConfigSchema.js` — added five new node types to the enum
- `server/services/evidence/index.js` — extended public surface
- `server/defaults/config/tools.json` — registered the `evidence` tool with three functions

## Verification

### Pure modules (smoke-tested via inline Node)

- `normalizeForMatching` handles unicode NFC, whitespace collapse,
  hyphenated line wraps.
- `planQuoteValidation` correctly distinguishes fast-path hits from
  misses on a synthetic doc.
- `renderTemplate` supports `{{var}}` / `{{#if}}` / `{{#each}}` with
  nested `this.field` and `@index` — bug found and fixed where outer
  `this.field` substitution was clobbering inner `{{#each this.foo}}`.
- `collectEvidence` validates against the named schema; soft-fails with
  `status: 'failed'` + `failures: []` on shape mismatch rather than
  throwing.
- `composeReport` produces a complete Markdown report from a synthetic
  evidence array, with the default template rendering coverage block +
  per-doc tables + inline quote validation marks.

### Integration

- `server/server.js` boots cleanly with the three new node executors
  registered. ResourceLoader logs confirm
  `stellungnahmen-review` and `completeness-analyst-stellungnahmen` are
  loaded and enabled.
- `tools.json` parses as valid JSON; `evidence` tool entry with three
  functions registered.
- Both new workflow and agent profile parse against their respective
  schemas.

### End-to-end (manual, deferred to first run with sample documents)

To verify against real Stellungnahmen PDFs:

1. Drop sample PDFs into a chat session.
2. Trigger `@stellungnahmen-review` in the chat with optional law
   reference / topic seeds.
3. Expect: a Markdown report with coverage block, organisation + title +
   demanded-changes table, and a "Zitat-Validierung" section listing
   each quote with `✓` or "nicht wörtlich gefunden" with the closest
   match.
4. Compare with running the same documents through
   `completeness-analyst-stellungnahmen` agent (post via inbox) — same
   evidence shape, same report sections, different LLM execution path.

## Open items (follow-up commits)

- `query-plan` and `corpus-search` executors (LLM + iFinder integration).
- `corpus-analysis-direct.json` and `corpus-analysis-decomposed.json`
  workflows.
- Multi-document upload support in `stellungnahmen-review` (currently
  single-doc per run — corpus-search will close this gap natively for
  iFinder sources).
- Per-evidence-record disk persistence — requires extending
  `artifactStore.safeArtifactName` to support `evidence/` sub-directory.
- Consolidating the template engine in `PromptNodeExecutor.js` with the
  new `renderTemplate.js` (currently two implementations of the same
  Handlebars subset).
- Within-topic pagination of `iFinderService.search()` (currently capped
  at 100 results per call).

## Memory references

- `feedback_completeness_scope.md` — scope constraints set during design
- `project_completeness_analysis.md` — active project description
- `feedback_architecture_constraints.md` — broader iHub architecture rules
