# Vane (formerly Perplexica) vs. iHub Apps — What an Open-Source Perplexity Teaches Us

**Date:** 2026-11-09
**Status:** Analysis / recommendation
**Sources analyzed:**

- Vane `ItzCrazyKns/Vane` @ `348feca` (v1.12.2, last push 2026-09-01). MIT, about 38k stars and
  4.3k forks. The project started in April 2024 as "Perplexica" and was renamed to Vane. We read
  the whole answer pipeline (`src/lib/agents/**`, `src/lib/prompts/**`), the retrieval and upload
  code, the API routes, the streaming/session model and the main UI components.
- iHub Apps `main` @ `6410e8f`: chat loop, web search engines and page reader, answer sources and
  citations, projects/knowledge, start page, chat UI, inference API.

Perplexity is one of the most-used AI tools in enterprises. Its user experience is simple: one
search box, a cited answer, sources you can check, and suggested follow-up questions. Vane is the
most popular open-source rebuild of that experience. This document compares Vane's features and
internals with iHub and recommends what to adopt, what to adapt, and what not to copy.

---

## 1. Executive summary

1. **Vane is a personal tool, not an enterprise product.** It has no authentication ("Adding
   authentication" is still on its roadmap). An unauthenticated `GET /api/config` returns every
   model provider's configuration, **including API keys in plain text**
   (`src/app/api/config/route.ts:11`). It stores data in one SQLite file and keeps live runs in
   process memory. If employees run Vane on a shared server, that is shadow IT with a credential
   leak. iHub's position is: "the same experience, with sign-in, permissions, audit, iFinder and
   your own models."
2. **iHub already has most of the engine.** It has web search through three engines plus native
   provider search, a page reader with SSRF protection, and an agent loop with parallel tools. Its
   citations are validated and renumbered, and its sources panel separates "cited" from "also
   considered". Runs survive a closed tab. In several areas (citation integrity, security,
   persistence, integrations) iHub is clearly ahead of Vane.
3. **The real gap is the default experience, not capability.** Vane opens with one box that
   searches by default. iHub opens with an app: the `/start` input belongs to whichever app ranks
   first. The shipped `web-chat` app supports web search (`websearch.enabled: true`), but its
   toggle **starts off** (`server/defaults/apps/web-chat.json`, `enabledByDefault: false`). Users
   can switch it on themselves where a permitted engine or native search is available. What they
   cannot do is choose *how much* to research: "answer this quickly" vs. "research this deeply"
   is fixed by the app's admin settings.
4. **Five features Vane has and iHub lacks are cheap and very visible:**
   - suggested follow-up questions after each answer;
   - a user-selectable research depth (speed / balanced / quality);
   - a `?q=` URL, so iHub can be added as a browser search engine;
   - a regenerate button on answers;
   - a search-first default app.

   None of them needs a new subsystem.
5. **One retrieval idea is worth taking: read with a question.** In quality mode, Vane does not
   pass raw page text to the model. It picks at most 3 results and splits each page into chunks
   of about 4k tokens. For each chunk it extracts only the facts that answer the queries, keeping
   numbers verbatim. iHub passes raw text, truncated at 3,000–10,000 characters, so the relevant
   part of a long page is often cut off. iHub can do this better than Vane: rank page sections
   with the BM25 code it already has (`server/sources/documentRetrieval.js`), which keeps the
   text verbatim for citations and needs no extra LLM call.
6. **Do not copy Vane's pipeline shape.** Vane makes one extra LLM classification call before
   every message. Each widget adds another LLM call. Research and writing are split into a fixed
   chain. iHub retired the equivalent tools (`deepResearch`, `queryRewriter`, `researchPlanner`,
   `evaluator`, `answerReducer`; see `docs/releases/5.4.12/breaking-changes.md`) in favour of one
   `AgentLoop`. Depth should be a set of **budgets and retrieval strategies inside that loop**, not
   a second engine.
7. **Several Vane defaults are not acceptable for enterprise customers.**
   - Its scraper uses anti-bot-detection evasion: `--disable-blink-features=AutomationControlled`
     and an override of `navigator.webdriver`.
   - Every source's domain is sent to Google's favicon service.
   - Widgets call Yahoo Finance's unofficial API and OpenStreetMap's Nominatim.
   - The prompts demand that "every sentence" carry a citation, and that a quality answer be at
     least 2,000 words.

---

## 2. What Vane is

### 2.1 Product surfaces

| Surface | What it does | Code |
|---|---|---|
| Home / chat | One input with a **Sources** picker (Web, Academic, Social), a **mode** picker (Speed, Balanced, Quality), a model picker and file attach. `?q=` sends at once. | `src/components/EmptyChat*.tsx`, `MessageInputActions/*`, `lib/hooks/useChat.tsx:273` |
| Answer | Research steps panel → sources strip (3 + "View N more") → answer with `[n]` citation links → follow-up suggestions. Side buttons search images and videos. | `AssistantSteps.tsx`, `MessageSources.tsx`, `MessageRenderer/Citation.tsx`, `SearchImages.tsx`, `SearchVideos.tsx` |
| Widgets | Weather (7-day forecast), stock (chart with 1D–MAX ranges), and calculation cards, shown above the answer. | `lib/agents/search/widgets/*`, `components/Widgets/*` |
| Discover | News cards for 5 fixed topics (tech, finance, art, sports, entertainment), from Bing News for 3 hard-coded sites per topic. | `app/api/discover/route.ts` |
| Library | List of past chats, with delete. | `app/library/page.tsx` |
| Settings | Model providers (OpenAI, Anthropic, Gemini, Groq, Ollama, LM Studio, Lemonade, local Transformers.js embeddings), SearxNG URL, theme, measurement units, auto image/video search, a free-text "system instructions" personalization. | `components/Settings/**`, `lib/config/index.ts` |
| Setup wizard | First run: add a provider and pick models. | `components/Setup/*` |
| Export, TTS | Chat as Markdown or PDF (jsPDF, in the browser); read-aloud. | `components/Navbar.tsx:34-90`, `MessageBox.tsx:75` |
| API | `POST /api/search` → `{ message, sources }`, or an NDJSON stream (`init`, `sources`, `response`, `done`). | `app/api/search/route.ts`, `docs/API/SEARCH.md` |

The README promises "search specific domains" and "smart suggestions as you type". **Neither
exists in the code.** The only `site:` use is in Discover, and the "suggestions" are the
follow-ups shown after an answer.

### 2.2 The answer pipeline

```
POST /api/chat ──► SearchAgent.searchAsync (detached from the HTTP request)
                   │
                   ├─ 1. classify()            one structured LLM call:
                   │                            skipSearch, personal/academic/discussion search,
                   │                            show weather/stock/calculation widget,
                   │                            standaloneFollowUp (context-free rewrite)
                   │
                   ├─ 2. in parallel:
                   │     ├─ WidgetExecutor      each triggered widget: 1 LLM call to extract
                   │     │                      parameters, then a deterministic API call → card
                   │     └─ Researcher          tool loop; the model may only call tools:
                   │                            __reasoning_preamble (plan text shown to user),
                   │                            web_search, academic_search, social_search,
                   │                            uploads_search, scrape_url, done
                   │
                   ├─ 3. Writer                 separate streamed call: writer system prompt +
                   │                            numbered <result index=n> context; widget output
                   │                            marked "do not cite"
                   │
                   └─ 4. Suggestions            client calls /api/suggestions after the answer
                                                (only if it has sources): 4–5 follow-ups
```

Code: `src/lib/agents/search/index.ts`, `classifier.ts`, `researcher/index.ts`,
`researcher/actions/*`, `prompts/search/{classifier,researcher,writer}.ts`,
`agents/suggestions/index.ts`.

The **researcher never writes the answer.** Its prompt says "NEVER output normal text to the user.
ONLY call tools", and `done` ends the loop. The writer only sees the deduplicated findings, not
the tool-call transcript. This keeps the writer's context clean, at the cost of a fixed
second LLM call.

### 2.3 The three modes

| | Speed | Balanced | Quality |
|---|---|---|---|
| Researcher iterations (`researcher/index.ts:14-19`) | 2 | 6 | 25 |
| Plan step (`__reasoning_preamble`) shown to the user | no | yes, before every tool call | yes |
| Queries per search call | max 3 | max 3 | max 3 |
| What the writer gets from search | SearxNG **snippets**, re-ranked by embedding similarity | snippets, re-ranked | **extracted facts** from ≤3 pages per search |
| Pages read from search results | none | none | Playwright + Readability → 4k-token chunks → one LLM extraction per chunk |
| Pages read on request (`scrape_url`, URLs the user names, max 3) | yes | yes | yes |
| Prompt guidance | "you only get to call this once" | "broad first, then narrow; aim for ≥2 searches" | "never stop before at least 5–6 iterations" |
| Writer | blog-style, cite every sentence | same | same, plus "SHALL NOT BE LESS THAN 2000 WORDS" |

In speed and balanced mode, Vane answers *search* questions from snippets alone (one or two
sentences per result). That is why they are fast, and also why they are shallow. A page is read
in these modes only when the user names its URL: `scrape_url` is enabled in every mode, but its
description tells the model never to call it on its own (`actions/scrapeURL.ts`).

### 2.4 Retrieval details

- **Search backend:** SearxNG only, bundled in the Docker image (`src/lib/searxng.ts`). The
  options are `categories`, `engines`, `language` and `pageno`; there is no freshness or domain
  parameter. Academic search uses SearxNG engines `arxiv`, `google scholar` and `pubmed`;
  "discussions" uses `reddit` (`actions/search/{academic,social}Search.ts`).
- **Speed/balanced ranking** (`actions/search/baseSearch.ts:37-171`):
  - embed the query and each snippet (one embedding call per result);
  - drop results with cosine similarity below 0.5;
  - drop near-duplicates (cosine above 0.75);
  - keep the top 20.
- **Quality reading** (`baseSearch.ts:172-418`):
  - an LLM "picker" chooses at most 3 result indices, preferring reputable and diverse sources;
  - each picked page is scraped and split into 4k-token chunks with 500 tokens of overlap
    (`utils/splitText.ts`);
  - each chunk goes through an "extractor" prompt in parallel. Its rules are short telegram-style
    facts, no marketing language, merged duplicates, and "NEVER summarize numbers, benchmarks,
    or table data".
- **Scraper** (`src/lib/scraper.ts`): a shared headless Chromium (Playwright) that is shut down
  after 30 s idle. It loads pages with a desktop Chrome user agent, **anti-automation-detection
  flags** and a `navigator.webdriver` override, then runs Readability on the result.
- **Uploads RAG** (`lib/uploads/{manager,store}.ts`):
  - PDF, DOCX and TXT, chunked to 512 tokens with 128 overlap, embedded once, and stored as JSON
    files next to the upload;
  - a query embeds up to 3 queries and fuses the rankings with a **reciprocal-rank-fusion**
    variant (k = 60), then keeps the top 10.
- **URL dedup**: results are merged by exact URL; content of duplicates is appended
  (`researcher/index.ts:189-208`).

### 2.5 Widgets

A widget implements `shouldExecute(classification)` and `execute()`. It returns `data` for the UI
card and `llmContext` for the writer. The writer prompt says this output "is already showed to
the user… do not CITE this as a source".

| Widget | Parameter extraction | Data source |
|---|---|---|
| Calculation | LLM extracts a mathjs expression | `mathjs.evaluate`, local |
| Weather | LLM extracts a location or coordinates | Nominatim (geocoding) + Open-Meteo |
| Stock | LLM extracts a ticker | `yahoo-finance2`, an unofficial API; 7 chart ranges |

### 2.6 Streaming and sessions

- A run is a `SessionManager` (`src/lib/session.ts`). It is an in-memory event emitter that
  holds a list of **blocks**: `text`, `source`, `research`, `widget`, `suggestion`. It changes
  them with **RFC 6902 JSON patches** (`emitBlock` / `updateBlock`).
- The HTTP response is NDJSON of `block` / `updateBlock` / `researchComplete` / `messageEnd`
  events.
- The agent runs detached from the request. `POST /api/reconnect/:id` replays all events so far
  and then follows live. Sessions expire after 30 minutes and live in a single process.
- The final blocks are stored as `messages.responseBlocks` (SQLite via Drizzle).

### 2.7 Weaknesses (verified in code)

- **No authentication, and an unauthenticated config endpoint** that returns provider API keys
  (`app/api/config/route.ts:11-35`; `ConfigModelProvider.config` holds `apiKey`). `POST
  /api/config` and `/api/providers*` let anyone change the configuration.
- **Parallel tool results can be paired with the wrong call.** `ActionRegistry.executeAll`
  pushes results in the order they *complete* (`actions/registry.ts:82-106`). The researcher
  then pairs them with tool calls by *index* (`researcher/index.ts:175-182`). Two concurrent
  searches can therefore return each other's results to the model.
- **Citations are not checked.** `[n]` is the position in the context list. Nothing checks that
  a cited number supports the sentence or even exists. The writer prompt requires that "every
  sentence… includes at least one citation", which pushes the model to make citations up.
- **The classifier always runs**: one extra LLM round trip before any token appears, even for
  "hi". Each triggered widget adds another call.
- **Privacy contradictions in a "privacy-focused" product:**
  - Every source domain goes to `s2.googleusercontent.com/s2/favicons` (`MessageSources.tsx:46`).
  - Weather locations go to Nominatim and stock tickers to Yahoo.
  - SearxNG itself scrapes Google and Bing from the server's IP, which is a terms-of-service
    grey zone and is regularly rate-limited or blocked.
- **No proxy or custom CA handling**: bare `fetch()` and Playwright, and no SSRF protection on
  `scrape_url`.
- **No tests** in the repository. One SQLite file and one process, so no horizontal scaling.

---

## 3. Where iHub stands

### 3.1 What exists and is ahead of Vane

- **Web search engines:** Brave, Staan, Qwant (`server/services/search/webSearchEngines.js`).
  - Native provider search for Gemini grounding, OpenAI Responses and Anthropic, with fallback to
    an engine (`server/services/tools/webSearchResolver.js:27`,
    `server/services/loop/nativeWebSearchFallback.js`).
  - Third-party engines can be added as `web-search` integration definitions.
  - Parameters: `freshness`, `language`, `includeDomains`, `excludeDomains` (Staan), `maxResults`
    (`.../connectors/websearch/parameters.json`).
- **Page reader** (`read_url` → `server/tools/webContentExtractor.js`): `httpFetch` with the SSL
  whitelist and proxy settings, an SSRF guard with DNS pinning on every redirect, bot-protection
  detection that *reports* a block instead of evading it, Readability + Markdown output, PDFs,
  `offset` paging, a 10-minute cache and a per-answer read budget (`maxPageReads`, default 5).
- **Citations and sources** (`shared/sources/citations.js`, `docs/answer-sources.md`):
  - sources are renumbered by first use;
  - a link to a URL the turn never returned stays a plain link;
  - "Cited in this answer" is separate from "Also considered";
  - badges and cards highlight each other;
  - native provider citations are normalized into the same sources;
  - URLs are normalized for dedup (`shared/sources/url.js`);
  - no third-party favicon fetches.
- **Run activity:** search and read steps are labelled on the server (`server/utils/toolDisplay.js`)
  and shown as a live timeline that collapses when the answer is done (`ToolActivity.jsx`).
- **Persistence and resume:** the run ledger replays a run after reconnect, and runs keep going
  when the tab closes ("Answered while you were away"). This works across a cluster.
- **Enterprise:** OIDC, LDAP, NTLM and local sign-in; group permissions per integration; iFinder,
  Jira, Office 365, Google Drive and Nextcloud; projects (similar to Perplexity Spaces); scheduled
  tasks with web search and memory; workflows; MCP and A2A in both directions; sharing; 10 export
  formats; feedback; i18n; accessibility work; config migrations; an extensive test suite.

### 3.2 Gaps (all verified in code)

| Gap | Evidence |
|---|---|
| No app-less, search-first front door | `/start` embeds the input of the top-ranked app (`client/src/utils/homePage.js:73`); `web-chat` has `enabledByDefault: false` |
| No follow-up suggestions | No producer in `server/`, `shared/` or `client/`; apps only have static `starterPrompts` |
| No user-facing research depth | Budgets are per-app admin settings: `maxPageReads` (default 5, counted per turn, `server/services/chat/pageReadLimit.js`), `contentMaxLength`, and `websearch.maxSearches` (default 5). `maxSearches` only becomes Anthropic's per-call `max_uses` (`webSearchResolver.js:258`); engine searches and other providers' native search have **no per-answer counter**, only `CHAT_MAX_TOOL_ROUNDS = 25` (`server/services/chat/ChatService.js:91`). Research is one guidance text (`RequestBuilder.js:142`) |
| Long pages are truncated, not targeted | `read_url` default 10k characters, search extraction 3,000 characters per result |
| No `?q=` / OpenSearch / omnibox | Auto-send needs `/apps/{id}?prefill=…&send=true` (`docs/auto-send-feature.md`); no `opensearch.xml`; the extension manifest has no `omnibox` |
| No regenerate on a finished answer | Only Edit/Resend on user messages and Retry on failures (`ChatMessage.jsx:1199-1326`), although `resendMessage` accepts assistant ids (`useAppChat.js:763`) |
| Focus and domain filters only via the model | Engines accept `includeDomains`, but no UI or admin preset sets them |
| No academic, discussion, image, video or news search | Qwant parser keeps only `type==='web'` (`qwantProvider.js:222, 327`); no such engines |
| API answers lose their citations | Responses `annotations` are always `[]` (`server/services/inference/responsesWire.js:196, 228`) |
| No deterministic answer cards | No calculator or widget tools; custom renderers replace the whole answer |
| No embeddings | `ModelEndpointDiscovery.js:862`: "iHub has no embedding model type"; projects use BM25 |
| History search is a client-side title filter | `ChatHistoryPage.jsx:395-400` |

---

## 4. Head-to-head summary

| Capability | Vane | iHub | Edge |
|---|---|---|---|
| Sign-in, multi-user, permissions | none; API keys readable without sign-in | OIDC, LDAP, NTLM, local, groups, per-integration permissions | **iHub** |
| Web search engines | SearxNG (bundled, no key) | Brave, Staan, Qwant, native Gemini/OpenAI/Anthropic, pluggable | **iHub** (Vane: zero-config) |
| Search filters | engines, language | freshness, language, include/exclude domains | **iHub** |
| Focus sources | Web / Academic / Discussions | Web toggle + integrations (iFinder, Jira, …) + projects | Vane UX, iHub reach |
| Research depth chosen by the user | Speed / Balanced / Quality | admin budget per app | **Vane** |
| Query handling | classifier + standalone rewrite (+1 LLM call) | model decides through tool choice | iHub cheaper |
| Page reading | search results: quality mode only, per-chunk fact extraction; user-named URLs: every mode; headless browser | fetch + Readability + PDF, SSRF guard, cache, paging | iHub safer; Vane's *targeting* better |
| Snippet ranking | embedding filter + semantic dedup | engine order + URL dedup | Vane |
| Citations | `[n]` = context index, not checked | validated, renumbered, cited vs considered, panel | **iHub** |
| Research activity | plan text + queries + results + reading | server-labelled timeline | even (Vane shows plan text) |
| Follow-up suggestions | yes | no | **Vane** |
| Widgets / cards | weather, stock, calculator | none (custom renderers, MCP App views) | Vane |
| Image / video results | yes, on demand | no | Vane |
| Discover / news | yes (5 topics) | no | Vane (low enterprise value) |
| Document Q&A | embeddings + multi-query fusion, PDF/DOCX/TXT | many formats, inline or paged reads, BM25 projects, iFinder | **iHub** for enterprise |
| Browser search-engine entry | `?q=` | no | **Vane** |
| Regenerate | yes | only on failure | Vane |
| Export / share / feedback | MD + PDF / none / none | 10 formats + PDF templates / links / ratings | **iHub** |
| Resume after disconnect | in memory, 30 min, one process | run ledger, clustered | **iHub** |
| API | `/api/search` → answer + sources | OpenAI-compatible (no annotations), MCP, A2A | iHub reach, Vane returns sources |
| Models | + Ollama native, Groq, Lemonade, local embeddings | + Mistral, Bedrock, OpenRouter, vLLM | even |
| Automation | none | scheduled tasks, workflows | **iHub** |

---

## 5. Recommendations for iHub

Effort: XS < 1 day, S 1–3 days, M 1–2 weeks, L more than 2 weeks (rough estimates).
Priority: P1 = do next, P2 = answer quality, P3 = opportunistic.

### P1 — Close the visible gaps

#### R1 — An "Ask" front door that searches by default (P1, S)

**Vane:** one box; Web is preselected; every question is searched unless the classifier skips it.

**Proposal:**

- Ship a default app (working name **Ask** / **Fragen**) tuned as an answer engine:
  - web search on by default, native search preferred;
  - the research guidance and depth presets (R3), and follow-ups (R2);
  - iFinder preselected when the integration is installed and the user may use it.
- Make it `startPage.defaultAppId` for new installations.
- Let the model decide when to search, as the loop already does. **No classifier.**
- Existing installations decide for themselves. A migration may add the app disabled, so admins
  can switch it on.

**Why:** This is the one change that makes iHub *feel* like Perplexity. It is mostly
configuration.

#### R2 — Suggested follow-up questions after each answer (P1, S)

**Vane:** after the answer, one structured call returns 4–5 medium-length questions, based on the
chat so far. They are shown as clickable rows and stored with the message.

**Proposal:**

- Generate them **on the server**, following the pattern of
  `server/services/chat/chatTitles.js` (a small background call with a timeout, never failing
  the turn).
  - Configure with `platform.chats.followUps.{enabled, modelId}`; apps can opt out.
  - Input: question, answer, source titles. Output: 3–4 questions in the user's language that the
    answer does not already cover.
  - Start generation as soon as the **answer text is final** (the last model round has finished
    streaming), not after `run/ended`. This gives the stream option below a chance to deliver
    in time.
- **Delivery.** Store them on the message, so they survive a reload. The message carries an
  explicit state, so a client can tell "not ready yet" from "there are none": `pending`, `ready`
  with the questions, or `none` (disabled, failed or timed out). The chat stream closes on the
  turn's own `run/ended` (`client/src/shared/hooks/useEventSource.js`), and titles today are
  written to storage only, never pushed. Two options, decided at design time:
  - **Bounded polling** after `run/ended`: the client fetches the message's follow-ups while the
    state is `pending`, with backoff (for example 1 s, 2 s, 4 s), and gives up after the
    generation timeout (10 s, as for titles, `TITLE_TIMEOUT_MS`). The server marks a generation
    that is still unfinished at the timeout as `none`, so polling always ends.
  - **Hold the stream briefly:** if generation finishes within a bounded time after the answer
    (about 3 s), the turn sends the questions as a field before `run/ended`. Otherwise it ends
    the turn with the state `pending`, and the client falls back to the bounded polling above.

  Either way the server decides what to show and the client renders it.
- **Sharing.** A question may repeat a private document title that the answer itself never shows,
  and the share snapshot drops private sources (`snapshotMessage` in
  `server/services/chat/ChatShareRepository.js`). So share snapshots **leave follow-ups out**:
  they are prompts for the chat's owner, not content.

  The alternative is to generate a second, shareable set only from shareable inputs: the answer
  text plus public sources. That doubles the calls for little gain.
- Render chips under the answer; a click sends the question.
- Skip apps with structured output, custom renderers or workflows.
- Track click-through in telemetry.

#### R3 — Research depth chosen by the user: Quick / Standard / Deep (P1, M)

**Vane:** the mode sets the iteration budget (2/6/25), whether the plan is shown, the retrieval
strategy (snippets vs. read-and-extract) and the answer length.

**iHub today:** all the knobs exist, but only admins can set them, and only once per app.

**Proposal:** add depth presets per app, with a selector next to the web toggle in the input. The
request gets a new field `researchDepth`, and the server maps it to per-answer budgets:

| Preset | Searches | Snippets vs. pages | Page reads | Other |
|---|---|---|---|---|
| Quick | 1–2 | snippets only (`extractContent: false`) | 0 | low reasoning effort, concise answer |
| Standard | today's app defaults | today | today | — |
| Deep | 10–15 | pages, with focused reading (R6) | 10–15 | research guidance "deep", high reasoning effort, report format, cost/time hint in the UI |

- Deep stays inside `AgentLoop`. The shipped `iterative-research-*` workflows remain the tool for
  structured multi-phase reports.
- The admin defines which presets an app offers and their limits. Users can never go above the
  admin's maximum.
- **Enforcement is new work, not existing budgets.**
  - Today only page reads are counted per answer (`pageReadLimit.js`).
  - `websearch.maxSearches` is a per-model-call `max_uses` that only Anthropic applies. The loop
    makes several model calls per answer, and the OpenAI Responses and Gemini adapters pass no
    cap.

  The preset therefore needs a **per-turn search counter in the loop**, built like the page-read
  gate:
  - engine searches are counted before they run, and past the cap the call returns a "budget
    reached" result instead of searching;
  - for native search, each model call gets `max_uses` = the searches remaining, where the
    provider supports it. Where it does not (OpenAI Responses, Gemini), a capped preset turns
    native search **off before the first model call** and searches through an engine, which the
    counter gates. One uncapped native call can search several times, so dropping native search
    only after the counter is spent would not enforce the cap.

  Searches already reported by a provider (grounding metadata, `web_search_call` items) count
  toward the same number.

#### R4 — Browser entry: `?q=`, OpenSearch, omnibox (P1, S)

- `/start?q=…` sends to the default answer app, as an alias of `prefill` + `send`. This avoids a
  new top-level route; if a `/search` route is added instead, it must go into `KNOWN_ROUTES` and
  the `client/index.html` copy.
  - The query must survive the login redirect.
- Serve `/opensearch.xml`, aware of the base path, and add `<link rel="search"
  type="application/opensearchdescription+xml">` to `index.html`. Chrome, Edge and Firefox then
  offer "Add iHub as search engine" by themselves.
- Browser extension: add `"omnibox": { "keyword": "ihub" }`, so "ihub ␣ question" works.
- Test both root and subpath deployments.

#### R5 — Regenerate (and "rewrite with model…") on answers (P1, XS)

- Add a Regenerate button to the **latest** assistant answer. `resendMessage` already accepts
  assistant ids (`useAppChat.js:763`).
- `resendMessage` deletes everything from the preceding user message on (`deleteFromMessage`),
  and the next send forks the stored history there. So the button must not appear on older
  answers. Regenerating an older answer without losing later exchanges would need branching
  (keeping alternative answers side by side), which is a separate, larger feature.
- Optional: a model menu on the button, like Perplexity's "Rewrite".

### P2 — Answer quality

#### R6 — Read pages with a question: focused page reading (P2, M)

**Vane:** in quality mode, each page is split into 4k-token chunks. An LLM extracts the
query-relevant facts from each chunk, numbers verbatim. The writer gets facts, not raw pages.

**iHub today:** `read_url` returns the first 10k characters, with `offset` paging; search
extraction returns 3,000 characters per result. On long pages the relevant section is often cut
off, or the context fills up.

**Proposal (better than Vane):**

- Give `read_url` and `extractContent` an optional `focus` (the question being researched).
  - The server splits the page into sections and ranks them with the **BM25 code iHub already
    has** (`server/sources/documentRetrieval.js`).
  - It returns the best sections verbatim, with their headings, plus an outline of the rest.
- This keeps exact text, which is what citation passages and source cards need. It is
  deterministic and adds no LLM call.
- An LLM extraction pass with a cheap utility model, using Vane's extractor rules (no filler,
  numbers verbatim, merge duplicates), stays an option for Deep mode on very long pages. The
  section anchor is kept, so the citation still points to the right place.

#### R7 — Focus presets, including Academic and Discussions, plus domain restriction (P2, M)

**Vane:** Web / Academic (arXiv, Google Scholar, PubMed) / Discussions (Reddit).

**Proposal:**

1. **Admin-defined focus presets:** name, icon, integrations, *enforced* domain include/exclude
   lists, freshness, and a guidance text. Examples: "Academic", "Discussions",
   "Our websites" (`intrafind.com`), "Internal" (iFinder only).
   - The server applies these filters as hard defaults. Today they are only hints the model may
     set.
2. **Academic engines through real APIs**, shipped in `ihub-marketplace` as `web-search`
   integrations: OpenAlex (no key), the arXiv API, PubMed E-utilities and Semantic Scholar. No
   scraping of Google Scholar.
3. **A user chip "Search only on …"** in the input that sets `includeDomains` for the chat.

#### R8 — SearxNG as an optional engine (P2, S)

**Vane:** SearxNG is bundled, needs no API key, and starts with one Docker command.

**Proposal:**

- Add a SearxNG `web-search` integration (marketplace, or built in). It uses `httpFetch`, so the
  SSL whitelist and proxy settings apply, and requests JSON output.
- Its `categories` parameter also enables images, videos and news (R11).
- Add an optional `docker-compose` profile.

**Caveat:** document honestly that SearxNG scrapes the upstream engines. Queries leave the
network from the server's IP, rate limits and captchas are normal, and the terms-of-service
position is unclear. Position it for evaluations, labs and private deployments, not as the
default production engine.

#### R9 — Citations in the API (P2, S)

**Vane:** its most-used integration surface returns `{ message, sources }`.

**iHub:** the OpenAI-compatible API can run an app with web search (`model: "app:<id>"`), but
`annotations` is always `[]`, so Teams bots, scripts and agents lose the sources.

**Proposal:**

- Fill the standard `url_citation` annotations (start/end index, url, title) in both Responses
  and Chat Completions. This takes two steps:
  1. **Find the spans.** `resolveCitations` maps sources to numbers, but it returns no offsets and
     lists each cited source once. A span pass therefore walks the final output text and records
     every citation occurrence with its own start and end, so a source cited three times gets
     three annotations. `citationRefs` in `shared/sources/citations.js` already finds each
     match's offset, but drops it from its result. Its code masking keeps the text length, so
     the offsets are valid positions in the original text; a variant that returns them with the
     match length is enough.
  2. **Map each span to its source** with `numberOfUrl` / `numberOfMarker`. A span with no
     matching source gets no annotation, just as the UI leaves such links plain.

  Offsets refer to the text exactly as sent to the client, after any marker rewriting.
- This is an additive change under the API guidelines. **Do not** build a separate `/api/search`.

### P3 — Opportunistic

#### R10 — Answer cards for deterministic tools; start with a calculator (P3, S → M)

**Vane:** a widget's card appears before the answer, and its result goes to the model as context
it must not cite.

**Proposal:**

- **(a)** A built-in `calculate` tool (mathjs: arithmetic, percentages, units). It is
  deterministic and offline, and models are unreliable at arithmetic. (S)
- **(b)** A card contract for tool results. The server sends something like `card: { type,
  data }` with the tool event, and the client renders it above the answer as non-citable
  context. Reuse the MCP App view infrastructure where it fits. People-directory and Jira results
  are natural first cards. (M)
- Weather and stocks only as optional marketplace integrations, because of privacy and data
  licensing.

#### R11 — Image and video results on demand (P3, M)

- Add an engine capability `searchImages` / `searchVideos`. Brave has image, video and news APIs;
  Qwant has `categ`; SearxNG has categories.
- Add a "Images" / "Videos" button on an answer. A cheap call writes a focused query, as Vane
  does.
- Third-party thumbnails reveal the user's IP to those hosts. Proxy them through the server, or
  load them only after a click.

#### R12 — Several queries with rank fusion in `knowledge_search` (P3, S)

- Vane's upload search fuses up to 3 query rankings with reciprocal rank fusion.
- iHub's `knowledge_search` takes one `query`. Accept `queries[]` (at most 3) and fuse the BM25
  rankings with RRF (k = 60).
- This is a cheap recall gain on projects without introducing embeddings.

#### R13 — From "Discover" to "Briefings" (P3, L, exploratory)

- Vane's Discover is a generic news feed, with little value inside a company.
- The useful version is a page of **briefings**, fed by:
  - scheduled tasks, which already do web research, keep memory and can notify only on changes;
  - what is new in iFinder for the user's areas.
- Treat this as a product exploration, not a port.

### Perplexity parity beyond Vane (not in Vane either)

- A hover preview card on citation badges (title, site, snippet). iHub only highlights today.
- Server-side full-text search over chat history (`/chats` filters loaded titles only).
- Consider switching on user projects (Spaces) and chat sharing for answer-engine
  installations. Both are off by default today.

### What *not* to copy

- **The classifier before every message.** It adds latency and cost. iHub's loop already lets
  the model decide whether to search.
- **A second, hard-coded research → writer pipeline.** iHub consolidated into `AgentLoop` on
  purpose (5.4.12). Put depth into budgets and retrieval inside the loop.
- **Prompt rules that force citations or length:** "cite every sentence" and "at least 2,000
  words".
- **Scraper evasion** (automation flags, `webdriver` override). If iHub ever adds a headless
  renderer for JavaScript-heavy pages, it renders without evasion and still reports bot walls.
- **Third-party favicon services** and keyless unofficial APIs (Yahoo Finance) as defaults.
- **Embedding every search snippet one by one** to re-rank web results. iHub has no embedding
  model type, and adding one only for this is not worth it. Semantic retrieval over company
  documents is iFinder's job (`ifinder/rag`, `embedding-model-registry`).
- **Pairing parallel tool results by index.** Pair them by tool-call id; iHub's loop already does.

### Suggested phasing

| Phase | Scope | Rough size |
|---|---|---|
| 1 — "Feels like Perplexity" | R1 Ask app, R2 follow-ups, R4 `?q=`/OpenSearch/omnibox, R5 regenerate | ~2 weeks |
| 2 — "Answers like Perplexity Pro" | R3 depth presets, R6 focused reading, R7 focus presets + academic engines, R9 API citations | ~3–4 weeks |
| 3 — Opportunistic | R8 SearxNG, R10 calculator + cards, R11 media, R12 RRF, R13 briefings, the parity items | as capacity allows |

Each user-visible item needs an entry in `docs/releases/next/`. New config fields (`researchDepth`
presets, `followUps`, focus presets) need a migration where they change existing files.

---

## 6. Appendix — Vane reference snippets

**Iteration budget by mode** (`src/lib/agents/search/researcher/index.ts:14-19`):

```ts
let maxIteration =
  input.config.mode === 'speed' ? 2 : input.config.mode === 'balanced' ? 6 : 25;
```

**Extractor rules used for page reading** (abridged, `actions/search/baseSearch.ts:323-360`):

```
1. Relevance to the query: adjust to the query's intent ("What is X" → definition;
   "X specs" → every technical detail).
2. Facts, not opinions; ignore marketing language.
3. Ignore headers, footers, UI text.
4. Telegram style: "Weight: 1.2kg", not "The device features a weight of only 1.2kg".
5. Merge duplicates into one dense bullet.
6. NEVER summarize numbers, benchmarks or tables; extract raw values exactly.
```

**Multi-query fusion over upload chunks** (`src/lib/uploads/store.ts`, simplified):

```ts
for each query q:  ranked = records sorted by cosine(q, record)
score[chunk] += similarity / (rank + 1 + 60)   // RRF variant, k = 60
return top 10 by score
```

**Parallel-result pairing bug** (`actions/registry.ts:82-106` + `researcher/index.ts:175-182`):

```ts
await Promise.all(actions.map(async (a) => { results.push(await this.execute(a)); }));
// … later, paired by index, not by id:
actionResults.forEach((action, i) => history.push({ role: 'tool', id: finalToolCalls[i].id, … }));
```
