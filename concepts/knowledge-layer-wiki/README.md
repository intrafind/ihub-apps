# Knowledge Layer & LLM Wiki — Concept Documents

Design documents for giving iHub Apps a derived-knowledge layer over its sources — document dossiers, reference questions, an entity graph and generated topic articles — inspired by RAGFlow's document-analysis features.

## Documents

- **[2026-09-10 Knowledge Layer and LLM Wiki Design](./2026-09-10%20Knowledge%20Layer%20and%20LLM%20Wiki%20Design.md)** — **Current.** The design: `KnowledgeStore` namespaces on the approved StorageProvider, enrichment expressed as workflows over the existing node executors, three retrieval hooks (query expansion, question matching, graph expansion), the knowledge-space ACL model, cost model and a five-phase plan. Contains eight open decisions that need answers before an issue stack.
- **[2026-09-10 RAGFlow Capability Analysis](./2026-09-10%20RAGFlow%20Capability%20Analysis.md)** — Research input. What RAGFlow's auto-keyword, auto-question, auto-metadata, tag sets, knowledge graph and RAPTOR features actually do, their relative token costs, and an explicit split of what transfers to iHub versus what would be a mistake to copy.

## Context

iHub Apps has no index of its own. Sources (`filesystem`, `url`, `ifinder`, `page`) are whole-document prompt context, and retrieval is delegated to iFinder — there is no chunking, no embeddings and no vector store in the server. That is a deliberate boundary: IntraFind's search engine is the retriever, and iHub should not ship a second one.

What is missing is durability of insight. The workflow engine already runs sophisticated document analysis (`corpus-analysis-decomposed-v2` chains query planning, per-document evidence extraction, quote validation and synthesis), but everything it derives lives in workflow state and dies with the run. Nothing accumulates, nothing is queryable, nothing is readable afterwards, and the next run re-pays the full token cost.

The Knowledge Layer makes derived knowledge a first-class stored resource: cumulative, browsable as a wiki, and reusable by retrieval — while retrieval engines stay pluggable underneath.

## Status

Draft, pending review. The cost asymmetry in the design (§11) is the key point for the review: the per-document tier costs roughly 1–2% of the per-chunk tier on the same corpus, so phase 0 is the recommendation and the graph phases should be re-argued against real data rather than pre-approved.
