# Competitive research: AnythingLLM (Mintplex Labs) vs iHub

Research date: 2026-11-03. Sources: GitHub releases page (github.com/Mintplex-Labs/anything-llm/releases, pages 1–2), the Desktop changelog (docs.anythingllm.com/changelog/v1.14.0 … v1.19.0), and a shallow clone of `main` (2026-11-03) (read only, nothing run).

## Versions covered (May–Oct 2026)

| Version | Date (2026) | Notes |
|---|---|---|
| v1.13.0 | 26 May | Model Router, Scheduled Jobs, Automatic Memories, Agent Surveys |
| v1.14.0 | 09 Jun | STT/TTS providers, embed deny-by-default, native tool calling on for all providers |
| v1.14.1 | 16 Jun | Meeting Assistant GPU/speakers, chat export PDF/JSON/MD, copy chat link, approval API for custom skills |
| v1.14.2 | 22 Jun | Groq STT, Brave / fastCRW search |
| v1.15.0 | 25 Jun | Desktop "Magic" features (Echo dictation, Beacon, Tab completions); tool reranker on by default |
| v1.16.0 | 13 Aug | `/img` image generation, create-scheduled-job tool, Gitea + GitHub Enterprise connectors, mid-session tool toggle, Whisper-compatible STT |
| v1.16.1 | 27 Aug | Unified activity / chain-of-thought UI, nav warning during inference |
| v1.16.2 | 22 Sep | Vertex AI, `generate-image` skill, You.com default search, optional agent-flow variables |
| v1.17.0 | 01 Oct | Reasoning-effort controls, Firecrawl search, Gemini image gen, workspace settings autosave |
| v1.18.0 | 13 Oct | Desktop: Lemond (AMD Lemonade) engine replaces Ollama; reasoning control in chat input; embed domain allowlist; atomic document sync |
| v1.19.0 | 26 Oct | Built-in LLM for Docker (`ENABLE_BUILT_IN_LLM`), colour palettes, Meeting Assistant tasks + API, agents save files to disk, max-output-token notice |

Desktop and Docker share version numbers. Desktop-only items are marked (D). The Meeting Assistant, Magic features and the desktop overlay are not in the open-source repo.

## Feature table

| # | Feature | Release | Description | iHub status | iHub evidence |
|---|---|---|---|---|---|
| 1 | **Model Router** | 1.13.0 (+1.16.0 cooldown fix, 1.19.0 mid-thread) | Per-workspace router. Priority-ordered rules: *calculated* (prompt contains/regex, token count, message count, hour of day, image attached) or *llm* (a small model classifies the prompt against rule descriptions). Fallback model, sticky routing per thread, cooldown | **MISSING** (proposal only) | `concepts/2026-10-20 Automatic Model Selection.md` (status: Proposal, sensitivity-first design). Nothing in `server/` |
| 2 | **Automatic memories** | 1.13.0 | Background job pulls facts about the user out of idle chats (Observer → Reflector LLM passes). Workspace and global memory banks, manual add/edit, promote/demote. Injected into the system prompt, reranked | **PARTIAL** | Agent memory and scheduled-task memory only: `server/services/memory/memoryService.js`, `docs/agents.md` (memory file), `docs/scheduled-tasks.md` (Remember between runs). No per-user memory extracted from chats |
| 3 | **Intelligent Tool Selection** (ToolReranker) | 1.12.0, default on in 1.15.0 | Embedding reranker picks the top-N (15) tools for each prompt before the LLM call; they claim up to 80% fewer tool tokens | **PARTIAL** | iHub narrows tools through app bindings and the chat integrations picker (`server/services/integrations/integrationPicker.js`, `docs/integrations.md`). No ranking per prompt or lazy tool loading |
| 4 | **Scheduled Jobs** | 1.13.0, 1.16.0 (agent tool) | Cron jobs that run an agent prompt with a chosen tool subset. Run history, unread state, web push. The agent can create jobs from chat (`create-scheduled-job`) | **HAVE** (push missing) | `docs/scheduled-tasks.md` (cron, run history, unread badge/toast, Notify-me modes, run memory, create from chat via scheduling tools), `server/tools/scheduledTaskTools.js`. No browser/OS push |
| 5 | **Agent Surveys / clarifying questions** | 1.13.0, 1.19.0 | `request-user-input` tool: up to 3 typed questions per turn (text/url/number/date/email/textarea), 120 s timeout, skip | **HAVE** | `docs/ask-user-tool.md`, `server/tools/askUser.js`, `server/services/loop/seams/questionSeam.js` |
| 6 | **Tool approval** (ask before running; env auto-approve list; approval API for custom skills; shows email body/recipients) | 1.12.0, 1.14.1, 1.19.0 | `requestToolApproval`, `AGENT_AUTO_APPROVED_SKILLS` | **HAVE** | `docs/tool-approval.md` (layered platform/installation/action modes) |
| 7 | **Embed chat widget** (domain allowlist, deny-by-default, limits per day/session, model/prompt/temp overrides, request size limit) | 1.14.0, 1.18.0, 1.19.0 | `<script>` widget for public websites, backed by `embed_configs` | **MISSING** | iHub has iframe embedding of *shared files/chats* only (`docs/chat-sharing.md` `embedEnabled`/`embedAllowedOrigins`), plus Nextcloud embed, browser extension, Outlook add-in. Drop-in widget listed as an idea in `concepts/astron-comparison/05-interfaces-console-api.md` §4 |
| 8 | **Image generation** (`/img`, generate-image skill, edits with reference images, several providers) | 1.16.0, 1.16.2, 1.17.0 | | **HAVE** | `docs/models.md` (`supportsImageGeneration`, `imageGeneration` defaults) |
| 9 | **Document generation agent** (txt, PDF, DOCX, XLSX, PPTX; save to local folder with approval) | 1.12.0, 1.19.0 | `plugins/create-files/{docx,pdf,pptx,xlsx,text}` | **HAVE** | `docs/pdf-generation.md`, `docs/document-templates.md` (corporate design), Excel/web artifacts in `docs/releases/next/features.md`. Saving to disk is desktop-only and not relevant |
| 10 | **Gmail / Outlook / Google Calendar agent skills** | 1.12.1 | Built-in skills to search, read, draft and send mail and work with calendars. Gmail goes through a Google Apps Script deployment, Outlook through Graph (tenant/common auth) | **PARTIAL** | Outlook add-in gives the open mail/meeting as context (`docs/outlook-add-in.md`). Office 365 integration covers files only (`docs/office365-integration.md`). No mail-send or calendar actions |
| 11 | **Data connectors**: GitHub/GitHub Enterprise/Gitea repo loader, Confluence, Drupal Wiki, Obsidian, Paperless-ngx, YouTube transcripts, website depth crawler, bulk link scraper (reads PDFs/files) | 1.16.0, 1.18.0, 1.19.0 | `collector/utils/extensions/*` | **PARTIAL** | Projects: upload, URL, site crawler (`server/services/projects/siteCrawler.js`, `docs/projects.md`), Office 365/Google Drive/Nextcloud/iFinder. Confluence and GitHub through MCP (`docs/integrations.md`). No YouTube transcripts or git repo import into a project |
| 12 | **Watched documents / atomic re-sync** | 1.16.2, 1.18.0 | Hourly `sync-watched-documents` job re-fetches watched docs, swaps vectors atomically, keeps run history (`document_sync_queues`/`executions`) | **PARTIAL** | URL items cached for 2 h. Cloud items refreshed by the user, with a `stale` state (`docs/projects.md`). No scheduled re-sync per item |
| 13 | **Vector RAG workspaces** (embedders, ~10 vector DBs, similarity threshold, reranking) | ongoing (1.18.0 threshold applied to memory, 1.19.0 Weaviate v3) | | **PARTIAL (by design)** | Projects use BM25 keyword search, no embeddings (`docs/projects.md:348`). Semantic search comes from iFinder |
| 14 | **Streamed embedding progress per file / queue** | 1.12.1, 1.19.0 | Progress for each document, files can be removed from the queue | **PARTIAL** | Project item states Waiting/Extracting/Ready/Failed/Outdated (`docs/projects.md`). No live per-file progress bar |
| 15 | **Reasoning-effort controls** (per chat, depends on provider) | 1.17.0, 1.18.0 | | **HAVE** | `thinkingEnabled`/`thinkingLevel` in `client/src/features/apps/components/SharedAppHeader.jsx`, `server/migrations/V105__thinking_level_not_budget.js` |
| 16 | **Max-output-token notice** | 1.19.0 | | **HAVE** | `client/src/features/chat/components/ChatMessage.jsx:1312` (`finishReason === 'length'`) |
| 17 | **Chat export PDF/JSON/MD + copy chat link** | 1.14.1 | | **HAVE** | `client/src/features/chat/components/ExportDialog.jsx` (pdf, docx, xlsx, pptx, md, json, jsonl, txt), `docs/chat-sharing.md` |
| 18 | **Mid-session tool toggle / tools menu in chat** | 1.13.0, 1.16.0 | | **HAVE** | Integrations picker and chips (`docs/releases/next/features.md` "Chat: Integrations Picker…") |
| 19 | **MCP tool manager** | 1.12.0, 1.19.0 | | **HAVE** | `docs/mcp-integration.md`, `docs/integrations.md` (iHub also has a gateway and MCP Apps) |
| 20 | **Agent flows** (no-code, variables, optional args) | 1.14.1, 1.16.2 | | **HAVE** | `docs/workflows.md` |
| 21 | **Meeting Assistant** (on-device recording, diarisation, summaries, **task extraction with due dates + notifications**, global hotkey, start/stop/search API) (D) | 1.14.1, 1.19.0 | | **PARTIAL** | Transcription with timestamps/speakers (`docs/voice-transcription.md`), Outlook meeting context, `meeting-knowledge-base` project. No recorder, task extraction, task inbox or meeting search API |
| 22 | **Telegram bot channel** (streaming, voice, attachments, workspace/thread switching) | 1.12.0 (ongoing) | `server/utils/telegramBot/` | **MISSING** | Only mentioned in concept comparisons. iHub channels: M365 Copilot agent, Outlook, Nextcloud, browser extension |
| 23 | **SQL agent** (several DB connections, SSL toggle) | 1.16.0 | `plugins/sql-agent` | **MISSING** | No SQL tool in `server/tools/`. Possible through a marketplace MCP server |
| 24 | **Colour palettes** (built-in Ocean/Forest/Plum/Ember/True Dark + custom main/accent with preview, chosen by the user) | 1.19.0 | `endpoints/themePalettes.js` | **PARTIAL** | Admin-wide theme colours and dark mode (`docs/ui.md` §theme). Users cannot pick a palette |
| 25 | **Web push notifications / PWA** | 1.11.0 (used by Scheduled Jobs) | `utils/PushNotifications` | **MISSING** (push) | A service worker exists (`client/src/services/swRegistration.js`) but has no Push API usage |
| 26 | **Built-in local LLM** (Lemonade/llama.cpp in the Docker image, GGUF from HF, NPU) | 1.18.0 (D), 1.19.0 (Docker) | | **MISSING** (out of scope?) | iHub connects to external local servers (`docs/local-llm-providers.md`) |
| 27 | **STT providers** (Whisper-compatible, Deepgram, Groq, OpenAI) | 1.14.x, 1.16.0 | | **HAVE** | `docs/voice-transcription.md` (openai/local Whisper-compatible, Google, Azure, browser) |

## Implementation deep-dives

### 1. Model Router (`server/models/modelRouter.js`, `server/models/modelRouterRule.js`, `server/utils/router/index.js`, `server/agents/aibitat/plugins/router-classifier.js`, `model-router-cooldown.js`, `endpoints/modelRouter.js`)
- **Data model.** `model_routers` holds name, `fallback_provider`/`fallback_model` and `cooldown_seconds` (default 30). `model_router_rules` holds `priority`, `type` (`calculated` | `llm`), `title` (`^[a-z0-9_]+$`), `description`, `condition_logic` (only `AND` so far), `conditions` (a JSON array of `{property, comparator, value}`) and `route_provider`/`route_model`. A workspace points at a router through `workspaces.router_id` (no FK because of a SQLite migration limit).
- **Properties:** `promptContent`, `conversationTokenCount`, `conversationMessageCount`, `currentHour`, `hasImageAttachment`. **Comparators:** contains, matches (regex), gt/gte/lt/lte/eq/neq, between.
- **Evaluation.** Rules are evaluated in priority order. Runs of adjacent `llm` rules are batched into one classification call. The classifier is a headless AIbitat agent with one tool, `select_category`, whose enum is the rule titles plus `none`. It runs on the router's *fallback* model. Using tool calling instead of parsing text means it works with every provider.
- **Caching.** All caches are in-process Maps: a sticky route per thread (the TTL renews on every hit, and only real matches stick, never the fallback), an LLM classification cache for the sticky window, and a 30 s debounce on "no match". The cooldown starts when inference finishes, so a long reasoning reply does not use it up (1.16.0). A response that is already running finishes on its original model (1.19.0).
- **Takeaway.** iHub's proposal is stronger on sensitivity (hard constraints, and it never falls back to a less trusted model). AnythingLLM's useful parts are the simple rule DSL and the LLM classifier built on tool calling.

### 2. Automatic memories (`server/jobs/extract-memories.js`, `server/jobs/helpers/memory-extraction-utils.js`, `server/models/memory.js`, `server/utils/memories/index.js`, `endpoints/memory.js`)
- **Table** `memories(userId, workspaceId, scope: 'workspace'|'global', content, lastUsedAt)`. Limits: 5 global and 20 per workspace. At most 5 workspace memories are injected per turn.
- **Extraction.** A Bree worker runs every `MEMORY_EXTRACTION_INTERVAL` (default 3 h). It groups unprocessed chats (`memoryProcessed: null`, `include: true`, so chats deleted with `/reset` are never mined) by (user, workspace). It skips a group with fewer than 5 chats or one that is still active (`MEMORY_IDLE_THRESHOLD_MS` = 20 min). It then runs two LLM passes: an **Observer** proposes candidate facts, and a **Reflector** classifies their scope, removes duplicates and filters them against existing memories. `applyExtractedMemories` writes the result in a transaction and respects the limits.
- **Injection.** `promptWithMemories()` appends `## Things I Remember About You` to the system prompt. If a workspace has more than 5 memories, the native embedding reranker ranks them against the prompt plus the last 3 user messages, and falls back to the most recent ones. `lastUsedAt` is updated.
- **Settings:** `memoriesEnabled` (injection) and `autoMemoriesEnabled` (extraction) are separate. Users can add memories by hand and promote or demote them.

### 3. Intelligent Tool Selection (`server/utils/agents/aibitat/utils/toolReranker.js`, call site `aibitat/index.js:928`)
- A singleton `ToolReranker` uses the local `NativeEmbeddingReranker` (a cross-encoder) to score each function's name and description, cut to 1000 chars at a word boundary, against the user prompt. It keeps `AGENT_SKILL_RERANKER_TOP_N` tools (default 15). `AGENT_SKILL_RERANKER_ENABLED` is on by default.
- The prompt is captured *before* documents are injected, so the reranking query stays clean. Reranking only kicks in when more tools than top-N are present.

### 4. Scheduled Jobs (`server/models/scheduledJob.js`, `scheduledJobRun.js`, `server/utils/BackgroundWorkers/index.js`, `server/jobs/run-scheduled-job.js`, `plugins/create-scheduled-job/`)
- Tables `scheduled_jobs(name, prompt, tools JSON|null, schedule cron, enabled, lastRunAt, nextRunAt)` and `scheduled_job_runs(status queued|running|completed|failed|timed_out, result JSON trace, error, readAt)`.
- **Design choice.** Bree couples scheduling to worker spawning, so they wrote their own in-process cron timers (`later.setInterval`, UTC) feeding a `p-queue` (`SCHEDULED_JOB_MAX_CONCURRENT`, default 1). Each run is a child Bree worker with `SCHEDULED_JOB_TIMEOUT_MS` (5 min). Workers are tracked per job so that deleting a job kills its running workers. The worker moves a run from queued to running itself, so `startedAt` is the real start time.
- **Tool approval is auto-approved in scheduled runs.** 1.19.0 shows the job prompt in the approval dialog when an agent *creates* a job. iHub is stricter here, and that is a selling point.
- **Agent tool.** The `create-scheduled-job` tool makes the model call `listTools: true` first, because job tool IDs are not plugin names. Cron is written in the user's local time and converted to UTC. Finished runs send web push through `utils/PushNotifications` (VAPID) and mark `readAt`.

### 5. Clarifying questions (`plugins/request-user-input.js`)
- Typed inputs (text/url/number/date/email/textarea). At most `agent_clarifying_questions_max_per_turn` (default 3) questions per turn, with a 120 s timeout. Answers come back as a numbered `Q:`/`A:` transcript. Timeouts and skips become "[proceed using your best judgment]". 1.19.0 pauses the timeout while the user is typing. iHub's ask-user tool is comparable.

### 6. Embed widget access control (`server/utils/middleware/embedMiddleware.js`, `models/embedConfig.js`, `endpoints/embed/`)
- `embed_configs`: `chat_mode` (query/chat), `allowlist_domains`, `allow_model_override`/`allow_temperature_override`/`allow_prompt_override`, `max_chats_per_day`, `max_chats_per_session`, `message_limit` (20), bound to one workspace. Chats are logged in `embed_chats` by session UUID.
- The `Origin` header is checked against the allowlist. `EMBED_REQUIRE_ALLOWLIST` makes "no allowlist" mean deny-all (1.14.0). History routes validate the session UUID. 1.19.0 adds a limit on request size. The widget's JS lives in a separate repo (anythingllm-embed); this clone only holds the backend.

### 7. App integrations: Gmail / Outlook / Calendar (`plugins/gmail/{search,threads,drafts,send,account}`, `plugins/outlook/…`, `plugins/google-calendar/`)
- Gmail calls a **Google Apps Script web app** that the user deploys (`https://script.google.com/macros/s/<deploymentId>/exec`, `gmail/lib.js:330`). This avoids Google OAuth app verification. Outlook uses Graph with `authType` common or organization (organization needs a tenant ID). Send and draft actions go through tool approval, which shows the body, recipients and BCC (1.19.0).

### 8. Document sync (`jobs/sync-watched-documents.js`, `models/documentSyncQueue.js`, `documentSyncRun.js`)
- An hourly job. Each watched document has a queue row with a stale-after interval and a run log. 1.18.0 made the vector swap atomic, so a failed sync never leaves partial data. 1.16.2 clears stale vectors on sync.

### 9. Telegram bot (`server/utils/telegramBot/`, `jobs/handle-telegram-chat.js`, `external_communication_connectors` table)
- A generic `external_communication_connectors(type unique, config JSON, active)` table is ready for more channels. The bot streams replies, handles voice and images, lets users switch workspace, thread and model, and uses agent mode. HTTP calls time out instead of hanging (1.18.0).

## Ideas worth adopting for iHub (ranked)

1. **Personal memory for users, optional per app (PARTIAL → HAVE).** Re-use `memoryService.js` with a new `{kind:'user', userId}` scope. Add an idle-gated background extractor using the Observer/Reflector pattern (minimum chat count, idle threshold, never mine ephemeral or deleted chats). Inject a small, capped section, preferably BM25-ranked since iHub has no embeddings. Users get a "What iHub remembers" page with edit/delete and a global or per-app scope. Admins switch it on per platform and per group, with PII rules from `docs/pii-data-handling.md`. Strong value for enterprise; build it on the existing storage.
2. **Ship the Model Router proposal**, borrowing AnythingLLM's rule DSL (`property/comparator/value`, priority order, a fallback) and its **LLM classifier as a single forced tool call with an enum** for semantic rules. Add sticky-per-chat routing with renewing TTL, and start the cooldown at the end of inference. Keep iHub's sensitivity hard constraints as the differentiator, and explain each decision to the user (the server decides and sends a field, per CLAUDE.md).
3. **Drop-in website chat widget** (`<script src=…/widget.js data-app-id=…>`): origin allowlist that is deny-by-default, limits per session and per day, a cap on request size, an anonymous-session token, and app-level locks on whether the embedder may override model, prompt or temperature. iHub already has the iframe and `embedAllowedOrigins` plumbing for shares. Common ask for intranet and portal use.
4. **Per-prompt tool narrowing** when an app or chat has more than about 15–20 tools: rank tool name and description against the prompt (BM25 is fine) and send only the top N, with an always-include list for pinned tools. Cuts tokens and improves tool choice with large MCP and integration catalogs.
5. **Mail and calendar actions for Microsoft 365** (search/read/draft/send mail, read/create events) as a native integration on the existing Office 365 OAuth, with send and create behind tool approval. Show recipients, BCC and body in the approval card, as in 1.19.0. Complements the Outlook add-in.
6. **Meeting → tasks.** After a transcription or meeting summary, extract commitments with due dates (real deadlines only, none invented), add a task inbox, and send reminders through scheduled tasks. Regenerating keeps completed tasks. Fits iHub's voice transcription and Outlook meeting context.
7. **Web Push for scheduled-task runs and approvals.** The service worker already exists. Add VAPID and a Push API subscription per user, used by the "Notify me" modes and by pending approvals.
8. **Scheduled re-sync of project items** (URL, cloud, crawled site): an interval per item, run log, atomic swap of the text, and the existing `stale` state on failure.
9. **More project import sources:** YouTube transcripts, and a git repository (GitHub/GitLab/Gitea, default-branch fallback) as a project source. The bulk link list should also read linked PDFs and files.
10. **Colour palettes chosen by the user** (admin-curated presets plus custom main/accent with preview) on top of the `ui.json` theme. Low effort, visible.
11. Lower priority: Telegram/Teams-chat-style channel connectors through a generic `external connectors` table; a SQL integration (read-only and allowlisted, or point users to a marketplace MCP server); a built-in llama.cpp runtime for a "zero external dependency" demo image.
