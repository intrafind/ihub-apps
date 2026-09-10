# Knowledge Layer & LLM Wiki — Design

**Date:** 2026-09-10
**Status:** Draft for review — open decisions in §2 need answers before an issue stack
**Author:** Daniel Manzke / Claude
**Input:** [RAGFlow Capability Analysis](./2026-09-10%20RAGFlow%20Capability%20Analysis.md)
**Depends on:** [Storage Provider & Durable Chats Design](../persistence-layer/2026-09-09%20Storage%20Provider%20and%20Durable%20Chats%20Design.md) (approved)

---

## 1. Summary

iHub Apps gains a **Knowledge Layer**: derived, persisted knowledge *about* source documents — summaries, typed metadata, keywords, reference questions, entities, relations and topic articles — produced by LLM enrichment passes at ingest time, stored on the StorageProvider, browsable as an **LLM wiki**, and fed back into retrieval.

The framing decision is what iHub does *not* build. RAGFlow is a complete RAG engine: parser, chunker, embedder, vector store, graph builder, retriever. iHub is deliberately not that — retrieval belongs to iFinder, and iHub's sources are whole-document prompt context. Reimplementing RAGFlow's stack inside iHub would ship a second, weaker retrieval engine alongside IntraFind's actual product.

What is genuinely missing, portable, and valuable is the **derivation layer**. Today every LLM insight iHub produces about a document is computed inside one workflow run and thrown away when the run ends. There is no answer to "what do we already know about this document?" The Knowledge Layer makes those insights durable, cumulative, readable by humans, and reusable by retrieval — while retrieval engines stay pluggable underneath.

The phasing is driven by cost. A per-document enrichment tier costs ~1–2% of a per-chunk tier on the same corpus (§11) and delivers a large share of the benefit, so it ships first and alone.

---

## 2. Open decisions

These change the design materially and are not mine to pick. Everything after §3 assumes the **recommendation** column; flag any you want changed.

| # | Decision | Options | Recommendation |
|---|----------|---------|----------------|
| 1 | Does iHub get its own index? | (a) lexical-only over the knowledge store; (b) optional embedding facet on the OpenSearch storage provider; (c) full vector store | **(a) for phases 0–1, (b) opt-in from phase 2.** Never (c) — see §1. |
| 2 | iFinder ingest API | Is IntraFind willing to expose a write/metadata-update endpoint? | Design assumes **no** (verified read-only today, §3). A yes simplifies phases 1–2 substantially and should reopen this doc. |
| 3 | Which source types get enriched | `ifinder` / `filesystem` / `url` / `page`, any subset | **All four.** The enrichment contract is "text + a stable key"; all four handlers already provide that. |
| 4 | ACL model for synthesised articles | (a) knowledge space with a declared ACL up front; (b) per-read filtering of contributing documents; (c) regenerate per audience | **(a).** The only option that is safe *and* simple. See §8. |
| 5 | Enrichment model | Reuse app `preferredModel` / a dedicated indexing model | **Dedicated `indexingModel` per space.** Bulk, latency-insensitive, budget-sensitive work must not be pinned to the interactive chat model. |
| 6 | Wiki audience in v1 | Admin-only / all authenticated users / per-space permission | **Per-space permission**, defaulting to the contributing sources' groups. |
| 7 | Keyword vocabulary | Open-ended generation / controlled taxonomy (RAGFlow tag sets) / both | **Both, taxonomy preferred where one exists** — enterprise deployments already have taxonomies, and classification is cheaper than generation. |
| 8 | Graph scope | Ship phases 2–3 at all, or stop after chunk-level Q&A? | **Decide after phase 1 ships**, on real corpora. The graph is where the cost is and it is the least certain win. |

---

## 3. Current state (verified 2026-09-10 on `main`)

From a full read of the source tree — this is what the design builds on, and the gaps it fills.

**Sources are whole documents, and there is no index.**

- Four handlers: `FileSystemHandler`, `URLHandler`, `IFinderHandler`, `PageHandler` behind `SourceManager` (`server/sources/`). Type union `filesystem | url | ifinder | page` (`server/validators/sourceConfigSchema.js`).
- `exposeAs: 'prompt' | 'tool'` — content is either injected as prompt context or exposed as a callable tool. Caching is TTL-based (`static | refresh`).
- **No chunking, no embeddings, no vector store anywhere in the server.** Grepping the whole server tree: `embedding` appears exactly once, as the string constant `embeddings: 'embeddings'` in `server/telemetry/attributes.js`. The 65 `chunk` hits are SSE stream chunks, not retrieval chunks. `rerank` and `knowledgeGraph`: zero hits.
- Retrieval is **entirely delegated to iFinder**. `iFinderService` (`server/services/integrations/iFinderService.js`) exposes `search`, `getContent`, `getMetadata`, `discover` (with facets), `download`, `resolveDocumentLink` — **all read paths, no write-back or ingest**. Derived artifacts cannot be pushed into iFinder's index today.

**The pipeline machinery already exists — and is already doing a crude version of this.**

The workflow engine (`server/services/workflow/`) has the node executors an enrichment pipeline needs:

| Executor | Role in enrichment |
|----------|--------------------|
| `CorpusSearchNodeExecutor` | Pages iFinder queries, dedupes by `docId`, pre-fetches fulltext into `_corpus` |
| `LoopNodeExecutor` | Per-document / per-chunk iteration |
| `PromptNodeExecutor` | The extraction passes |
| `StructuredRecordNodeExecutor` | Collects typed records across iterations |
| `QuoteValidatorNodeExecutor` | Grounding check — quotes must exist in the source |
| `QueryPlanNodeExecutor` | Query decomposition and expansion |
| `TemplateRenderNodeExecutor` | Composes the final document |
| `CodeNodeExecutor` / `TransformNodeExecutor` | Mechanical steps (clustering, dedup) without an LLM |

`corpus-analysis-decomposed-v2.json` already chains exactly these: `query-plan → loop(corpus-search) → loop(prompt → structured-record) → quote-validator → prompt → template-render`. That is a document-analysis pipeline in production use.

**The gap is durability, not capability.** Everything that pipeline derives lives in workflow state (`contents/data/workflow-state/<executionId>/latest.json`) and dies with the run. Nothing accumulates; nothing is queryable; nothing is readable by a human afterwards; the next run re-pays the full token cost. Making derived knowledge a **first-class stored resource** is the whole of this design.

**Storage is arriving.** The approved StorageProvider design gives a two-facet provider (`documents` + `logs`, plus `notifier` and `locks`), `ownerId` as first-class document metadata, cursor paging, a ~40-test conformance suite, and a provider lineup of filesystem (default), SQLite, PostgreSQL and **OpenSearch**. The Knowledge Layer is a consumer of that abstraction and must not predate it — its namespaces are additive and its OpenSearch provider is the natural home for decision #1(b).

**Other relevant facts:** run ledger `RunLog` exists behind the dark `runLog` feature flag; workflow triggers exist (`server/services/workflow/triggers`) for scheduling; feature flags live in `server/featureRegistry.js` with a `preview` category; config migrations are Flyway-style and currently at `V093`.

---

## 4. Architecture

```
   sources (existing)                knowledge layer (new)              consumers
 ┌──────────────────┐         ┌────────────────────────────────┐   ┌──────────────────┐
 │ filesystem / url │  text   │  Enrichment pipeline           │   │ /wiki  (browse)  │
 │ page / ifinder   │ ──────▶ │  (workflows, existing engine)  │   │ document dossier │
 └──────────────────┘  + key  │    ↓ derived artifacts         │   │ entity / topic   │
        │                     │  KnowledgeStore                │──▶│ articles         │
        │                     │  (StorageProvider documents)   │   └──────────────────┘
        │                     └────────────────────────────────┘   ┌──────────────────┐
        │                                    │                     │ retrieval hooks  │
        │                                    └────────────────────▶│ query expansion  │
        │                                                          │ question match   │
        └─────────────────── retrieval (iFinder, unchanged) ───────▶│ graph expansion  │
                                                                   └──────────────────┘
```

Three rules keep this from becoming a second RAG engine:

1. **The Knowledge Layer never becomes the primary retriever.** iFinder (or whatever the source's engine is) still finds documents. The knowledge layer *improves the query* and *adds context*; it does not replace the search.
2. **Enrichment is a workflow, not new bespoke orchestration.** Reuse the engine, its checkpointing, its resume-on-boot, its triggers, its cost accounting. New code is limited to a handful of node executors and the store.
3. **Every artifact carries provenance and a content hash.** Re-enrichment is idempotent and incremental; an artifact whose `contentHash` still matches is never recomputed.

---

## 5. Data model

New StorageProvider namespaces. All documents carry `spaceId`, `lang`, `contentHash` and a `provenance` block (`{ model, promptVersion, runId, tokensIn, tokensOut, costEstimate, createdAt }`) so cost is attributable and stale artifacts are detectable.

| Namespace | Key | Contents |
|-----------|-----|----------|
| `knowledge-spaces` | `spaceId` | Space config: contributing source ids, declared ACL (§8), `indexingModel`, enabled tiers, taxonomy ref, schedule |
| `knowledge-docs` | `docKey` | The **document dossier**: source ref, title, summaries (short/long), typed auto-metadata, keywords, taxonomy tags, reference questions, entity refs, enrichment status |
| `knowledge-chunks` | `docKey:ordinal` | Chunk text (or an offset range into the source), per-chunk keywords, generated questions, entity refs, optional embedding ref |
| `knowledge-entities` | `entityKey` | Canonical name, type, aliases, LLM-merged description, mention refs, degree/PageRank |
| `knowledge-relations` | `relKey` | `from`/`to` entity, type, description, evidence refs (`docKey:ordinal`), weight |
| `knowledge-topics` | `topicKey` | Cluster article: title, summary, findings, impact rating, member entities, hierarchy level |
| `knowledge-questions` | `questionKey` | Reference question → answering chunk refs. The FAQ index (§7.2) |

**`docKey`** is a stable hash of `(sourceId, documentId)` — not of content — so a document's dossier survives edits and accumulates history. **`contentHash`** gates recomputation.

**Language is a first-class dimension.** iHub is bilingual throughout (localized names, `system` prompts, pages under `contents/pages/{lang}/`). A dossier for a German document with English keywords is useless for a German query. Artifacts are keyed per `lang`; the pragmatic default is to enrich in the document's detected language and generate reference questions in every configured UI language, since question matching is exactly where cross-language mismatch hurts most.

---

## 6. The enrichment pipeline

Expressed as workflows, one per tier, so each is inspectable and editable by admins like any other workflow.

```
knowledge-enrich-documents  (tier 0)
  start → resolve-space → loop(documents)
            ├ skip-if-unchanged   (code: compare contentHash)
            ├ fetch-content       (source handler / corpus-search)
            ├ extract-dossier     (prompt → structured output: summary, metadata, keywords, questions)
            ├ tag-taxonomy        (code/prompt: classify against the space's taxonomy)
            └ knowledge-write     (NEW executor: persist dossier + provenance)
          → end

knowledge-enrich-chunks     (tier 1)   adds: chunk → per-chunk prompt → knowledge-write
knowledge-build-graph       (tier 2)   adds: extract-entities → resolve-entities → knowledge-write
knowledge-build-topics      (tier 3)   adds: cluster-entities → summarise-community → knowledge-write
```

**New node executors** — deliberately few:

- **`chunk`** — deterministic, no LLM. Structure-aware splitting (headings, then paragraphs, then a token budget with overlap). Chunk quality bounds every derived artifact (§2.7 of the analysis doc), so this deserves real care and real unit tests, not a naive character split.
- **`knowledge-write`** — the only path into the store. Validates against the artifact schema, computes `contentHash`, writes provenance, is idempotent on re-run.
- **`knowledge-query`** — read side, used by retrieval hooks and by the wiki.

Entity resolution and clustering start as `code` nodes (connected-components merge over normalised names + alias table; agglomerative clustering over co-occurrence) and only graduate to LLM-assisted passes if the cheap version measurably underperforms. RAGFlow's resolution pass is LLM-driven over batched candidate pairs; that is a large token line item and should be earned, not assumed.

**Scheduling** uses existing workflow triggers: on-demand from the admin UI, on a schedule per space, and — later — on source-change notification via the StorageProvider's `notifier` facet.

---

## 7. Retrieval integration

Three hooks, cheapest first. Each is independently useful and independently shippable.

### 7.1 Query expansion (phase 0, no index needed)

`QueryPlanNodeExecutor` and the iFinder tool consult the knowledge layer for keywords, taxonomy tags and entity aliases matching the user's question, and widen the iFinder query with them. This is the RAGFlow auto-keyword benefit — fixing vocabulary mismatch — delivered without iHub owning an index, because iFinder still does the searching.

### 7.2 Question matching (phase 1)

The user's question is matched against stored reference questions; hits resolve to their answering chunks, which enter the context directly. Question-to-question matching beats question-to-prose matching because the two sides have the same shape — this is the highest-leverage feature in the whole design and it works with a purely lexical index.

Matching starts lexical (normalised token overlap + iFinder's own text matching over questions fed back as a synthetic source). Decision #1(b) upgrades it to embeddings when the OpenSearch provider lands.

### 7.3 Graph expansion (phase 2–3)

Entity candidates from the query → N-hop expansion over `knowledge-relations` → contributing documents added to the candidate set, with topic articles supplied as context. This is RAGFlow's `KGSearch` shape, and it is the part to build last and judge hardest.

**A note on grounding.** `QuoteValidatorNodeExecutor` already exists and enforces that quoted evidence appears in the source. Every synthesised artifact — dossier summary, topic article — must pass through it. A wiki of confidently wrong summaries is worse than no wiki, and the existing validator is the cheapest available defence.

---

## 8. Permissions — the part with no RAGFlow analogue

A RAGFlow dataset is effectively single-tenant, so synthesising a community report across all its documents raises no access question. iHub is group-permissioned per source and per app. **A topic article synthesised from documents with different ACLs is a data-leak vector**: the article's prose can carry facts from a document the reader may not open, and no read-time filter can un-say them.

The recommended rule (decision #4a):

> A **knowledge space** declares its ACL up front. Only documents whose own permissions are satisfied by that ACL are enriched into it. Every artifact in the space inherits the space's ACL. Cross-document synthesis is therefore always within one access class, by construction.

Consequences, stated plainly:
- A source whose documents span access classes must be split across spaces, or enriched into the most restrictive one.
- Per-document dossiers may additionally be filtered at read time to the reader's own document permissions — that is defence in depth, not the primary control.
- For iFinder sources, per-document ACLs live in iFinder and are enforced per user at search time. The space ACL must be set to match the search profile's audience; getting this wrong is the single most damaging misconfiguration in this design, so the admin UI must state the rule at the point of configuration and the validator must reject a space with no declared ACL.

---

## 9. Configuration, flags and migration

- **Feature flag** `knowledgeLayer` in `server/featureRegistry.js`, `category: 'preview'`, `default: false`, `preview: true` — same posture as `runLog`.
- **Space configs** as individual files under `contents/knowledge/<spaceId>.json`, following the established one-file-per-resource pattern (`contents/apps/*.json`, `contents/models/*.json`), with a Zod schema in `server/validators/knowledgeSpaceSchema.js`.
- **Migration** `V094__add_knowledge_layer_config.js` seeds platform defaults (global enrichment budget ceiling, default `indexingModel`, retention). Additive only — `setDefault` never overwrites admin values.
- **Sources** gain an optional `knowledge` block (`{ spaceId, tiers, schedule }`). Additive and optional, so no existing `sources.json` breaks and no compatibility shim is needed.

## 10. UI surface

- New top-level route **`/wiki`**: space index → document dossiers → entity pages → topic articles, plus a search box over the knowledge store.
- Admin: space CRUD, per-space enrichment status and cost, "re-enrich" actions, stale-artifact counts.

⚠️ **Adding `/wiki` requires updating both route lists** — `KNOWN_ROUTES` in `client/src/utils/runtimeBasePath.js` *and* the inline `knownRoutes` array in `client/index.html`. `tests/unit/client/known-routes-sync.test.jsx` fails if they drift, and missing the `index.html` copy breaks **cold loads** of `/wiki` on subpath deployments with "Unable to connect to the server" while client-side navigation still appears to work.

---

## 11. Cost, and why the phasing is what it is

Per the analysis doc, for *D* documents at *C* chunks each:

| Tier | LLM calls | 500 docs × 40 chunks |
|------|-----------|----------------------|
| 0 — document dossiers | ~*D* | ~500 |
| 1 — chunk keywords + questions | ~2·*D·C* | ~40,000 |
| 2 — graph extraction + resolution | ~*D·C* + pair batches | ~20,000+ |
| 3 — topic articles | ~communities | ~hundreds |

Tier 0 is **~1–2% of tier 1** on the same corpus and already delivers document dossiers, retrieval filters, query expansion, and a readable wiki page per document. That asymmetry is the entire argument for shipping it alone and measuring before spending two orders of magnitude more.

Controls that ship with tier 0, not after it: a per-space token budget with hard stop, a dedicated cheap `indexingModel`, `contentHash` skip-if-unchanged, dry-run cost estimation before a bulk run, and per-space cost reporting in the admin UI. Enrichment is the first feature in iHub that can spend a large budget with no user watching, so the guardrails are part of the minimum viable version.

---

## 12. Phased plan

Each phase ships user-visible value on its own and is independently abandonable.

| Phase | Ships | Depends on |
|-------|-------|-----------|
| **0** | `KnowledgeStore` + `knowledge-write`/`knowledge-query` executors, document dossiers, `/wiki` browse, query expansion (§7.1), budget controls, feature flag | StorageProvider step 1 |
| **1** | `chunk` executor, per-chunk keywords + reference questions, question matching (§7.2) | Phase 0 |
| **2** | Entity + relation extraction, mechanical resolution, entity pages, graph expansion (§7.3) | Phase 1 + decision #8 |
| **3** | Clustering + topic articles — the LLM wiki proper | Phase 2 |
| **4** | Change-driven incremental re-enrichment via the `notifier` facet; optional embedding facet (decision #1b) | Phases 0–3 |

**Phase 0 is the whole recommendation.** Phases 2–3 should be re-argued against real phase-1 data rather than pre-approved here; that is where RAGFlow's own documentation warns the cost lives, and where the benefit is least certain for iHub's corpora.

---

## 13. Risks

| Risk | Mitigation |
|------|-----------|
| **ACL leakage through synthesised prose** | Space-declared ACL (§8); validator rejects undeclared; admin UI states the rule inline |
| **Runaway enrichment cost** | Per-space budget with hard stop, dry-run estimate, cheap `indexingModel`, content-hash skip — all in phase 0 |
| **Confidently wrong summaries** | Mandatory `quote-validator` pass; dossiers link to source; wiki marks every artifact as generated, with model and date |
| **Becoming a second RAG engine** | Architecture rule #1 (§4): the knowledge layer improves queries and adds context, never replaces search. Decision #1 caps this explicitly |
| **Stale knowledge** | `contentHash` per artifact; stale counts surfaced in admin; phase 4 makes re-enrichment change-driven |
| **Poor chunk boundaries poisoning everything downstream** | `chunk` is deterministic and unit-tested; structure-aware before token-budget fallback |
| **Bilingual mismatch** | `lang` is a first-class key; reference questions generated per configured UI language |
| **iFinder gains an ingest API and invalidates the design** | Decision #2 is called out as a reopen trigger, not an assumption buried in code |

---

## 14. Follow-ups when implementation starts

- `docs/knowledge-layer.md` (new, added to `docs/SUMMARY.md`) and a cross-reference from `docs/sources.md`.
- A changelog entry in `docs/releases/` via the `document-feature` skill — this is admin- and user-visible.
- Conformance tests for the new namespaces against the StorageProvider suite.
