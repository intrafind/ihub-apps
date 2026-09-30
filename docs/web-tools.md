# Web Tools Documentation

This document describes the web tools available in the iHub Apps platform for searching the web and extracting web content.

## Overview

iHub Apps provides a unified web search system that automatically selects the best search provider based on the active model. Web search is configured per-app through the `websearch` configuration object rather than through individual tool IDs.

### Search Providers

| Provider | Type | Best For |
|----------|------|----------|
| **Google Search** | Native (Gemini models) | Grounded answers with Google Search citations |
| **OpenAI Web Search** | Native (GPT models via Responses API) | Web-augmented responses with inline citations |
| **Anthropic Web Search** | Native (Claude models) | Web-augmented responses with inline citations |
| **Brave Search** | Server-side | Privacy-focused search, any model (needs an API key) |
| **Staan Search** | Server-side | European search index, any model, works from cloud hosting (needs an API key) |
| **Qwant Search** | Server-side | Privacy-focused search, any model, **no API key required** |

### Additional Web Tools

| Tool | Purpose |
|------|---------|
| **webContentExtractor** | Open a web page or PDF by URL and read its main content as Markdown (offered automatically with web search) |
| **playwrightScreenshot** | Capture screenshots or PDFs using Playwright |
| **seleniumScreenshot** | Capture screenshots or PDFs using Selenium |
| **deepResearch** | Iterative multi-round web research |
| **researchPlanner** | Decompose research topics into subtasks |
| **evaluator** | Evaluate draft answers for quality |
| **answerReducer** | Merge multiple texts into one article |
| **queryRewriter** | Rewrite search queries for better results |

## Unified Web Search Configuration

> **Changed in v5.2.11**: Web search is now configured through a unified `websearch` object on each app instead of adding individual tool IDs (like `braveSearch` or `enhancedWebSearch`) to the `tools` array. Existing apps are automatically migrated.

### App-Level Configuration

Add a `websearch` object to your app configuration:

```json
{
  "id": "research-assistant",
  "name": { "en": "Research Assistant" },
  "system": { "en": "You are a research assistant with web search capabilities." },
  "websearch": {
    "enabled": true,
    "provider": "auto",
    "useNativeSearch": true,
    "maxResults": 5,
    "extractContent": true,
    "contentMaxLength": 3000,
    "enabledByDefault": false
  }
}
```

### Configuration Properties

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `enabled` | Boolean | `false` | Enable web search for this app |
| `provider` | String | `"auto"` | Search engine used when native search does not apply: `"auto"`, `"brave"`, `"staan"` or `"qwant"`. `"auto"` picks Brave when a Brave API key is configured, then Staan when it has one, and Qwant otherwise |
| `useNativeSearch` | Boolean | `true` | Prefer native search (Google Search for Gemini, OpenAI Web Search for GPT, Anthropic Web Search for Claude) when available |
| `maxResults` | Number | `5` | Maximum number of search results (1-20) |
| `extractContent` | Boolean | `true` | Extract full page content from search results |
| `contentMaxLength` | Number | `3000` | Maximum extracted content length per page (500-50,000 characters) |
| `enabledByDefault` | Boolean | `false` | Whether web search is active by default (users can toggle it in the chat) |
| `maxSearches` | Number | `5` | Cap on provider-run searches per model call when native search is used (sent to Anthropic as `max_uses`; 1-50). Anthropic bills each search separately |
| `researchGuidance` | Boolean or String | `true` | Guidance added to the system prompt when web search is on, telling the model to research in several steps. `true` uses the built-in text, `false` turns it off, a string replaces the built-in text. See [Multi-Step Research](#multi-step-research) |
| `maxPageReads` | Number | `5` | Cap on pages the model opens with the page reader (`webContentExtractor`) in one chat answer (1-50). Pages the search tool fetches for its own excerpts (`extractContent`) do not count. See [Page read limit](#page-read-limit) |

### How Provider Resolution Works

The system automatically selects the best search tool at runtime based on the model and configuration:

```
┌─────────────────────────────────────────────────┐
│              app.websearch.enabled?              │
│                                                  │
│  No  → No web search                            │
│  Yes ↓                                           │
│                                                  │
│  useNativeSearch + Gemini model?                 │
│    → Google Search (grounding)                   │
│                                                  │
│  useNativeSearch + OpenAI Responses model?       │
│    → OpenAI Web Search                           │
│                                                  │
│  useNativeSearch + Anthropic model?              │
│    → Anthropic Web Search                        │
│                                                  │
│  Otherwise → provider:                           │
│    "brave" → Brave Search                        │
│    "staan" → Staan Search                        │
│    "qwant" → Qwant Search                        │
│    "auto"  → Brave if a Brave API key is set,    │
│              else Staan if a Staan key is set,   │
│              else Qwant (needs no key)           │
└─────────────────────────────────────────────────┘
```

Whenever one of these script-backed search tools is offered — including when a
provider turns native search down and the loop falls back to it — the page
reader [`webContentExtractor`](#web-content-extractor-webcontentextractor) is
offered next to it. The search tool's automatic extraction only copies a short
excerpt of the top results (`contentMaxLength` each); the page reader lets the
model open one specific result, or a URL the user pasted, and read it in full.

The page reader is also offered next to **Anthropic** and **OpenAI Responses**
native search, whose requests accept function tools alongside the provider's
search: the provider searches, the reader opens a result or a pasted URL. It is
not offered next to **Google** native search. Gemini drops every function
declaration next to `google_search`; combining the two is a preview feature for
Gemini 3 models only and requires the server-side tool calls to be circulated
back through the conversation, which the adapter does not do yet. An admin can
switch the reader off by disabling the tool under **Admin → Tools**.

`"auto"` exists so an install without a Brave subscription still gets working
web search. It walks the keyed engines first, in registration order, so an
install that already had a Brave key keeps using it and does not change engine
on upgrade. A named provider is always honoured as configured — even when it is
unconfigured — so the resulting error names the engine the admin actually chose
rather than silently answering from a different one.

### Admin UI Configuration

Web search settings can be configured through the admin panel:

1. Navigate to **Admin → Apps → Edit App**
2. Scroll to the **Web Search Configuration** section
3. Toggle **Enable Web Search** to activate
4. Configure provider, result limits, and content extraction settings
5. Save changes — no server restart required

### User Toggle

When web search is enabled for an app, users see a toggle in the chat input's **+** menu to enable/disable web search per conversation. The `enabledByDefault` setting controls whether this toggle starts in the on or off state.

While web search is on, a highlighted **Web search** chip next to the **+** button says so; one click on it turns web search off.

In the model picker of a web search app, a globe marks the models web search works with, and is greyed out on the others — for example a model whose provider has no native search, while native search is off for it and no script-backed provider is usable (a named Brave or Staan provider without an API key, or a disabled search tool). The server reports what is usable per app on `GET /api/apps/:appId` as `websearchAvailability` (`{ native: [providers], script: boolean }`).

### Multi-Step Research

A chat turn allows up to 25 tool rounds, so the model can search several times and read the most
relevant pages before it answers.
Models tend to do only what they are asked, though, so when web search is on for a turn the server
adds a short research instruction to the end of the system prompt:

- break the question into its sub-questions;
- run several searches with different wording (and in another language where that helps);
- search again with more precise terms when results are thin or disagree;
- open the most relevant pages and read them in full when the search excerpts are not enough
  (with script-backed search through the page reader, `webContentExtractor`);
- check key claims against more than one source;
- combine the findings into one answer with the source URLs;
- stop once the question is answered, without searching for things the model already knows.

It is only added when web search is actually on for the turn (the user toggle, or
`enabledByDefault` when the user did not touch it). With web search off, the "web search is
turned off" notice is added instead, never both. The instruction is added once per turn and
only when the app has a system prompt.

Per app, `websearch.researchGuidance` controls it — in the admin UI under **Web Search →
Research in Several Steps**:

```json
"websearch": {
  "enabled": true,
  "researchGuidance": "Search at least twice, in English and German, and cite every source."
}
```

`true` (or leaving it out) uses the built-in text, `false` turns it off, and a string
replaces the built-in text (up to 4,000 characters).

How much the model can act on it depends on the search path:

- **Script-backed search (Brave, Staan, Qwant)**: each search is a tool call, so several searches
  show up as several tool calls in the turn.
- **OpenAI and Anthropic native search**: the provider runs the searches; the model can search
  several times per model call (Anthropic up to `maxSearches`).
- **Google native search**: the adapter sends Google Search grounding without any function
  tools, so the guidance only steers how Gemini uses its own grounding.

The default **Web Chat** app's prompt was reworded to match. Migration V124 updates an existing
`contents/apps/web-chat.json` only in the languages whose prompt is still exactly the old shipped
default; a prompt an admin changed is left as is (the added guidance applies to it anyway).

### Sources and Citations

Every answer that used web search gets a **Searched for “…”** entry under it
(**N searches** when there were several), with the icons of the sites it found.
It opens the **Sources** panel, a side panel on desktop and a bottom sheet on
phones — the same panel that lists the documents iFinder, iAssistant or any
other integration found for the answer (see [Answer Sources](answer-sources.md)),
with two sections:

- **Cited in this answer**: the sources the answer cites, numbered in the order
  it first cites them;
- **Also considered**: what the searches returned, or the page reader read,
  without being cited.

Each source card shows the site's favicon (as the search provider returned it;
iHub fetches none from a third-party service, sites without one get their
initial), the site, the title (opening the page), the snippet or
the cited passage, the published date when known, and whether the page was
**Read** or **Not readable**, with the words read and a *truncated* hint. Its
menu copies the link.

In the answer, each citation is a numbered superscript badge. Hovering or
focusing a badge highlights the paragraph it supports and its card; hovering a
card highlights every passage that cites it. A click or tap opens the sources
view on that card and pins the highlight until the view is closed. A badge stays
a link to the page, so a middle or modifier click opens the page itself.

A citation is a Markdown link to one of the turn's sources, conventionally
`[n](url)`. The number the model writes does not matter: sources are numbered by
the order the answer first links them. **A link to a URL that the turn's searches
and page reads did not return is never shown as a citation**, only as an
ordinary link. How the links get into the answer depends on the search path:

| Path | Citations come from |
|------|---------------------|
| Brave, Staan, Qwant | The model, which the source guidance (below) asks to cite with `[n](url)` links |
| Anthropic | Claude's `citations`: a marker follows each cited text block. Uncited search results are listed under *Also considered*, the `cited_text` on the card |
| Google | The grounding supports: markers go after the passage each one backs. A grounding chunk no support rests on is listed under *Also considered* |
| OpenAI Responses | The links OpenAI writes into the text. A `url_citation` annotation whose range does not link its source gets a marker after the range. Streamed annotations and `web_search_call` items are read into the same grounding metadata as the other providers |

The queries and sources are stored with the saved answer (`sources` on the
message), so a reopened chat shows the same panel and badges, and a shared one
the public web pages among them. A page only the page reader read is not
shared: the reader can reach intranet hosts on the SSL whitelist. For Google
the markers are written into the stored text.

When web search is on for a turn, the server adds a short source instruction to
the system prompt, next to the research guidance. It is not an admin setting —
the display depends on it — and it covers:

- **Citation format** (script-backed search): cite each claim with a
  Markdown link to the source URL, numbered, only URLs the turn returned, no
  separate source list at the end. With native search the provider cites its
  own results, so only pages read with the page reader are to be cited this way
  (when the reader is offered).
- **Named sites**: when the user names a site or domain, limit the search to it
  (`includeDomains`, or `site:` in the query).
- **Pasted URLs** (when the page reader is offered): open them with the page
  reader instead of searching for them, and read on with `offset` when a page is
  truncated.

### Page Read Limit

`websearch.maxPageReads` (default 5, **Admin → Apps → Web Search → Max Page
Reads per Answer**) caps how many pages the model opens with the page reader in
one chat answer. Past the cap, the read is not made and the model is told:
*page read limit reached for this turn, answer with what you have, and tell the
user they can continue in the next message*. The chat shows the refused read as
**Not read** with the same explanation. The pages the search tool fetches for
its own excerpts (`extractContent`) do not count; they stay capped by
`maxResults`. The cap applies to chats. An app invoked as a tool from a chat
runs its own turn and counts against its own `maxPageReads`, not the caller's.
Agents and workflows keep their own budgets.

### Migration from Legacy Tool Configuration

Apps that previously used websearch tool IDs in their `tools` array are automatically migrated on server startup (Migration V025). The migration:

- Detects apps with `braveSearch`, `enhancedWebSearch`, `googleSearch`, `webSearch`, or `webContentExtractor` in their `tools` array
- Infers the provider and content extraction settings from the tools used
- Creates a unified `websearch` configuration object
- Removes the deprecated tool IDs from the `tools` array

No manual action is required — the migration runs automatically.

## Answer Source Attribution

> **Added in v5.2.12**: Each AI response now displays a badge indicating the information source used.

When web search or other external sources are used, an **Answer Source Badge** appears on each message showing where the information came from:

| Badge | Color | Description |
|-------|-------|-------------|
| LLM Only | Gray | Response generated purely from the model's knowledge |
| Web Search | Green | Response includes information from web search results |
| Sources | Purple | Response uses configured knowledge base sources |
| iAssistant | Indigo | Response includes information from iFinder iAssistant |
| Grounding | Teal | Response uses Google Search grounding (Gemini) |
| Mixed | Blue | Response combines multiple information sources |

When multiple sources are used, a tooltip lists all contributing sources.

## Search Provider Configuration

### API Key Setup

Brave Search and Staan Search each require an API key. **Qwant requires none** —
it is listed under **Admin → Providers → Web Search Providers** as "No API key
required" and works as soon as an app selects it.

#### Admin Panel (Recommended)

1. Navigate to **Admin → Providers**
2. Find your provider under **Web Search Providers**:
   - **Brave Search**: Click "Configure" and enter your Brave API key
   - **Staan Search**: Click "Configure" and enter your staan.ai API key
   - **Qwant Search**: nothing to configure
3. Save changes — no server restart required

API keys are encrypted at rest using AES-256-GCM.

#### Environment Variables (Fallback)

Add to your `config.env` file:

```env
BRAVE_SEARCH_API_KEY=your_brave_api_key_here
STAAN_API_KEY=your_staan_api_key_here
```

The system checks admin panel configuration first, then falls back to environment variables.

### Search Language

Every engine searches in **the user's language**. It is resolved once, the same
way for all three:

1. The language of the request — the chat/app language, which comes from the
   client's explicit choice and otherwise from the browser's `Accept-Language`.
2. `defaultLanguage` in `contents/config/platform.json`, the install-wide
   default the rest of the platform already uses for localization.
3. `en`, only if the platform config cannot be read at all.

Each provider then maps that language onto whatever its own API expects, and
falls back to its own default only when the engine does not serve that language:

| Provider | Sends | Falls back to |
|----------|-------|---------------|
| Brave | `search_lang` (ISO 639-1) and `country` (2-letter), when the language is one Brave lists | no language parameters — an untargeted search |
| Staan | `market` (`de-de`, `en-gb`, …) | `en-us` |
| Qwant | `locale` (`de_DE`, `en_GB`, …) | `en_US` |

Step 2 is what makes a German install behave correctly in the places where no
user language exists — a workflow or agent run, which has no browser request
behind it. Set `defaultLanguage` to `de` there and those runs search the German
market instead of the US one. It changes only the search language: a workflow
still renders its own prompts in the language the run was started with.

Set it in **Admin → Customization → Localization**, which offers the languages
this installation has translations for. It takes effect immediately — the
platform cache is refreshed on save, so no restart is needed. It can also be
edited directly in `contents/config/platform.json`.

A model can still override the language for one search by passing the tool's
`language` parameter, which beats both of the above.

### Connectivity Test (Admin UI)

Whether a search provider *can be reached from this server* is a separate
question from whether it is configured correctly, and for Qwant it is the one
that usually decides the outcome. **Admin → Providers → Web Search Providers**
answers it directly:

- **Test** on a provider row runs one live search and fills in the
  **Connectivity** column. **Test All** covers every web search provider too.
- **Configure → Connectivity Test** does the same on the provider's own page,
  with an optional custom query, so a configuration can be saved and checked
  in one place.

Each test issues one real search and **bypasses the result cache**, so it
reports the provider's behaviour right now rather than replaying an earlier
success. The verdict names what to do next:

| Result | Means | Next step |
|--------|-------|-----------|
| **All OK** | The provider answered with results | Nothing — search works from this server |
| **Partial** | It answered, but returned nothing, or rate-limited the request | Try a broader query, or wait and retest |
| **Blocked** | Bot protection (DataDome) refused this server's IP | Change egress, or use Brave — see below |
| **Failed** | No API key, a rejected key, or the request never arrived | Fix the key, or check proxy/TLS settings |

A **Blocked** result is deliberately not labelled a failure. It means the
request reached Qwant and Qwant declined to answer *this IP address*; no setting
on the page will change that, and retrying will not either. The panel shows the
endpoint and the egress route (the outbound proxy, or `direct`) used for the
request, because that is the variable in play.

The same check is available without the UI:

```bash
node tests/manual/manual-test-qwant-search.js "your query" [--language=de]
node tests/manual/manual-test-staan-search.js "your query" [--language=de] [--max-results=20]
```

All three engines also accept an endpoint override, which is only needed to
point at a different host:

```env
BRAVE_SEARCH_ENDPOINT=https://api.search.brave.com/res/v1/web/search
QWANT_SEARCH_ENDPOINT=https://api.qwant.com/v3/search/
QWANT_SEARCH_USER_AGENT=          # override the browser UA Qwant is sent
STAAN_SEARCH_ENDPOINT=https://api.staan.ai/v2/search/web
WEB_READER_USER_AGENT=            # override the browser UA the page reader sends
```

### Native Search Providers

Native search providers (Google Search, OpenAI Web Search, and Anthropic Web Search) use the API keys already configured for the respective LLM providers. No additional API key setup is needed. Anthropic's native web search is billed separately by Anthropic in addition to standard token costs — see [Anthropic's web search pricing](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool#usage-and-pricing).

Native search is tuned per model in the model configuration (`nativeWebSearch`, see [Models → Native Web Search](models.md#native-web-search)):

- `enabled: false` turns native search off for one model — for example an Anthropic-compatible gateway that does not implement the server tool — so apps fall back to Brave Search on that model.
- Anthropic only: `toolVersion` selects the web search tool version (`web_search_20250305`, the basic version, by default; `web_search_20260209` and `web_search_20260318` add dynamic filtering on Claude 4.6 and later) and `dynamicFiltering` opts into filtering search results through code execution. Without it, newer versions are called directly (`allowed_callers: ["direct"]`), which is also what Google Cloud and Azure-hosted Foundry require.

Three safeguards apply to every native search call:

- **Search cap.** The app's `websearch.maxSearches` (default 5) or a workflow node's `maxWebSearches` is sent to Anthropic as `max_uses`. Once the cap is reached the model answers with what it has; the refused search reports `max_uses_exceeded` and is not billed.
- **Fallback on rejection.** When the provider refuses the request because of web search — web search disabled for the organisation in the Claude Console, a model or gateway that does not support the tool version — the call is retried without native search and with the `braveSearch` tool instead. The rejection is remembered for 15 minutes per model so later calls skip the failing request.
- **Paused turns.** A long Anthropic search turn can end with `stop_reason: pause_turn`. iHub replays the paused assistant message verbatim on a follow-up request (up to three times per call) so the answer is completed instead of truncated.

The billable search count (`server_tool_use.web_search_requests`) is recorded as `webSearchRequests` on the call's usage, in the run log and in the admin usage statistics (`webSearch` totals per app, model and user).

## Tools Reference

### Brave Search (`braveSearch`)

**Purpose**: Search the web using Brave Search API for up-to-date information.

**Parameters**:

- `query` (string, required): Search query
- `extractContent` (boolean, optional): Extract full content from top results (default: configured by app)
- `maxResults` (number, optional): Maximum results to return (default: configured by app, max: 10)
- `contentMaxLength` (number, optional): Maximum content length per page (default: configured by app)
- `language` (string, optional): Language or locale for the results, e.g. `en`, `de` or `en-GB` (default: the user's language — see [Search Language](#search-language))
- `freshness` (string, optional): Only results from the last `day`, `week`, `month` or `year` (sent to Brave as its own `freshness` parameter)
- `includeDomains` (string[], optional): Only results from these domains (max 10; sent as `site:` operators in the query)

**Returns**: Search results with title, URL, description and hostname, plus the page's date (`publishedDate` from Brave's `page_age`, and Brave's `age` label), extra snippets (on plans that include them) and the site's favicon; optionally extracted page content. See [Result Shape and Filters](#result-shape-and-filters).

### Qwant Search (`qwantSearch`)

**Purpose**: Search the web using Qwant for up-to-date information, without an API key or an account.

Qwant is the keyless counterpart to `braveSearch`. It returns the same result
shape, so an app can switch `websearch.provider` between the two without the
model seeing a different contract. Like `braveSearch`, it is injected from the
app's `websearch` config rather than listed in the app's `tools` array.

**Parameters**:

- `query` (string, required): Search query
- `extractContent` (boolean, optional): Extract full content from top results (default: configured by app)
- `maxResults` (number, optional): Maximum results to return (default: configured by app, max: 10 — one Qwant web request pages in tens)
- `contentMaxLength` (number, optional): Maximum content length per page (default: configured by app)
- `language` (string, optional): Language or locale for the results, e.g. `en`, `de`, `de-CH` (default: `en_US`)
- `freshness` (string, optional): Only results from the last `day`, `week`, `month` or `year`. Qwant has no such parameter: dated results outside the window are dropped, undated ones kept, and the result says so
- `includeDomains` (string[], optional): Only results from these domains (max 10; sent as `site:` operators in the query)

**Returns**: Search results with title, URL, description, hostname and an optional `publishedDate`, and optionally extracted page content.

> **Egress IP matters.** Qwant fronts its API with DataDome, which answers
> requests from data-centre IP ranges with a captcha instead of results. On a
> cloud VM or behind a hosting-network egress proxy, `qwantSearch` fails with
> `QWANT_CAPTCHA` however it is configured — that is a property of where the
> server runs, not of the setup. Check it before enabling Qwant with the
> [connectivity test](#connectivity-test-admin-ui) in the admin UI, and use
> Brave Search where Qwant is blocked.

### Staan Search (`staanSearch`)

**Purpose**: Search the web using [Staan](https://docs.staan.ai/docs/web-search) for up-to-date information.

Staan is the second keyed engine alongside `braveSearch`. It returns the same
result shape as the other two, so an app can switch `websearch.provider`
between them without the model seeing a different contract, and like them it is
injected from the app's `websearch` config rather than listed in the app's
`tools` array. Two things set it apart:

- It answers requests from data-centre IP ranges, so it works on the cloud
  hosting where Qwant is blocked.
- It takes **domain scoping** as a request parameter (`include_domains` /
  `exclude_domains`); the others restrict domains through `site:` in the query,
  and only Staan can exclude them.

**Parameters**:

- `query` (string, required): Search query. Supports the `site:` and `-site:` operators; trimmed to 400 characters
- `extractContent` (boolean, optional): Extract full content from top results (default: configured by app)
- `maxResults` (number, optional): Maximum results to return (default: configured by app, max: 40). Staan serves 10 results per request, so more than 10 costs one extra request per further 10
- `contentMaxLength` (number, optional): Maximum content length per page (default: configured by app)
- `language` (string, optional): Language or locale for the results, e.g. `en`, `de`, `en-GB` (default: `en-us`)
- `includeDomains` (string[], optional): Only return results from these domains (max 10)
- `excludeDomains` (string[], optional): Drop results from these domains (max 10)
- `freshness` (string, optional): Prefer results from the last `day`, `week`, `month` or `year` (best effort). Staan has no such parameter and returns no dates, so the filter cannot drop anything; the tool description and the result say so

`includeDomains` and `excludeDomains` are mutually exclusive — the API rejects a
request carrying both, so `includeDomains` wins when both are given.

**Returns**: Search results with title, URL, description, `hostname` and the site's favicon (Staan's `favicon_url`), and optionally extracted page content.

### Result Shape and Filters

All three script-backed tools share one result shape (`tools/lib/searchWithExtraction.js`),
so an app can switch provider without the model seeing a different contract:
`{ title, url, description, hostname }` plus, where the provider returns them,
`publishedDate` (ISO 8601), `age`, `snippets` and `favicon`. The chat's source
cards are drawn from these fields.

`freshness` and `includeDomains` work with every provider. A provider that
filters natively gets its own parameter (Brave `freshness`, Staan
`include_domains`); otherwise domains become `site:` operators in the query, and
freshness drops the dated results outside the window — keeping undated ones —
with a `note` in the result telling the model so. The filters applied are echoed
as `filters` in the result.

> **Markets.** Staan serves the German, French and English markets
> (`de-de`, `fr-fr`, `en-us`, `en-gb`, `en-fr`, `en-ca`, `en-au`, `en-in`,
> `en-ie`, `en-nz`, `en-za`, `en-sg`). An unsupported region falls back to a
> supported one for the same language (`de-CH` → `de-de`), and an unsupported
> language to `en-us`. Note that iHub defaults to `en-us` rather than to the
> API's own default of `fr-fr`.

### Native Search Providers (Google, OpenAI, Anthropic)

Google Search grounding, OpenAI Web Search, and Anthropic Web Search are **not** tools — there is no `googleSearch`, `webSearch`, or `anthropicWebSearch` entry in `contents/tools/`. Each is a provider capability resolved automatically from the app's `websearch` config (see [Unified Web Search Configuration](#unified-web-search-configuration) above) and injected directly into the request by the model adapter:

| Provider | Native capability | How it works |
|----------|--------------------|--------------|
| Google Gemini | Google Search grounding | Mutually exclusive with function calling (Gemini API limitation) — function tools are dropped when native search is active for that request |
| OpenAI (Responses API) | OpenAI Web Search | Combinable with function tools in the same request |
| Anthropic Claude | Anthropic's server-side [web search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool) | Combinable with function tools; Claude runs the search itself and returns results and citations in the same response, without a round trip through iHub; billed separately by Anthropic per search |

None of these take any parameters — they're automatically enabled when `websearch.useNativeSearch` is on and the app's model supports them (Anthropic additionally receives the app's search cap as `max_uses`). Search queries, results and citations are surfaced as grounding metadata, which powers the "Grounding" answer-source badge and the [sources panel and inline citations](#sources-and-citations). For OpenAI this includes streamed answers: the `url_citation` annotations and `web_search_call` items of the stream are read into the grounding metadata (before, only a non-streamed response's annotations were parsed, and nothing read them).

### Web Content Extractor (`webContentExtractor`)

**Purpose**: Open a web page or PDF by URL and return its main content as Markdown, without headers, footers, navigation, ads and other non-content elements.

**Parameters**:

- `url` (string, required): The URL of the page to open
- `maxLength` (integer, optional): Most characters returned per call (default: 10000, clamped to 500-50,000)
- `offset` (integer, optional): Character offset to start reading at — the previous result's `nextOffset`, to read on in a long page (default: 0)

**Availability**: Shipped as `contents/tools/webContentExtractor.json` and offered automatically next to the script-backed search tool whenever an app has `websearch.enabled`, and next to Anthropic and OpenAI native search (see [How Provider Resolution Works](#how-provider-resolution-works)). An app or workflow can also list it in `tools` directly; it is only offered once. Disable the tool to stop offering it. In chats, `websearch.maxPageReads` caps how often one answer may call it (see [Page Read Limit](#page-read-limit)).

**Certificates**: The model cannot switch certificate checking off. Invalid certificates are accepted only when the platform's `ssl.ignoreInvalidCertificates` setting allows it; domains in the SSL whitelist also bypass the SSRF check below.

**Returns**:

- `content`: one window of the page as Markdown — headings, lists, tables, links (absolute) and code are kept; images are reduced to their alt text. PDFs are returned as text
- `title`, `description`, `author`, and `siteName` / `publishedDate` when the page declares them. A PDF's title and author come from its metadata (the file name when it has no title)
- `truncated`, `totalLength`, `offset` and `nextOffset`: whether the page has more than this window, how long it is, and where the next window starts. A `note` repeats it in words, with the call to make to read on
- `incomplete` (only when true): the document is longer than the reader keeps (400 000 characters, or 500 PDF pages), so the rest cannot be read at any offset. The `note` says so, and the chat shows the page as *truncated*
- `wordCount` (words in this window), `contentType` (`html` or `pdf`), `format` (`markdown` or `text`), and `pageCount` / `pagesRead` for PDFs
- a `note` when the page returned little readable text (it may need JavaScript to render, or block automated access)
- If an error occurs, an exception is thrown with a `code` property for translation

**Features**:

- Main content found with Mozilla's Readability (the Firefox reader view), with the previous selector rules (`main`, `article`, known content containers, else `body` without chrome) as the fallback for pages that have no single article
- PDFs are read across all pages up to the length cap (400,000 characters, 500 pages), no longer only the first 10
- Requests go out with `Accept-Language` in the user's language (the platform default otherwise) and a current browser user agent (`WEB_READER_USER_AGENT` overrides it)
- Extracted pages are cached for a short time (the search cache TTL, `SEARCH_CACHE_TTL_MS`, default 10 minutes; bounded by size), so reading a page again, or reading on from an offset, costs no request
- Detects missing pages or authentication requirements and reports them clearly
- Returned errors include a `code` field so applications can translate messages and the UI automatically shows a localized error when possible
- **SSRF protection**: Blocks access to private/internal IP addresses. Domains listed in the SSL whitelist configuration bypass this check (added in v5.2.12)

In the chat's tool activity, a page read shows the page's title, its site, the words read and a *truncated* hint.

### Playwright Screenshot (`playwrightScreenshot`)

**Purpose**: Capture a screenshot or PDF of any webpage using the Playwright browser automation library. If a PDF is captured, the text is extracted and returned.

**Parameters**:

- `url` (string, required): Page URL to capture
- `format` (string, optional): `"png"` or `"pdf"` (default: `"png"`)
- `fullPage` (boolean, optional): Capture the full page height (default: `true`)

**Returns**: Attachment information with a download URL and extracted text for PDFs.

### Selenium Screenshot (`seleniumScreenshot`)

**Purpose**: Capture screenshots or PDFs using Selenium and Chrome DevTools.

**Parameters**:

- `url` (string, required): Page URL to capture
- `format` (string, optional): `"png"` or `"pdf"` (default: `"png"`)
- `fullPage` (boolean, optional): Capture the full page height (default: `true`)

**Returns**: Attachment information with a download URL and extracted text for PDFs.

### Answer Evaluator (`evaluator`)

**Purpose**: Check a draft answer for definitiveness, freshness and completeness.

**Parameters**:

- `question` (string, required): Original user question
- `answer` (string, required): Draft answer to evaluate
- `model` (string, optional): Model ID used for the evaluation (default `gemini-1.5-flash`)

**Returns**: Array `evaluation` with one entry per check containing `type`, `pass`, and `think` fields.

### Answer Reducer (`answerReducer`)

**Purpose**: Compress multiple text excerpts into a single well-structured article.

**Usage**: Pass an array of strings under the `answers` parameter.

```json
{
  "answers": ["text from source 1", "text from source 2"]
}
```

### Query Rewriter (`queryRewriter`)

**Purpose**: Generate optimized variations of a user search query.

**Parameters**:

- `query` (string, required): The original search query
- `think` (string, optional): Additional motivation or notes
- `context` (string, optional): Optional contextual text

**Returns**: An array of rewritten queries.

### Deep Research (`deepResearch`)

**Purpose**: Perform iterative web searches and content extraction while sending progress events to the frontend.

**Usage**: Include the `chatId` parameter when called from a chat session so the tool can emit progress updates.

```json
{
  "query": "renewable energy market analysis",
  "maxRounds": 2,
  "chatId": "{currentChatId}"
}
```

### Research Planner (`researchPlanner`)

**Purpose**: Decompose a research topic into distinct tasks for a team of researchers.

**Parameters**:

- `question` (string, required): Research topic to analyze
- `teamSize` (integer, optional): Number of tasks to create (default: 3)
- `soundBites` (string, optional): Additional context or quotes

**Returns**: JSON containing the `subproblems` array and internal reasoning in `think`.

## Installation Requirements

Run `npx playwright install` after installing dependencies. Selenium tools require a local Chrome or Chromium executable available in your `PATH`.

## Complete Example

Here is a complete app configuration with web search enabled:

```json
{
  "id": "web-chat",
  "name": {
    "en": "Web Chat",
    "de": "Web Chat"
  },
  "description": {
    "en": "General chat assistant with web search",
    "de": "Allgemeiner Chat-Assistent mit Websuche"
  },
  "color": "#4F46E5",
  "icon": "chat-bubbles",
  "system": {
    "en": "You are a helpful AI assistant with access to web search. When the user asks a question that requires current information, use the web search tool to find relevant content. Always cite your sources with URLs.",
    "de": "Du bist ein hilfreicher KI-Assistent mit Zugriff auf Websuche. Wenn der Benutzer eine Frage stellt, die aktuelle Informationen erfordert, nutze das Websuch-Tool. Zitiere immer deine Quellen mit URLs."
  },
  "preferredModel": "gemini-2.5-flash-preview-05-20",
  "preferredOutputFormat": "markdown",
  "websearch": {
    "enabled": true,
    "provider": "auto",
    "useNativeSearch": true,
    "maxResults": 5,
    "extractContent": true,
    "contentMaxLength": 3000,
    "enabledByDefault": false
  }
}
```

## Technical Implementation

### Content Extraction Algorithm

The web content extractor uses the following approach:

1. **Fetch the page** with the user's `Accept-Language`, a browser user agent and a timeout, re-validating every redirect hop against the SSRF guard (or serve it from the page cache)
2. **Parse HTML** using JSDOM, with the page's URL as the base for relative links
3. **Find the main content** with Readability; when it finds no article, strip navigation, ads and chrome and take the first known content container
4. **Convert to Markdown** with Turndown (ATX headings, fenced code, GFM tables)
5. **Extract metadata** (title, description, author, site name, published date)
6. **Cache the whole document** and return the window starting at `offset`, ending at a paragraph break where possible, with `truncated` / `totalLength` / `nextOffset`

`tools/lib/pageContent.js` holds the extraction rules as pure functions; `tools/webContentExtractor.js` does the fetching and caching.

### SSRF Protection

The web content extractor includes protection against Server-Side Request Forgery (SSRF):

- Blocks requests to private and internal IP addresses
- Blocks access to cloud metadata services (169.254.x.x, etc.)
- Only allows HTTP/HTTPS protocols
- **SSL-whitelisted domains** bypass the private IP check, allowing access to internal services that have been explicitly approved by the administrator (added in v5.2.12)

### Error Handling

- Invalid URLs are caught and reported
- Network timeouts are handled gracefully
- Failed content extractions don't break the search flow
- Detailed error messages help with debugging

### Performance Considerations

- Parallel processing of multiple URLs
- Configurable timeouts and content limits
- Efficient DOM parsing and text extraction
- Graceful degradation when extraction fails
- Parameter defaults are overridden by admin-configured websearch values at runtime

## Security Considerations

- URL validation prevents malicious requests
- Only HTTP/HTTPS protocols are supported
- Request timeouts prevent hanging connections
- Content length limits prevent memory issues
- User-Agent headers for responsible web crawling
- SSRF protection blocks access to internal networks
- API keys encrypted at rest in the admin panel

## Troubleshooting

### Common Issues

1. **"BRAVE_SEARCH_API_KEY is not set"**
   - Configure the key via Admin → Providers → Brave Search (recommended)
   - Or set the API key in your `config.env` file and restart the server
   - Or switch the app to Qwant (`websearch.provider: "qwant"`), which needs no key.
     `"auto"` already does this on an install with no Brave key

2. **Qwant search fails with `QWANT_CAPTCHA`**
   - Qwant's API is behind DataDome, which challenges data-centre IP ranges —
     so this is about where the server sends its traffic from, not how it is
     configured, and no retry or setting will clear it
   - Confirm it for the host with **Admin → Providers → Qwant Search → Test**,
     or `node tests/manual/manual-test-qwant-search.js`
   - Route outbound search traffic through an egress IP Qwant accepts, or
     configure Brave Search for that install

3. **"Failed to extract content"**
   - Check if the URL is accessible
   - Some websites may block automated requests
   - Try with a different URL to test functionality

4. **"Request timeout"**
   - The webpage is taking too long to load
   - Consider increasing timeout or trying a different URL

5. **Web search not working after upgrade**
   - Migration V025 automatically converts old tool-based configs to the new `websearch` format
   - Check server logs for migration output
   - Verify the app has `websearch.enabled: true` in its configuration

6. **Native search not activating for Gemini/GPT/Claude models**
   - Ensure `useNativeSearch` is `true` (default)
   - Verify the model's provider is correctly identified as `google`, `openai-responses`, or `anthropic`
   - Check the model configuration: `nativeWebSearch.enabled: false` switches that model to Brave Search

7. **Answers on a Claude model come from Brave Search although native search is on** (log line `Native web search unavailable — falling back to a search tool`)
   - The provider rejected the native search request. On Anthropic, check that web search is enabled for your organisation in the Claude Console and that the model supports the configured `nativeWebSearch.toolVersion` (the basic `web_search_20250305` works everywhere)
   - Gateways or proxies that do not implement the server tool: set `nativeWebSearch.enabled: false` on that model so it uses Brave Search without the failed attempt
   - The rejection is remembered for 15 minutes per model; restart the server to reset it earlier

8. **Brave Search requests hang or time out**
   - A search that works when called directly (e.g. from a browser or Postman on your own machine) but times out from iHub is usually the server's outbound proxy — either not configured when the network requires it, or configured but blocking/excluding Brave's domain
   - See [Proxy Testing Guide → Still Getting Timeout Errors?](proxy-testing-guide.md#still-getting-timeout-errors) for Linux/macOS and Windows commands that reproduce the exact request iHub sends, with and without the proxy, so you can tell which side is failing

### Debugging

Enable detailed logging by checking the console output when running the tools. The server logs include information about which websearch tool was selected and why.
