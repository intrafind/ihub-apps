# RAGFlow Capability Analysis — What It Actually Builds

**Date:** 2026-09-10
**Status:** Research input for the [Knowledge Layer design](./2026-09-10%20Knowledge%20Layer%20and%20LLM%20Wiki%20Design.md)
**Purpose:** Establish precisely what RAGFlow's document-analysis features do, so the iHub design copies the *ideas* that transfer and not the architecture that doesn't.

---

## 1. Why this document exists

"RAGFlow can build a knowledge graph and extract concepts" is easy to say and easy to get wrong. RAGFlow's document intelligence is five separate features with different costs, different outputs, and different retrieval behaviour. Two of them are cheap and high value; one of them is expensive enough that RAGFlow's own documentation warns you off it. Any iHub design that treats them as one switch will mis-budget by an order of magnitude.

Everything below is a per-dataset (knowledge base) setting in RAGFlow, applied at parse time. RAGFlow requires you to pick an **indexing model** per dataset — the chat model used to generate the knowledge graph, RAPTOR, auto-metadata, auto-keyword and auto-question artifacts. That single fact is the most important structural point: **all of these features are LLM passes over content at ingest time**, not query-time behaviour.

---

## 2. The five features

### 2.1 Auto-keyword

A chat model generates *N* keywords or synonyms from each chunk. Configured as a slider (an integer; a non-integer like `1.7` rounds down). The stated purpose is to "correct errors and enhance retrieval accuracy" — i.e. it patches vocabulary mismatch between how a document phrases something and how a user asks about it.

- **Granularity:** per chunk.
- **Cost:** one LLM call per chunk, at ingest.
- **Retrieval effect:** keywords are indexed alongside the chunk, so a query matching a synonym matches the chunk.

### 2.2 Auto-question

A chat model generates *N* questions (who/what/why) that each chunk answers. Documented as improving "the matching of user queries", and explicitly aimed at "FAQ retrieval scenarios involving product manuals or policy documents".

- **Granularity:** per chunk.
- **Cost:** one LLM call per chunk, at ingest.
- **Retrieval effect:** this is query-to-query matching rather than query-to-document matching. A user question is compared against generated questions, which are far closer in form to a query than prose is. This is the single highest-leverage trick in the list.

### 2.3 Auto-metadata

An LLM pass extracts document-level metadata fields, which then become retrieval filters.

- **Granularity:** per document.
- **Cost:** roughly one LLM call per document — the cheapest feature per unit of value.

### 2.4 Tag sets

A *tag set* is a dataset whose only job is to hold tags. Auto-tagging maps tags from user-defined tag sets onto chunks **by similarity with each chunk**. You configure which tag set(s) a dataset uses, then re-parse to trigger tagging.

The important distinction: this is **classification against a controlled vocabulary**, not open-ended extraction. Auto-keyword invents vocabulary; tag sets constrain it. For enterprise use — where taxonomies already exist and matter — the constrained version is usually the one you want, and it is notably cheaper because similarity matching, not generation, does the work.

### 2.5 Knowledge graph (GraphRAG)

RAGFlow inserts a graph-construction step between extraction and indexing, creating **additional chunks** from the ones the chunking method produced. From the implementation:

| Stage | Mechanism |
|-------|-----------|
| Entity + relation extraction | Two strategies: a standard extractor asking for "richer typed entities, relations, and iterative gleanings", and a `light` variant that trims scope to cut cost and latency |
| Entity resolution | An LLM-assisted equivalence pass that "batches candidate pairs, checkpoints progress, merges nodes and edges by connected components, and recomputes PageRank after the merge" |
| Community detection | Leiden clustering over the graph |
| Community reports | Structured JSON per community: **title, summary, impact rating, and findings** |
| Storage | Artifacts live *in the document store itself* — the global graph, per-document subgraphs, entity chunks and relation chunks — with entities and relations embedded for vector search |
| Retrieval (`KGSearch`) | Rewrites the question into keywords → finds entity candidates via keyword *and* embedding signals → expands N-hop paths → folds in community reports → normalises everything into chunk-shaped bundles |

RAGFlow's documentation is blunt about the trade-off: constructing a knowledge graph "requires significant memory, computational resources, and tokens", and is worth it for "multi-hop question-answering involving nested logic", books, and "works with complex entities and relationships".

Two details deserve emphasis because they are the parts most re-implementations get wrong:

1. **Entity resolution is not optional.** Without the merge pass, "Dr. Meier", "Meier, A." and "Andreas Meier" are three nodes and the graph is worthless. The merge is itself LLM-driven over candidate pairs, which is where a large slice of the token cost lives.
2. **Community reports are the actual product.** The graph enables them; the reports are what retrieval consumes. A title + summary + findings per cluster *is* an auto-generated wiki article. This is the mechanism behind "something like an LLM wiki".

### 2.6 RAPTOR (adjacent, same budget)

RAPTOR — Recursive Abstractive Processing for Tree Organized Retrieval — recursively clusters and summarises chunks into a hierarchical tree, so retrieval can hit a summary node instead of scattered leaves. Also aimed at multi-hop QA and long documents.

- `use_raptor` defaults to `false`.
- **Threshold** sets the minimum similarity for chunks to cluster together: default `0.1`, max `1`. Higher threshold → fewer chunks per cluster.
- Available when the chunk method is one of `qa`, `manual`, `paper`, `book`, `laws`, `presentation`.

RAPTOR and the knowledge graph solve overlapping problems by different means: RAPTOR builds hierarchy over *text*, GraphRAG builds structure over *entities*. RAPTOR is materially cheaper — clustering is mechanical and only summarisation costs tokens, with no O(pairs) resolution step.

### 2.7 Chunking as the foundation

All of the above sit on RAGFlow's layout-aware chunking templates (`naive`, `qa`, `paper`, `book`, `laws`, `presentation`, `table`, `picture`, `resume`, `one`). Chunk quality bounds every derived artifact: keywords, questions, entities and clusters are all only as good as the chunk boundaries they were computed over. RAGFlow's differentiator is arguably this parsing layer rather than the LLM passes on top of it.

---

## 3. Cost model, made explicit

Let *D* = documents, *C* = chunks per document, *E* = entities extracted.

| Feature | LLM calls at ingest | Scales with |
|---------|--------------------|-------------|
| Auto-metadata | ~*D* | documents |
| Auto-keyword | ~*D·C* | chunks |
| Auto-question | ~*D·C* | chunks |
| Tag sets | 0 generative (similarity matching) | chunks (embedding only) |
| RAPTOR | ~clusters per level × levels | chunks, sub-linear |
| Knowledge graph | ~*D·C* (extraction) + candidate-pair batches (resolution) + communities (reports) | chunks **and** entity pairs |

A 500-document corpus at 40 chunks per document is 20,000 chunks. Auto-keyword *and* auto-question on that corpus is ~40,000 LLM calls before a single user question is asked. Graph construction on the same corpus adds another 20,000 extraction calls plus resolution and report passes. This is the number that decides the phasing in the iHub design: the per-document tier costs ~500 calls for the same corpus — roughly 1–2% of the chunk-level tier — and delivers a large share of the practical benefit.

---

## 4. What transfers to iHub Apps, and what does not

**Transfers well** — these are ideas, not infrastructure:

- **Reference questions per unit of content.** Cheap, provider-agnostic, and the best matching trick available. Works with a purely lexical index.
- **Document-level dossiers** (summary + keywords + typed metadata). Nearly free per document; immediately useful as prompt context, as retrieval filters, and as human-readable pages.
- **Controlled-vocabulary tagging** over open-ended keyword generation. iHub's enterprise deployments already have taxonomies.
- **Community/cluster reports as generated articles.** This is the "LLM wiki" and it is worth building — but as the *last* phase, since it depends on everything above it.
- **A separate indexing model.** Enrichment is bulk, latency-insensitive and budget-sensitive; it should never be pinned to the interactive chat model. iHub's per-app `preferredModel` has no equivalent notion of a cheap bulk-processing model.

**Does not transfer** — this is where copying RAGFlow would be a mistake:

- **Owning the parser, chunker, embedder and vector store.** RAGFlow is a complete RAG engine. iHub deliberately is not: retrieval is delegated to iFinder (`CorpusSearchNodeExecutor`, `iFinderService.search`), and non-iFinder sources are whole-file prompt context with no chunk identity at all. Rebuilding RAGFlow's stack inside iHub means shipping a second, weaker retrieval engine next to IntraFind's actual product.
- **Dataset-scoped permissions.** A RAGFlow dataset is effectively single-tenant, so a community report synthesised across all its documents raises no access question. iHub is group-permissioned per source and per app, so a single article synthesised from documents with differing ACLs is a data-leak vector. This has no RAGFlow analogue and needs a first-class answer.
- **Storing graph artifacts as embedded chunks in the search index.** That only works if you control the index. iHub cannot: `iFinderService` exposes `search`, `getContent`, `getMetadata`, `discover`, `download` and `resolveDocumentLink` — all read paths. There is **no write-back or ingest API**, so derived artifacts cannot be pushed into iFinder's index from iHub as things stand. The knowledge layer must own its own store.

---

## 5. Sources

- [Auto-keyword Auto-question | RAGFlow](https://ragflow.io/docs/autokeyword_autoquestion)
- [Auto-Extract Metadata | RAGFlow](https://ragflow.io/docs/auto_metadata)
- [Use tag set | RAGFlow](https://ragflow.io/docs/use_tag_sets)
- [Construct knowledge graph | RAGFlow](https://ragflow.io/docs/dev/construct_knowledge_graph)
- [Enable RAPTOR | RAGFlow](https://ragflow.io/docs/dev/enable_raptor)
- [GraphRAG implementation walkthrough — RAGFlow Field Guide](https://doc.holiday/library/ragflow/graphrag/)
- [Introduction to RAGFlow: Open-Source RAG Engine with Deep Document Understanding](https://www.pondhouse-data.com/blog/introduction-to-ragflow)
- [infiniflow/ragflow — `rag/raptor.py`](https://github.com/infiniflow/ragflow/blob/main/rag/raptor.py)
- [infiniflow/ragflow — `docs/guides/dataset/use_tag_sets.md`](https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/use_tag_sets.md)
