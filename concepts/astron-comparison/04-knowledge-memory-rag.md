# Knowledge / RAG / Memory — astron-agent vs ihub-apps

> Gap analysis comparing iFlytek's open-source **astron-agent**
> (`core/knowledge`, `core/memory`) against **ihub-apps** (this repo).
> Scope: doc ingestion, embeddings, vector retrieval, citation, knowledge
> graph, and agent memory (short-term, long-term, episodic, semantic).
> Research only — no code changed.

---

## 1. astron-agent

`core/knowledge/` is a Python/FastAPI microservice (`main.py`, port 20010,
pyproject lists `ragflow-sdk==0.13.0`, `openai>=2.7.1`, `redis`, `sqlmodel`,
`boto3`) that exposes a RAG abstraction layer over **three pluggable
backends**:

- **RAGFlow** (default, OSS engine — embeddings + vector store + parser)
- **iFLYTEK Xinghuo (Spark) Knowledge Base** (`XINGHUO_DATASET_ID`)
- **AIUI** (iFlytek voice/dialog platform)
- **SparkDesk / CBG** also wired

Source: [`core/knowledge/service/`](https://github.com/iflytek/astron-agent/tree/main/core/knowledge/service)
contains `rag_strategy.py` (abstract base) +
[`rag_strategy_factory.py`](https://github.com/iflytek/astron-agent/blob/main/core/knowledge/service/rag_strategy_factory.py)
+ `impl/{aiui,cbg,ragflow,sparkdesk}_strategy.py`. Each strategy implements
the same async contract.

### 1.1 RAG strategy contract (`rag_strategy.py`)

| Method            | Purpose                                                                   |
| ----------------- | ------------------------------------------------------------------------- |
| `query()`         | Semantic search; params: `doc_ids`, `repo_ids`, `top_k`, `threshold`      |
| `split()`         | Chunk file/URL into fragments (length range, overlap, separators, titles) |
| `chunks_save()`   | Persist chunks (doc/group/user IDs)                                       |
| `chunks_update()` | Update chunk text/metadata                                                |
| `chunks_delete()` | Remove by chunk ID                                                        |
| `query_doc()`     | Retrieve all chunks for a document                                        |
| `query_doc_name()`| Document metadata + chunk count                                           |

All methods are async; `**kwargs` left open for backend-specific extras.

### 1.2 Ingestion pipeline

- File upload accepted as `UploadFile` or URL/path; routed to backend.
- RAGFlow strategy: `_process_document_upload` →
  `ragflow_client.upload_document_to_dataset` → `wait_for_parsing` (300 s
  poll) → `fetch_all_document_chunks` (fail-closed multi-page paging).
- Xinghuo: `upload` then `split` with Base64-encoded separators.
- Per-dataset `asyncio.Lock` prevents race conditions when two requests
  create the same KB.
- "Blue-green" updates: new version uploaded + parsed + verified before
  old version deleted.
- File types: delegated to backend parsers (RAGFlow handles PDF, Office,
  HTML, etc.; not enumerated in code).
- OCR: not in `core/knowledge`; RAGFlow does it externally.

### 1.3 Retrieval

- RAGFlow query: `top_k` default **6**, `vector_similarity_weight`
  default **0.2** (= hybrid: 80% BM25, 20% vector — keyword-leaning).
- `RagflowQueryExt` extras: `vector_weight`, **reranking**,
  **knowledge-graph traversal**, **highlighting** (passed straight to
  RAGFlow API).
- Xinghuo's `new_topk_search`: hybrid + overlap-chunk **context
  reconstruction** (sorts neighbors by `dataIndex` to rebuild surrounding
  prose), plus **image-reference extraction**.
- Optional **LLM query rewriting** layer: an LLM generates search-optimised
  variants of the user question before retrieval.

### 1.4 Knowledge-enhanced chat flow

(`deepwiki.com/iflytek/astron-agent/8.3-knowledge-enhanced-chat-flow`)

- Bot config flag `supportDocument` toggles enhancement per-session.
- `knowledgeService.getChuncksByBotId(botId, ask, 3)` retrieves chunks
  via `KnowledgeV2ServiceCallHandler` (POST to knowledge-engine URL).
- I18n prompt wrappers `loose.prefix.prompt` + `loose.suffix.prompt`
  splice chunks around the user question.
- **Chunks persisted to `req_knowledge_records` table keyed by request
  ID** → on multi-turn, history reconstruction re-wraps the same chunks
  so the context stays stable.
- Token-budget guard `spark.chat.max.input.tokens` (default 8000) with
  dynamic history truncation.

### 1.5 Citation / grounding

Not explicitly implemented in `core/knowledge`. Citations bubble up via
RAGFlow's chunk metadata (doc ID, position, highlight) but there is no
post-LLM citation verification. Knowledge-graph linking is delegated to
RAGFlow's `use_kg` flag.

### 1.6 Memory module

[`core/memory/database/`](https://github.com/iflytek/astron-agent/tree/main/core/memory/database)
— **important finding: this is _not_ a semantic/episodic memory engine.**
It is the "Xingchen DB" service: a multi-tenant SQL-execution gateway.

- Stack: FastAPI + SQLAlchemy 2 + SQLModel + Alembic;
  drivers `asyncpg`, `psycopg2-binary`, `aiomysql`, `pymysql`;
  Redis for cache; no vector libraries.
- Routes (`api/router.py`, prefix `/xingchen-db/v1`):
  - `create_db`, `drop_db`, `modify_db_description`
  - `exec_ddl` (validated AST reconstruction)
  - `exec_dml` (SQL rewriting injects `uid` filter)
- Schema isolation: `{env}_{uid}_{database_id}` namespacing + row-level
  `uid` filter + API-level ACL. Multi-tenant by construction.
- It backs agent-authored facts/state — closer to a "tool that can read
  and write its own tables" than to LLM-style long-term memory.

### 1.7 Conversation history

Lives in `core/agent` (Java/Spring Boot console + Python engine).
`ChatHistoryServiceImpl.getSystemBotHistory` joins prior request pairs
with `req_knowledge_records` to rebuild the historical RAG-augmented
context. Storage = MySQL + Redis (per `docs/CONFIGURATION.md`).
No explicit semantic-/episodic-memory layer; no summarisation pipeline
documented.

### 1.8 Embedding model

Not implemented in-house — outsourced to RAGFlow (which ships its own
embedder choice: e.g. BGE, BAAI, OpenAI). astron-agent calls `openai>=2.7.1`
elsewhere but `core/knowledge` itself never calls `embeddings.create`.

### Sources

- [astron-agent README](https://github.com/iflytek/astron-agent)
- [`core/knowledge`](https://github.com/iflytek/astron-agent/tree/main/core/knowledge)
- [`core/knowledge/service/rag_strategy.py`](https://github.com/iflytek/astron-agent/blob/main/core/knowledge/service/rag_strategy.py)
- [`core/knowledge/service/impl/ragflow_strategy.py`](https://github.com/iflytek/astron-agent/blob/main/core/knowledge/service/impl/ragflow_strategy.py)
- [`core/knowledge/api/v1/api.py`](https://github.com/iflytek/astron-agent/blob/main/core/knowledge/api/v1/api.py)
- [`core/memory/database`](https://github.com/iflytek/astron-agent/tree/main/core/memory/database)
- [`docs/CONFIGURATION.md`](https://github.com/iflytek/astron-agent/blob/main/docs/CONFIGURATION.md)
- DeepWiki: [Knowledge & RAG](https://deepwiki.com/iflytek/astron-agent/3.4-knowledge-service-and-rag),
  [Memory DB](https://deepwiki.com/iflytek/astron-agent/7-memory-database-service),
  [Knowledge-enhanced chat](https://deepwiki.com/iflytek/astron-agent/8.3-knowledge-enhanced-chat-flow),
  [RAGFlow integration](https://deepwiki.com/iflytek/astron-agent/13.2-ragflow-knowledge-base-integration)

---

## 2. ihub-apps

ihub-apps has **no vector store, no embeddings, no chunking, no rerank, no
agent memory**. Verified by `grep -ri "embedding\|vector\|chroma\|qdrant\|
pinecone\|weaviate" server/` — zero hits in product code (only telemetry
attribute names and OCR comments).

What ihub _does_ have is a **"sources" subsystem**: pluggable handlers
that fetch whole documents from a few backends and dump them, verbatim,
into the system prompt. It is closer to RAGFlow-without-the-RAG.

### 2.1 Source handlers (`server/sources/`)

| Handler             | File                                              | Backend                              |
| ------------------- | ------------------------------------------------- | ------------------------------------ |
| `SourceHandler`     | `server/sources/SourceHandler.js:1-131`           | Abstract base + in-memory TTL cache  |
| `FileSystemHandler` | `server/sources/FileSystemHandler.js:1-419`       | Reads `contents/sources/*.{md,txt}`  |
| `URLHandler`        | `server/sources/URLHandler.js:1-300`              | `webContentExtractor` tool / fetch   |
| `IFinderHandler`    | `server/sources/IFinderHandler.js:1-278`          | IntraFind iFinder (external search)  |
| `PageHandler`       | `server/sources/PageHandler.js:1-402`             | `contents/pages/{lang}/{id}.{md,jsx}`|
| `SourceManager`     | `server/sources/SourceManager.js:1-793`           | Registry + tool generator            |

Common shape: `loadContent(config) → { content: string, metadata: {…} }`.
Caching is a per-process `Map` with TTL (default 3600 s) keyed off a
JSON-stringified config (`SourceHandler.js:30-49`).

### 2.2 Injection mechanism

- `SourceManager.loadSources()` concatenates every source's full text
  into one giant string and wraps each in `<source id=… type=… link=…>`
  XML tags (`SourceManager.js:177-181`).
- `PromptService.processMessageTemplates()`
  (`server/services/PromptService.js:276-346`) replaces `{{sources}}`
  (or legacy `{{source}}`) in the app's system prompt with that
  concatenated content; otherwise it _appends_ a `Sources:\n<sources>…
  </sources>` block to the system prompt.
- `SourceResolutionService`
  (`server/services/SourceResolutionService.js:31-108`) resolves admin-
  configured source IDs (`contents/config/sources.json`) into runtime
  handler configs, with a 5-minute resolution cache.
- Sources can also be exposed `exposeAs: 'tool'`
  (`SourceManager.js:230-251, 326-379`) — the LLM gets a `source_<id>`
  function tool and decides when to call it. This is the closest thing
  ihub has to dynamic retrieval, but the "tool" still returns the
  entire pre-fetched document, not a vector-ranked passage.

### 2.3 Config & schema

- `server/validators/sourceConfigSchema.js:1-360`: Zod discriminated
  union on `type ∈ {filesystem, url, ifinder, page}`. No chunk size,
  embedding model, vector store, top-k, or rerank fields anywhere.
- `server/defaults/config/sources.json`: example FAQ Markdown +
  www.intrafind.com URL sources.
- Admin CRUD: `server/routes/admin/sources.js`.

### 2.4 Conversation persistence (= short-term "memory")

- `server/services/integrations/ConversationStateManager.js:1-123`:
  in-memory `Map<chatId, state>` with 24 h TTL and hourly cleanup.
  Tracks `conversationId`, `lastParentId`, `title`, `baseUrl`,
  `profileId`. **Single-process only — no Redis/DB.**
- `server/routes/chat/conversationRoutes.js:1-268`: GET/DELETE
  message-history endpoints that **proxy to the external iAssistant
  API** (`/apps/:appId/conversations/:conversationId/messages`). ihub
  itself never stores past messages.
- `ConversationApiService` and `iAssistantService.js:1-46` are thin
  wrappers; the iAssistant adapter
  (`server/adapters/iassistant-conversation.js:117,153`) is the only
  code path that ever round-trips a conversation ID — and only for
  IntraFind's own RAG product.
- For all _other_ providers (OpenAI, Anthropic, Google, Mistral,
  Bedrock, vLLM, openai-responses), conversation history is rebuilt
  client-side and re-sent on every request (`RequestBuilder.js:293-
  304, 382-396`). `sendChatHistory: boolean` on each app config
  (default `true`, see `CLAUDE.md` § "App Configuration Schema") just
  toggles whether the client passes prior turns back.
- `feedbackStorage.js:1-97` appends thumbs-up/down to
  `contents/data/feedback.jsonl`. That's the only persistent
  per-message store; it is **not** read back during chat — pure
  analytics.

### 2.5 User-fingerprint / per-user state

`server/services/UserFingerprint.js:1-70`: pseudonymous SHA-256
`usr_<16hex>` of `userId + pepper`. Used for usage tracking only — no
user-profile / preference memory store.

### 2.6 Where the LLM ends up

`RequestBuilder.prepareChatRequest`
(`server/services/chat/RequestBuilder.js:115-422`) calls
`processMessageTemplates`, which substitutes sources into the system
prompt, then ships the entire conversation + source text to the model
adapter. Token budget = `min(app.tokenLimit, model.tokenLimit)`
(`RequestBuilder.js:330-339`). There is **no chunk-level scoring**: if
your three sources total 200 k tokens you'll blow the context window.

### 2.7 Honest summary

ihub treats "knowledge" the 2023 way: paste whole docs into the system
prompt, lean on long-context models. Fine for FAQ-sized corpora; does
not scale to thousands of docs, does not ground answers in citations,
does not survive across sessions, does not learn about the user.

---

## 3. Gap matrix

| #  | Capability                                | astron-agent                                       | ihub-apps                                 | Severity | Notes                                                                  |
| -- | ----------------------------------------- | -------------------------------------------------- | ----------------------------------------- | -------- | ---------------------------------------------------------------------- |
| 1  | Embedding generation                      | Via RAGFlow / Xinghuo (BGE, etc.)                  | None                                      | **High** | Foundational for anything below                                        |
| 2  | Vector store                              | RAGFlow / Xinghuo                                  | None                                      | **High** | No backend wired                                                       |
| 3  | Chunking pipeline                         | `split()` with length range, overlap, separators   | None — whole-document only                | **High** | All-or-nothing prompt bloat today                                      |
| 4  | Document parsing (PDF/Office/HTML)        | RAGFlow                                            | Partial: `webContentExtractor`, OCR tool, DOCX/MSG/EPUB upload only | **Med-High** | Has the readers, lacks the indexing |
| 5  | Top-k retrieval                           | `top_k`, `threshold` params                        | None                                      | **High** | n/a without vectors                                                    |
| 6  | Hybrid search (BM25 + vector)             | `vector_similarity_weight` default 0.2             | None                                      | Med      | Most RAG wins come from hybrid                                         |
| 7  | Reranker                                  | RAGFlow `rerank=true` flag                         | None                                      | Med      | Big quality lever once vectors exist                                   |
| 8  | LLM query rewriting                       | Yes                                                | None                                      | Low-Med  | Cheap to add post-vectorisation                                        |
| 9  | Citation / grounding (attribution)        | Chunk-level metadata (doc id, position)            | `<source link=…>` XML tag only            | Med      | ihub UI already renders the tag                                        |
| 10 | Knowledge graph                           | RAGFlow `use_kg`                                   | None                                      | Low      | Niche; skip in v1                                                      |
| 11 | Multi-backend RAG abstraction             | Strategy + factory (4 impls)                       | Source handler abstraction exists         | Low      | We can extend, not rebuild                                             |
| 12 | Document CRUD API                         | `/dataset/create`, `/document/{upload,split,…}`    | Admin `routes/admin/sources.js` (CRUD source defs only) | High | Need ingestion endpoint                                |
| 13 | Per-dataset locks (concurrent ingest)     | `asyncio.Lock` per dataset                         | n/a                                       | Low      | Easy in Node                                                           |
| 14 | Conversation persistence (long-term)      | MySQL + Redis (`req_knowledge_records`, history)   | In-memory `Map`, 24 h TTL, single process | **High** | Breaks multi-replica deployments                                       |
| 15 | Semantic / episodic / working memory      | None (out of scope for astron too)                 | None                                      | Med      | Greenfield opportunity                                                 |
| 16 | Per-user profile memory                   | None                                               | None                                      | Med      | Pair with #15                                                          |
| 17 | Conversation summarisation                | Token-budget truncation only                       | None                                      | Med      | Necessary as windows grow                                              |
| 18 | Multi-tenant SQL data service             | Xingchen DB (`/xingchen-db/v1`)                    | None                                      | Low      | Reuse iFinder/Jira instead                                             |
| 19 | Concurrent upload safety / blue-green     | Yes                                                | n/a                                       | Low      | Easy follow-up                                                         |
| 20 | OpenTelemetry tracing of retrieval        | Spans + counters around every call                 | Has `recordSourceLoad` (`SourceManager.js:8,149`) | Low | Parity already                                                  |

---

## 4. What we should reimplement (ranked)

### #1 — In-process vector RAG: chunk → embed → retrieve (XL, must-have)

**Rationale:** every other gap (#1–#8) collapses into this one. Without
a vector index ihub cannot serve corpora bigger than the model's context
window. This is the headline parity feature with astron-agent.

**Scope:** XL. **Risk:** medium (no embedding/vector dep today; needs
careful backend selection). **Deps:** none (it bottoms-out the stack).

### #2 — Persistent, recall-aware conversation memory (L, must-have)

**Rationale:** `ConversationStateManager`'s in-memory `Map` already
breaks the moment we run two server replicas. astron persists chat
history in MySQL; we need at least SQLite/Postgres-backed conversation
storage plus a recall API the chat builder can call.

**Scope:** L. **Risk:** low-medium (touches auth + clustering).
**Deps:** existing config/migration patterns; benefits from #1 for
"semantic recall over prior turns."

### #3 — Long-term memory (user-profile + episodic) with summarisation (L, should-have)

**Rationale:** the genuinely _agentic_ leap astron-agent has _not_ made
either. ChatGPT-style "memory" — derived facts ("user prefers German",
"works at Acme, on Project X"), surfaced into future system prompts.
Episodic summarisation compresses old turns to make room for new ones.

**Scope:** L. **Risk:** medium (privacy/UX). **Deps:** #1 (semantic
recall), #2 (storage substrate).

### #4 — Reranker hook + hybrid retrieval (M, should-have)

Once #1 lands, add BM25 alongside vector and a pluggable cross-encoder
reranker (Cohere Rerank, BGE-reranker, local). Single biggest quality
lever on top of vanilla top-k.

### #5 — Citation/grounding UI + answer-verification pass (M)

Already 80 % done in the system prompt (`<source link=…>` tags). Need
a post-LLM step that asserts every claim cites a chunk, plus a chat-UI
"jump to source" affordance.

### #6 — Ingestion REST endpoints + admin UI (M)

Parity with astron's `/document/upload` + `/document/split` + chunk CRUD.
Lets non-developers feed PDFs/URLs/Confluence into a knowledge base
without editing JSON.

### #7 — Query rewriting + multi-query fan-out (S)

Cheap LLM-side win; queue behind #4.

### #8 — Knowledge graph (XL, won't-do for v1)

Skip. astron-agent only exposes a flag; the heavy lifting lives in
RAGFlow. Wait for evidence of demand.

---

## 5. Implementation outline (top 3)

### 5.1 In-process vector RAG (#1)

**Module layout**

```
server/services/rag/
  index.js                  // public API: ingest, search, deleteDoc
  RagService.js             // orchestrator
  embedders/
    BaseEmbedder.js
    OpenAIEmbedder.js       // text-embedding-3-small/large
    AnthropicEmbedder.js    // via Voyage when available
    LocalEmbedder.js        // BGE-small via @xenova/transformers
  vectorStores/
    BaseVectorStore.js
    SqliteVssStore.js       // default
    PgVectorStore.js        // opt-in
    LanceDbStore.js         // opt-in
  chunkers/
    RecursiveTextChunker.js // langchain-style
    MarkdownChunker.js
    HtmlChunker.js
  parsers/
    PdfParser.js            // pdf-parse / pdfjs
    DocxParser.js           // mammoth (already in repo)
    HtmlParser.js           // html-to-text (already in repo)
contents/
  knowledge/
    {kbId}/
      index.sqlite          // sqlite-vss DB
      docs/                 // raw blobs
```

**Vector backend recommendation: `sqlite-vss` (better-sqlite3 +
sqlite-vss extension), opt-in `pgvector`.**

Tradeoffs:

| Backend     | Pros                                                  | Cons                                  |
| ----------- | ----------------------------------------------------- | ------------------------------------- |
| **sqlite-vss** | Zero-install (ships with native bin), file-per-KB, fits ihub's existing "drop a JSON into `contents/`" mental model, works in Docker | Not great > 5 M vectors; single-writer |
| pgvector    | Production-grade, multi-replica safe, SQL joins       | Adds Postgres dep, not in current stack |
| lancedb     | Columnar/Arrow, multi-modal, JS-native                | Younger, smaller ecosystem            |
| chroma      | Easy local mode                                       | Python-first; HTTP hop                |
| qdrant      | Best filters + payload + perf                         | Extra service to operate              |
| weaviate    | Hybrid out of the box                                 | Heavy                                 |

**Recommendation:** ship `sqlite-vss` by default (matches the
"single-folder install" ergonomics of `contents/`), expose a
`platform.rag.vectorStore` enum so admins can switch to `pgvector` when
they outgrow it. Schema lives in `server/migrations/V0??__add_rag_tables.js`
(uses the existing Flyway-style migration system documented in
`CLAUDE.md` § "Configuration Migration System").

**Embedding strategy**

- Reuse the existing LLM adapter abstraction
  (`server/adapters/index.js`) where the provider supports embeddings
  (OpenAI, Bedrock-Titan, Cohere, etc.). Add an `embed()` method to
  `BaseAdapter`.
- Fallback: bundle `@xenova/transformers` BGE-small (Apache-2, runs in
  Node) so air-gapped deployments work out-of-the-box.
- Embedding model is per-KB (recorded in `index.sqlite` metadata table);
  re-indexing required to change it.

**Ingestion pipeline**

`POST /api/admin/knowledge/:kbId/documents` (multipart):

1. Path-security check (reuse `utils/pathSecurity.js`).
2. Parser → text (PDF / DOCX / HTML / MD / TXT).
3. Chunker (default: recursive 800-token chunks, 100-token overlap;
   configurable).
4. Embed batches of 100 chunks.
5. Upsert `(kb_id, doc_id, chunk_id, text, embedding, metadata)`.

Job is sync for files < 10 MB, queued (BullMQ / in-mem queue) above.

**Retrieval API**

`server/services/rag/RagService.search(kbId, query, {topK, filter,
hybrid, rerank})` returns `[{ chunkId, text, score, doc, link, …meta }]`.

Integration: extend `SourceHandler` with a new `KnowledgeBaseHandler`
(`server/sources/KnowledgeBaseHandler.js`) — it implements `loadContent`
by calling `RagService.search()` with the **user's last message** as
the query (already plumbed via `chatId` + `userVariables`). This lets
KBs slot into the existing `app.sources` config with **zero churn** in
`PromptService` (`server/services/PromptService.js:276-346`).

**Tests:** unit for chunkers + embedder mocks; integration loading
`contents/sources/faq.md` and verifying top-1 chunk includes the
expected answer; perf test 10 k chunks @ p95 < 200 ms.

### 5.2 Persistent conversation memory (#2)

**Module layout**

```
server/services/memory/
  ConversationStore.js      // persistent replacement
  ChatMessageRepo.js        // CRUD on messages
  RecallService.js          // semantic recall over prior turns
```

**Backend:** SQLite (default) → Postgres (opt-in), same dual-mode as
RAG. Tables:

```sql
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  title TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata JSON
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_calls JSON,
  embedding BLOB,           -- optional, fills #1's vector index
  tokens INTEGER,
  created_at INTEGER NOT NULL
);
```

Migration: `server/migrations/V0??__add_conversation_persistence.js`.

**Refactor:** `ConversationStateManager` (`server/services/integrations/
ConversationStateManager.js:1-123`) keeps its in-memory map as an LRU
cache fronting `ConversationStore`. Public surface unchanged → no client
breakage.

**Recall:** `RecallService.findRelevantTurns(conversationId, query, k)`
runs a vector query over the per-conversation embedding column. Hooked
into `PromptService` immediately after source resolution to inject a
`<recalled_turns>` block when relevance > threshold. Behind feature flag
`features.conversationRecall`.

**Privacy:** per-user encryption at rest using the existing
`TokenStorageService` (AES-256-GCM, see `CLAUDE.md` § "Secret encryption
at rest"). Reuse `contents/.encryption-key`.

**Tests:** clustering integration (two workers, one writes, the other
reads); TTL eviction with persistence; embedding backfill for legacy
in-memory conversations.

### 5.3 Long-term memory + summarisation (#3)

**Module layout**

```
server/services/memory/
  UserMemoryStore.js        // append-only fact log per user
  MemoryExtractor.js        // LLM job: chat → extracted facts
  SummariserService.js      // rolling conversation summaries
```

**Data**

```sql
CREATE TABLE user_memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  scope TEXT,               -- 'global' | appId
  kind TEXT,                -- 'preference' | 'fact' | 'event'
  text TEXT NOT NULL,
  embedding BLOB,
  source_conversation_id TEXT,
  source_message_id TEXT,
  confidence REAL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  metadata JSON
);
```

**Flow**

1. After every N turns or at conversation end, `MemoryExtractor`
   prompts an LLM (cheap model, e.g. `gpt-4o-mini`) with a strict
   JSON schema: `extracted: [{kind, text, confidence}]`.
2. Apply de-dup + confidence threshold; embed; upsert.
3. On new chat, `PromptService.resolveGlobalPromptVariables` (already
   the right injection point — `PromptService.js:66-147`) calls
   `UserMemoryStore.recall(userId, query, k=5)` and exposes the
   matches as `{{user_memory}}` placeholders.

**Summarisation**

`SummariserService` collapses turns older than the sliding window into
a `summary` row. Replaces astron's hard truncation. Triggered when
estimated prompt-budget > `model.tokenLimit * 0.7`.

**UI**

- Settings page `/settings/memory` (add route in `App.jsx`; remember to
  update `knownRoutes` in `client/src/utils/runtimeBasePath.js` per
  `CLAUDE.md` "When Adding New Routes").
- List, edit, delete user facts; toggle "memory off".
- Per-app override: `app.memory: { enabled, scope, ttl }` (schema
  extension in `server/validators/appConfigSchema.js`).

**Privacy / consent**

- Default **off**. Admin opt-in via `platform.json.features.userMemory`.
- Migration `V0??__add_user_memory_feature_flag.js` adds the default.
- GDPR export/delete endpoints reuse the auth + permissions framework.

**Tests:** evaluator harness — script a 3-conversation arc, assert
extracted facts, assert next conversation injects them, assert deletion
removes them.

---

## 6. Open questions

1. **Vector backend pick.** sqlite-vss vs pgvector vs lancedb hinges on
   expected corpus size (1 k vs 1 M docs) and whether v1 must support
   stateless replicas.
2. **Embedding-model licensing.** Is bundling `Xenova/bge-small-en`
   (Apache-2) acceptable for air-gapped installs, or provider-only?
3. **KB multi-tenancy.** astron isolates by `uid`; ihub uses groups.
   Do KBs belong to apps, users, or groups? Likely groups (matches
   `groups.json` / `allowedModels`).
4. **iAssistant overlap.** IntraFind's iAssistant already ships
   `/public-api/rag/...` (`server/adapters/iassistant-conversation.js:
   153`). Make our `RagService` _another_ source provider, parallel to
   `iFinder` — so installs can choose either, both, or neither.
5. **Reranker.** Cohere Rerank is external; can `@xenova/transformers`
   cross-encoders ship inside `npm run build:binary`?
6. **Memory-extraction cost.** Second LLM call per conversation doubles
   spend; need budget guardrails and an opt-out.
7. **Citation enforcement.** Force JSON-tagged citations or
   post-process with embedding-similarity? Affects #5 scope.
8. **KG / structured retrieval.** Defer to v2; no evidence yet.
9. **Conversation API parity.** `conversationRoutes.js` proxies to
   iAssistant today. Recommend a unified API with internal strategy
   switch — mirrors astron's RAG strategy pattern.
