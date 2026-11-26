---
description: 'Search the web and read web pages from chats, with the supported search engines.'
audience: admin
type: reference
adminPage: /admin/integrations
---

# Web Tools

This document describes the web tools available in the iHub Apps platform for searching the web and extracting web content.

## Overview

iHub Apps provides a unified web search system that automatically selects the best search provider based on the active model. Web search is configured per-app through the `websearch` configuration object rather than through individual tool IDs.

Each search engine is an integration of its own, of type `web-search`, installed under **Admin → Integrations** (group **Web search**, see [Integrations](integrations.md)): **Brave Search** (`com.intrafind/brave-search`, installation `brave`) **Staan** (`com.intrafind/staan-search`, `staan`) and **SearXNG** (`com.intrafind/searxng-search`, `searxng`, a metasearch gateway you run yourself). An engine installation holds what that engine needs (Brave and Staan: the API key; SearXNG: the URL of your instance); a third party can ship its own engine (see [Writing your own engine](#writing-your-own-engine)). Apps switch web search on in their own settings and pick an engine or **Auto**.

**No engine is needed for native search.** A fresh install ships no engine: an app with web search on searches with the model's own search on Google, OpenAI Responses and Anthropic models, and gets no web search on other models until an engine is installed. The page reader `read_url` belongs to the web search feature, not to an engine.

### Search Providers

| Provider                 | Type                                   | Best For                                                                                                                                                       |
| ------------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Google Search**        | Native (Gemini models)                 | Grounded answers with Google Search citations                                                                                                                  |
| **OpenAI Web Search**    | Native (GPT models via Responses API)  | Web-augmented responses with inline citations                                                                                                                  |
| **Anthropic Web Search** | Native (Claude models)                 | Web-augmented responses with inline citations                                                                                                                  |
| **Brave Search**         | Engine (installation `brave`)          | Privacy-focused search, any model (needs an API key)                                                                                                           |
| **Staan Search**         | Engine (installation `staan`)          | European search index, any model, works from cloud hosting (needs an API key)                                                                                  |
| **SearXNG**              | Engine (installation `searxng`)        | Search through your own metasearch gateway, any model; needs the URL of an instance with JSON output enabled (see [SearXNG](#searxng-your-own-search-gateway)) |
| Your own                 | Engine (any `web-search` installation) | A `script` or `openapi` definition of type `web-search`                                                                                                        |

### Additional Web Tools

| Tool         | Purpose                                                                                                                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **read_url** | Open a web page or PDF by URL and read its main content as Markdown (offered automatically with web search, with any engine and next to native search on Anthropic and OpenAI Responses) |

## Unified Web Search Configuration

> [!IMPORTANT]
> **Changed in v5.2.11:** Web search is now configured through a unified `websearch` object on each app instead of adding individual tool IDs (like `braveSearch` or `enhancedWebSearch`) to the `tools` array. Existing apps are automatically migrated.

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

| Property           | Type              | Default  | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------ | ----------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`          | Boolean           | `false`  | Enable web search for this app                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `provider`         | String            | `"auto"` | Engine used when native search does not apply: `"auto"` or the id of an engine installation (`"brave"`, `"staan"`, `"searxng"`, a third-party engine's id). `"auto"` takes the first engine that is enabled and that the user's groups grant, in the order Brave, Staan, SearXNG, then any other engine by id. A named engine that is missing, disabled or not granted means no tool-based search (native search still works); it never falls back to another engine |
| `required`         | Boolean           | `false`  | Hide the app while its engine is not available: on `"auto"` while no engine is installed and enabled, on a named engine while that one is missing or disabled. Off, the app stays available and searches natively where the model can                                                                                                                                                                                                                                |
| `useNativeSearch`  | Boolean           | `true`   | Prefer native search (Google Search for Gemini, OpenAI Web Search for GPT, Anthropic Web Search for Claude) when available                                                                                                                                                                                                                                                                                                                                           |
| `maxResults`       | Number            | `5`      | Maximum number of search results (1-20)                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `extractContent`   | Boolean           | `true`   | Extract full page content from search results                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `contentMaxLength` | Number            | `3000`   | Maximum extracted content length per page (500-50,000 characters)                                                                                                                                                                                                                                                                                                                                                                                                    |
| `enabledByDefault` | Boolean           | `false`  | Whether web search is active by default (users can toggle it in the chat)                                                                                                                                                                                                                                                                                                                                                                                            |
| `maxSearches`      | Number            | `5`      | Cap on provider-run searches per model call when native search is used (sent to Anthropic as `max_uses`; 1-50). Anthropic bills each search separately                                                                                                                                                                                                                                                                                                               |
| `researchGuidance` | Boolean or String | `true`   | Guidance added to the system prompt when web search is on, telling the model to research in several steps. `true` uses the built-in text, `false` turns it off, a string replaces the built-in text. See [Multi-Step Research](#multi-step-research)                                                                                                                                                                                                                 |
| `maxPageReads`     | Number            | `5`      | Cap on pages the model opens with the page reader (`read_url`) in one chat answer (1-50). Pages the search tool fetches for its own excerpts (`extractContent`) do not count. See [Page read limit](#page-read-limit)                                                                                                                                                                                                                                                |

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
│    → OpenAI Web Search (+ page reader)           │
│                                                  │
│  useNativeSearch + Anthropic model?              │
│    → Anthropic Web Search (+ page reader)        │
│                                                  │
│  Otherwise → the engine of `provider`:           │
│    "auto"  → the first engine that is enabled    │
│              and granted to the user: Brave,     │
│              Staan, SearXNG, then any other      │
│              engine by id                        │
│                                                  │
│    an id   → that engine, if it is installed,    │
│              enabled and granted                 │
│    none    → no web search on this model         │
│    (the engine's search tool + page reader)      │
└─────────────────────────────────────────────────┘
```

Native search is the app's own feature: it needs **no engine installation and
no integration grant**. An app with web search on therefore searches on
Google, OpenAI Responses and Anthropic models even while no engine is
installed, and the model picker marks the other models as without web search.

An engine is an installed integration like any other: it is used only while it
is enabled and one of the user's groups grants it (`groups.json` →
`permissions.integrations`: `*`, the engine's id such as `brave`, its
definition id, or `type:web-search` for every engine; see
[Integrations → Who may use an integration](integrations.md#who-may-use-an-integration)).
`"auto"` passes over an engine the user may not use, and over one whose
**Search the web** action an admin switched off; a named engine is used or not
at all, so an app set to one engine never silently answers from another.

An app gets web search through its `websearch` configuration. A **workflow
node** or agent profile has no tool list (#3275): it binds an engine like any
integration (`"integrations": { "type:web-search": { "actions": ["search"] } }`,
or one engine's installation id), names the page reader in `systemTools`
(`["read_url"]`; the shipped `claude-style-agent` and `research-assistant`
workflows do) and may set `webSearch: true`. An engine's tool is served while
its engine is installed, enabled and granted. A node's `webSearch: true` resolves to native search where the model runs it, and
otherwise to the search tool of the first engine the user may use (`auto`);
with no engine it adds nothing. Web search for an _app_, though, is configured
in `websearch` as above.

Whenever an engine's search tool is offered — including when a provider turns
native search down and the loop falls back to it — the page reader
[`read_url`](#page-reader-read_url) is offered next to it. The search
tool's automatic extraction only copies a short excerpt of the top results
(`contentMaxLength` each); the page reader lets the model open one specific
result, or a URL the user pasted, and read it in full.

The page reader is also offered next to **Anthropic** and **OpenAI Responses**
native search, whose requests accept function tools alongside the provider's
search — with or without an engine: the provider searches, the reader opens a
result or a pasted URL. It is not offered next to **Google** native search.
Gemini drops every function declaration next to `google_search`; combining the
two is a preview feature for Gemini 3 models only and requires the server-side
tool calls to be circulated back through the conversation, which the adapter
does not do yet. The reader is a platform tool of the web search feature
(`server/defaults/tools/read_url.json`), not an engine's action: an admin
switches it off for the whole platform with `"webSearch": { "pageReader": false }` in
`platform.json` (a restart applies it; migration V230 sets it where a disabled
`contents/tools/read_url.json` kept the reader off before).

### Admin UI Configuration

Web search settings can be configured through the admin panel:

1. Navigate to **Admin → Apps → Edit App**
2. Open the **Web Search** panel in the **Integrations** section (every chat app has it)
3. Toggle **Enable Web Search** to activate
4. Pick the **Search engine** (**Auto** or one of the installed engines), result limits, and content extraction settings
5. Save changes — no server restart required

The engine list shows **Auto** and every installed engine, a disabled one
marked as such. An engine the app names that is not installed (or is
disabled) stays selected and is called out with a warning: the app then
searches only natively. While no engine is installed at all, the panel says
so and links to the catalog.

The engines themselves — their API keys and who may use them — are set on
their installations under **Admin → Integrations → Web search** (see
[API Key Setup](#api-key-setup)). Web search does not hide an app while no
engine is available, unless **Required** is on (`websearch.required: true`):
then **Admin → Apps** names the missing engine (`type:web-search` for Auto)
and users do not get the app.

### User Toggle

When web search is enabled for an app, users see a toggle in the chat input's **+** menu to enable/disable web search per conversation. The `enabledByDefault` setting controls whether this toggle starts in the on or off state. The toggle (and the chip below) is offered only on models web search works with: a model whose provider runs native search, or any tool-calling model while an engine is available to the user.

While web search is on, a highlighted **Web search** chip next to the **+** button says so; one click on it turns web search off.

In the model picker of a web search app, a globe marks the models web search works with, and is greyed out on the others — for example a model whose provider has no native search, while no engine is usable for the user (none installed, the named engine missing or disabled, an engine the user's groups do not grant, or Brave or Staan without an API key). The server reports what is usable per app and user on `GET /api/apps/:appId` as `websearchAvailability` (`{ native: [providers], script: boolean }`).

### Multi-Step Research

A chat turn allows up to 50 tool rounds, so the model can search several times and read the most
relevant pages before it answers.
Models tend to do only what they are asked, though, so when web search is on for a turn the server
adds a short research instruction to the end of the system prompt:

- plan before the first search what the answer must contain, and break the question into its
  sub-questions;
- for a list or a table, find the items first (one search for an authoritative list or ranking),
  then the details per item, from a page that holds many of them at once;
- run several searches with different wording (and in another language where that helps);
- search again with more precise terms when results are thin or disagree;
- open the most relevant pages and read them in full when the search excerpts are not enough
  (with an engine, and next to Anthropic and OpenAI native search, through the page reader,
  `read_url`);
- check key claims against more than one source;
- combine the findings into one answer, citing the source of each statement right after it;
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

- **Engines (Brave, Staan, your own)**: each search is a tool call, so several searches
  show up as several tool calls in the turn.
- **OpenAI and Anthropic native search**: the provider runs the searches; the model can search
  several times per model call (Anthropic up to `maxSearches`).
- **Google native search**: the adapter sends Google Search grounding without any function
  tools, so the guidance only steers how Gemini uses its own grounding.

The default **Web Chat** app's prompt was reworded to match. Migration V124 updates an existing
`contents/apps/web-chat.json` only in the languages whose prompt is still exactly the old shipped
default; a prompt an admin changed is left as is (the added guidance applies to it anyway).

The prompt used to say _"Always cite your sources with URLs"_. Smaller and local models read that
as "add a sources section" and ended their answers with a **Sources:** / **Quellen:** list, which
repeats **Cited in this answer** under the answer. It now asks for the source right after each
statement; migration V233 updates `web-chat.json` the same way, again only in languages whose
prompt is still the shipped default. If you wrote your own prompt, avoid asking for "sources with
URLs" or a list of sources: the chat lists them.

### Sources and Citations

How the answer searched stays above it, one segment per place it looked: **Web 10 results · 3
opened · via Brave Search**, which unfolds into each search and the pages it opened. Everything about the sources is at
the answer's end: the list of the sources it cites, then one row with an **N results** entry, with
the icons of the sites it found, and the **Based on web search** badge. _Results_, not _sources_:
the count includes everything the searches found, and only what the answer cites is a source of
it. The entry appears once the answer is complete; while it streams, the numbered badges in the
text open the panel.

The entry opens the **Sources** panel, a side panel on desktop and a bottom sheet on
phones — the same panel that lists the documents iFinder, iAssistant or any
other integration found for the answer (see [Answer Sources](answer-sources.md)),
with the searches in its header and two sections:

- **Cited in this answer**: the sources the answer cites, numbered in the order
  it first cites them;
- **Also considered**: what the searches returned, or the page reader read,
  without being cited.

An answer that cites no page at all (some models, local ones especially, write
no links) shows **Read for this answer** in place of the cited list, under the
answer and in the panel: the pages the search or the page reader read, which is
what the answer was written from. The other results stay under **Also
considered**. An empty list is never shown.

Each source card shows the site's favicon (as the search provider returned it;
iHub fetches none from a third-party service, sites without one get their
initial), the site, the title (opening the page), the snippet or
the cited passage, the published date when known, and whether the page was
**Read** or **Not readable**, with the words read and a _truncated_ hint. Its
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

| Path                          | Citations come from                                                                                                                                                                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Brave, Staan, your own engine | The model, which the source guidance (below) asks to cite with `[n](url)` links                                                                                                                                                                          |
| Anthropic                     | Claude's `citations`: a marker follows each cited text block. Uncited search results are listed under _Also considered_, the `cited_text` on the card                                                                                                    |
| Google                        | The grounding supports: markers go after the passage each one backs. A grounding chunk no support rests on is listed under _Also considered_                                                                                                             |
| OpenAI Responses              | The links OpenAI writes into the text. A `url_citation` annotation whose range does not link its source gets a marker after the range. Streamed annotations and `web_search_call` items are read into the same grounding metadata as the other providers |

The queries and sources are stored with the saved answer (`sources` on the
message), so a reopened chat shows the same panel and badges, and a shared one
the public web pages among them. A page only the page reader read is not
shared: the reader can reach intranet hosts on the SSL whitelist. For Google
the markers are written into the stored text.

When web search is on for a turn, the server adds a short source instruction to
the system prompt, next to the research guidance. It is not an admin setting —
the display depends on it — and it covers:

- **Citation format** (search through an engine): cite each claim with a
  Markdown link to the source URL, numbered, only URLs the turn returned. With
  native search the provider cites its own results, so only pages read with the
  page reader are to be cited this way (when the reader is offered).
- **Named sites**: when the user names a site or domain, limit the search to it
  (`includeDomains`, or `site:` in the query).
- **Pasted URLs** (when the page reader is offered): open them with the page
  reader instead of searching for them, and read on with `offset` when a page is
  truncated.
- **No list of sources at the end** (every search path, last in the prompt): no
  closing list of sources, references or links, named as models write it
  (_Sources:_, _Quellen:_, _References_), because the chat lists the cited
  sources under the answer.

When a model writes such a list anyway, the chat leaves it out of the finished
answer, as long as it is clearly one: at the very end, introduced by a short
heading, bold line or "…:" line and/or a horizontal rule, every line linking one
of the answer's sources and naming nothing but its title or site, after text
that already cites the sources inline. Every source in it is listed under
**Cited in this answer**. A summary with citations, links to pages the turn did
not find, a table or a list in the middle of the answer stay. The stored answer,
**Copy** and exports keep the list.

### Page Read Limit

`websearch.maxPageReads` (default 5, **Admin → Apps → Web Search → Max Page
Reads per Answer**) caps how many pages the model opens with the page reader in
one chat answer. Past the cap, the read is not made and the model is told:
_page read limit reached for this turn, answer with what you have, and tell the
user they can continue in the next message_. The chat shows the refused read as
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

Migration V195 then moved the engines into one installation, `websearch` (in 5.6.5-RC1):

- Moves the Brave and Staan API keys from `providers.json` into the credentials
  `integration-websearch-brave` / `integration-websearch-staan` (they were
  already encrypted, so they are carried over as they are) and removes the
  `websearch` entries from `providers.json`
- Creates the installation `websearch` (definition `com.intrafind/web-search`)
  referencing those credentials, or updates an existing one
- Deletes the shipped tool files `braveSearch.json`, `staanSearch.json`,
  `qwantSearch.json` and `read_url.json` from `contents/tools/` — the tools now
  belong to the installation and keep their ids
- Removes `braveSearch`, `staanSearch` and `qwantSearch` from every app's
  `tools` array. An app that had web search only through such a reference (no
  `websearch.enabled: true`) gets `websearch: { enabled: true,
enabledByDefault: true, provider }` with the engine it named — the
  installation's default engine when several were listed, else the first — so
  it keeps searching with that engine; the change is logged per app. A
  `read_url` reference stays

Migration V204 makes every engine its own installation and removes
`websearch` ("keep what worked"):

- `brave` is installed where a Brave key was configured (the credential
  `websearch` referenced, which moves to the engine's **API key** field, or
  `BRAVE_SEARCH_API_KEY`); `staan` likewise (`STAAN_API_KEY`)
- `qwant` was installed where Qwant was reachable: the default engine was
  `auto` without any key, or `qwant`, or an app named `qwant` (the Qwant
  engine no longer exists; migration V264 removes it, see below)
- each engine takes over the enabled state of `websearch`; an engine or page
  reader action `websearch` had switched off stays off (the page reader
  through `contents/tools/read_url.json` with `enabled: false`)
- when the default engine of `websearch` was an explicit one, apps on
  `auto` are set to that engine, so their engine does not change
- group grants of `websearch` (or `com.intrafind/web-search`) become
  `type:web-search`; app bindings and `tools` entries naming `websearch` are
  removed
- a fresh install gets no engine

Migration V264 removes the Qwant engine, which was blocked from most
data-centre IP addresses: the `qwant` installation is deleted, apps with
`websearch.provider: "qwant"` are set to `auto`, and grants of `qwant` (or
`com.intrafind/qwant-search`) are dropped from the groups. Nothing replaces it —
install Brave Search, Staan or SearXNG under **Admin → Integrations**; until then an app
searches only on models with native search.

No manual action is required — the migrations run automatically. Check the
server log for the `V204` and `V264` lines: they name each engine installed or
removed, and why.

## Answer Source Attribution

> [!IMPORTANT]
> **Changed:** the colour-coded badges (AI knowledge, Web Search, Mixed, …) and the separate
> **AI generated** button are replaced by one chip. See
> [Answer Sources → What users see](answer-sources.md#what-users-see).

Under each finished answer, one outlined chip says what the answer is based on. It names only the
**kinds** of source the answer used, and no more than two of them, then **+N**:

| Chip                   | Meaning                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| Model knowledge        | The model's own knowledge: nothing was retrieved                                                   |
| Web                    | Web search results, or the provider's own search (Google Search grounding)                         |
| Project                | Documents of a project that went into the prompt or came back from a search                        |
| iFinder, iAssistant    | Documents found by an iFinder search, or iAssistant's knowledge base                               |
| Documents              | Knowledge base sources an admin configured                                                         |
| Jira, Munich AD, …     | An installed integration, an MCP server or a remote agent, under its own name                      |
| Email, File, Recording | The open or added email or meeting (Outlook add-in), an uploaded file or image, an audio recording |
| Workflow               | The answer was produced by a workflow run                                                          |

Opening the chip shows **About this answer**: the AI-generated statement, each source by name, the
projects that were in scope but not used, and the provenance details.

The server decides the chip: it names the basis when the turn ends (`run/ended.answerBasis`, see
[Streaming Events](streaming-events.md#a-chat-turn-on-the-wire)). The browser only displays it. An answer stopped after
it started keeps the basis it had; one without a basis — a failed turn, one stopped before it wrote
anything or cut off by a server restart, a notice, an answer stored before the server kept it —
shows no chip.

## Search Provider Configuration

### API Key Setup

Brave Search and Staan Search each require an API key. The keys belong to the engine installations — there is no web search
category under **Admin → Providers**, and the keys are not in `providers.json`.

#### Installation and Credentials (Recommended)

1. Store the key as a credential of type **secret** under **Admin →
   Integrations → Credentials**
2. Install the engine from **Admin → Integrations → Catalog → Web search**
   (**Brave Search** installs as `brave`, **Staan** as `staan`), or open its
   tile on the **Installed** tab, and pick the credential in **API key**
   (`apiKeyRef`)
3. **Test connection** checks the key of the values as entered and runs one
   live search (see [Connectivity Test](#connectivity-test-admin-ui)); save —
   no server restart required

The engine's **groups** decide who may use it (**Admin → Groups → a group →
Integrations**: the engine, or **All web search engines**,
`type:web-search`). An engine can be switched off as a whole, which takes its
search tool away from every app; native search is not affected.

Credentials are encrypted at rest using AES-256-GCM. On an upgrade, migrations
V195 and V204 carry the keys that were stored under **Admin → Providers** into
the credentials `integration-websearch-brave` and `integration-websearch-staan`
and reference them from the engine installations, so nothing has to be
re-entered.

#### Environment Variables (Fallback)

Set `BRAVE_SEARCH_API_KEY` or `STAAN_API_KEY` as a real environment variable (or in the `.env` file of a source checkout). The shipped `config.env` of the binary distribution no longer lists them.

The environment variable applies when the engine installation references no credential (or the referenced one is empty); a referenced credential wins. The variable alone does not make an engine available: the engine must be installed.

### Search Language

Every engine searches in **the user's language**. It is resolved once, the same
way for both:

1. The language of the request — the chat/app language, which comes from the
   client's explicit choice and otherwise from the browser's `Accept-Language`.
2. `defaultLanguage` in `contents/config/platform.json`, the install-wide
   default the rest of the platform already uses for localization.
3. `en`, only if the platform config cannot be read at all.

Each provider then maps that language onto whatever its own API expects, and
falls back to its own default only when the engine does not serve that language:

| Provider | Sends                                                                                    | Falls back to                                 |
| -------- | ---------------------------------------------------------------------------------------- | --------------------------------------------- |
| Brave    | `search_lang` (ISO 639-1) and `country` (2-letter), when the language is one Brave lists | no language parameters — an untargeted search |
| Staan    | `market` (`de-de`, `en-gb`, …)                                                           | `en-us`                                       |
| SearXNG  | `language` (`de`, `en-GB`, …), as given                                                  | SearXNG's own default                         |

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

### SearXNG: Your Own Search Gateway

[SearXNG](https://docs.searxng.org/) is a metasearch engine you run yourself. It has no index of its
own: it forwards each query to the search engines you enable in it (Google, Bing, Brave, DuckDuckGo
and others) and merges their answers. The **SearXNG** engine (`com.intrafind/searxng-search`,
installation `searxng`) makes iHub a client of such an instance, so the search traffic of iHub goes
to a gateway under your control and not to a search vendor's API.

**What this gives you, and what it does not.**

- iHub sends your SearXNG instance the query and the language, and no user name, address or other
  identity data. The query itself can contain personal information (a user may type a name into the
  question), and the instance and the engines behind it receive it. The engines see the instance's
  address, not iHub's and not the user's.
- The instance decides which engines see a query, and you can log, filter or block there. That is
  the control.
- **The queries still leave your network** if the instance forwards them to Google, Bing or another
  external engine. Only an instance whose engines are all hosted by you keeps a query inside. Do not
  describe SearXNG as "searching on-premise"; describe it as "search under your control".
- SearXNG is not a search engine with an index. It answers as well as the engines behind it do, and
  those engines can block it (CAPTCHA, rate limits), especially from data-centre addresses.

#### Set up the instance

SearXNG's own [installation guide](https://docs.searxng.org/admin/installation.html) is the
reference. iHub needs two things from the instance:

1. **JSON output.** SearXNG answers `format=json` only when `json` is listed under
   `search.formats` in its `settings.yml`; otherwise it answers **HTTP 403**. This is the most
   common reason a new setup fails.
2. **Being reachable from the iHub server**, without a bot limiter that blocks it.

A minimal `settings.yml` for a private instance, mounted into the container as `/etc/searxng/`:

```yaml
use_default_settings: true
search:
  formats:
    - html
    - json
server:
  secret_key: '<a long random string, e.g. from: openssl rand -hex 32>'
  limiter: false
```

```bash
docker run -d --name searxng -p 127.0.0.1:8080:8080 -v ./searxng:/etc/searxng docker.io/searxng/searxng
```

This binds the port to the local host, for an iHub server on the same machine. SearXNG has no
sign-in and the example turns its limiter off, so do not publish the port to a network you do not
trust: put the instance on a container network shared with iHub (and omit `-p`), or behind a
reverse proxy that asks for a sign-in (see **Authorization** below). An iHub server on the same
machine reaches it as `localhost`, which the address check below refuses until `localhost` is on
`ssrf.allowedHosts`.

If you switch the limiter on (it is off unless `server.limiter: true`), put the iHub server's
address under `pass_ip` in `[botdetection.ip_lists]` of `limiter.toml`, and make sure a reverse
proxy in front of SearXNG passes `X-Forwarded-For` and `X-Real-IP`, or SearXNG does not see the real
client address.

#### Install it in iHub

1. **Admin → Integrations**, group **Web search**, install **SearXNG**.
2. **Instance URL** (required): the base URL of the instance, e.g. `https://search.example.org` or
   `http://searxng:8080`. A trailing `/search` is removed; an instance running under a path needs
   that path (`https://host/searx`). A URL with a user name and password in it is refused: use the
   authorization field.
3. **Authorization** (optional): SearXNG has no sign-in of its own. If a reverse proxy in front of
   it asks for one, pick a credential of type **secret**. It is sent as
   `Authorization: Bearer <secret>`; a secret that already starts with `Basic ` or `Bearer ` is sent
   as it is, which is how a proxy that wants HTTP Basic is served (`Basic dXNlcjpwYXNz`). Use an
   `https://` instance URL with it: over plain `http://` the secret crosses the network in clear
   text, and **Test connection** warns about that (it is allowed for a loopback address).
4. **Test connection** checks the URL and the credential as entered and runs one live search. It
   tells the usual causes apart: JSON output off (403), wrong URL or path (404), the limiter (429),
   a credential the proxy rejects (401), and an instance whose engines all failed.
5. Apps pick it with `websearch.provider: "searxng"`, or take it on **Auto**: SearXNG comes after
   Brave and Staan, so an install that also has one of those on Auto keeps using it. Name
   `searxng` in the apps that must use your gateway.

The address of the instance is checked like any other URL an admin enters (the SSRF guard). A
company-internal address (10.x, 172.16-31.x, 192.168.x, or a name that resolves to one) is accepted
without further setup, and the connection goes to the address that was checked. A loopback address
such as `localhost`, a link-local or cloud-metadata address, or a name this server cannot resolve is
refused (`SEARXNG_TARGET_BLOCKED`) unless the host is on `ssrf.allowedHosts` (Admin → Security) or
`ssl.domainWhitelist`. When an outbound proxy carries the request, the proxy resolves the name
itself and is the trust boundary, as for every outbound connection of iHub: the check runs, but the
connection cannot be pinned to the checked address. A redirect from the instance is not followed: iHub reports it
(`SEARXNG_REDIRECT`) and you enter the URL it leads to, for example the `https://` address.

The instance is also a normal outbound connection of iHub: it follows `HTTPS_PROXY` / `NO_PROXY` and
`proxy.urlPatterns`, so an instance on the internal network needs a proxy bypass when a corporate
proxy is configured; and for a self-signed or private-CA certificate it follows
`ssl.ignoreInvalidCertificates` with the host in `ssl.domainWhitelist` (see
[Proxy configuration](proxy-configuration.md)).

#### How a search behaves

|                  |                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request          | `GET <instance>/search?q=…&format=json&categories=general&language=…`                                                                                                                             |
| Language         | The user's language (`de`, `de-CH`, …), else `platform.defaultLanguage`; SearXNG applies its own default for one it does not know                                                                 |
| Results          | One page, the first `maxResults` (default 10, at most 20); SearXNG has no result count                                                                                                            |
| `freshness`      | Sent as `time_range`. SearXNG has `day`, `month` and `year` only, so `week` is sent as `month`; engines that ignore the range are covered by dropping dated results outside the window afterwards |
| `includeDomains` | `site:` operators in the query                                                                                                                                                                    |
| Cache            | Per instance, query, language, range and count (`SEARCH_CACHE_TTL_MS`)                                                                                                                            |
| Throttle         | At most two searches at a time                                                                                                                                                                    |
| Sources          | Hits are listed in the chat and stay **private**: an instance can search an intranet too, so a shared chat does not keep them                                                                     |

#### Licence

SearXNG is licensed under the GNU AGPL v3. iHub does not contain, bundle, link or copy any SearXNG
code: it calls the instance's documented HTTP API, as it would call any web service, and you run the
instance yourself. Using SearXNG this way puts no licence obligation on iHub. Your own obligations
as the operator are those of the AGPL: if you **modify** SearXNG and others use the modified
instance over a network (the people searching through iHub do), section 13 requires you to offer
them the corresponding source of your modified version. An unmodified instance needs nothing beyond
what the AGPL already says about redistribution. This is a description, not legal advice; have your
counsel confirm it for your setup. IntraFind does not ship a SearXNG image; the commands above pull
the upstream one.

#### Troubleshooting

| Test says                      | Cause                                                                                            | What to do                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `SEARXNG_FORBIDDEN` (HTTP 403) | `json` is not in `search.formats` (the default); or the proxy or the limiter refuses this server | Add `json` to `search.formats`, restart the instance; check the proxy and `pass_ip`                                       |
| `SEARXNG_UNAUTHORIZED` (401)   | The proxy in front of SearXNG wants a credential                                                 | Pick a secret in **Authorization** (`Basic …` for Basic auth)                                                             |
| `SEARXNG_TARGET_BLOCKED`       | The address is loopback, link-local, a metadata address or does not resolve here                 | Add the host to `ssrf.allowedHosts` (Admin → Security); company-internal addresses need nothing                            |
| `SEARXNG_REDIRECT` (3xx)       | The instance redirects (often `http://` to `https://`)                                           | Enter the URL the redirect leads to                                                                                         |
| `SEARXNG_NOT_FOUND` (404)      | The URL does not lead to SearXNG                                                                 | Use the base URL; add the path an instance runs under                                                                     |
| `SEARXNG_RATE_LIMITED` (429)   | The instance's limiter throttles iHub                                                            | `pass_ip` for the iHub server, or limiter off for a private instance                                                      |
| `SEARXNG_INVALID_RESPONSE`     | HTML or another service answered                                                                 | Open the URL in a browser; check for a login page or proxy notice                                                         |
| `SEARXNG_ENGINES_UNAVAILABLE`  | The instance is up, but no engine answered                                                       | Open the instance's own search page and see which engines fail (CAPTCHA, timeout); use engines that answer from that host |
| Network error                  | DNS, port, TLS or proxy                                                                          | See `ssl.domainWhitelist` and the proxy settings above                                                                    |

### Connectivity Test (Admin UI)

Whether a search provider _can be reached from this server_ is a separate
question from whether it is configured correctly. The **Test** button of an engine
installation — on its tile under **Admin → Integrations**, on its page and in
its editor (with the values as entered, unsaved) — answers it directly. It
reports two steps:

- **API key**: where the key comes from (the credential, or the environment
  variable), a referenced credential that is empty, or that there is none.
- **Search with …**: one live search with that engine and that key. An engine
  without a key fails before it searches.

The search **bypasses the result cache**, so it reports the engine's behaviour
right now rather than replaying an earlier success. The verdict names what to
do next, with remediation hints:

| Result      | Means                                                          | Next step                                       |
| ----------- | -------------------------------------------------------------- | ----------------------------------------------- |
| **OK**      | The engine answered with results                               | Nothing — search works from this server         |
| **Warning** | It answered, but returned nothing, or rate-limited the request | Try again later, or retest                      |
| **Failed**  | No API key, a rejected key, or the request never arrived       | Fix the credential, or check proxy/TLS settings |

The same check is available without the UI:

```bash
node tests/manual/manual-test-staan-search.js "your query" [--language=de] [--max-results=20]
```

Both engines also accept an endpoint override, which is only needed to
point at a different host:

```env
BRAVE_SEARCH_ENDPOINT=https://api.search.brave.com/res/v1/web/search
STAAN_SEARCH_ENDPOINT=https://api.staan.ai/v2/search/web
WEB_READER_USER_AGENT=            # override the browser UA the page reader sends
```

### Native Search Providers

Native search providers (Google Search, OpenAI Web Search, and Anthropic Web Search) use the API keys already configured for the respective LLM providers. No additional API key setup is needed. Anthropic's native web search is billed separately by Anthropic in addition to standard token costs — see [Anthropic's web search pricing](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool#usage-and-pricing).

Native search is tuned per model in the model configuration (`nativeWebSearch`, see [Models → Native Web Search](models.md#native-web-search)):

- `enabled: false` turns native search off for one model — for example an Anthropic-compatible gateway that does not implement the server tool — so apps use their engine on that model.
- Anthropic only: `toolVersion` selects the web search tool version (`web_search_20250305`, the basic version, by default; `web_search_20260209` and `web_search_20260318` add dynamic filtering on Claude 4.6 and later) and `dynamicFiltering` opts into filtering search results through code execution. Without it, newer versions are called directly (`allowed_callers: ["direct"]`), which is also what Google Cloud and Azure-hosted Foundry require.

Three safeguards apply to every native search call:

- **Search cap.** The app's `websearch.maxSearches` (default 5) or a workflow node's `maxWebSearches` is sent to Anthropic as `max_uses`. Once the cap is reached the model answers with what it has; the refused search reports `max_uses_exceeded` and is not billed.
- **Fallback on rejection.** When the provider refuses the request because of web search — web search disabled for the organisation in the Claude Console, a model or gateway that does not support the tool version — the call is retried without native search and with the app's engine instead (its `websearch.provider`; `auto` for a workflow node), with the page reader. The rejection is remembered for 15 minutes per model so later calls skip the failing request. The fallback engine follows the same rules as any engine: missing, disabled or closed to the user's groups, and the retry runs without web search.

#### Native Search Needs No Engine

Native search is run by the model's provider and is the app's own feature: `resolveAppNativeWebSearch` resolves it from the app's `websearch` settings and the model alone. It needs no engine installation and no integration grant (`permissions.integrations` decides who may use an _engine_, not who gets web search). An app with web search on therefore searches natively on Gemini, OpenAI Responses and Anthropic models on an install without any engine. Workflow nodes that list the generic `webSearch` marker resolve native search per node the same way; their fallback to the first engine the user may use, and any `braveSearch` they list directly, follows the engine's enabled state and grant.

- **Paused turns.** A long Anthropic search turn can end with `stop_reason: pause_turn`. iHub replays the paused assistant message verbatim on a follow-up request (up to three times per call) so the answer is completed instead of truncated.

The billable search count (`server_tool_use.web_search_requests`) is recorded as `webSearchRequests` on the call's usage, in the run log and in the admin usage statistics (`webSearch` totals per app, model and user).

## Tools Reference

The two search tools are the **Search the web** action (`search`) of their
engine installations, not tool files: `braveSearch` (`brave`) and `staanSearch`
(`staan`) keep their ids, but there is no `contents/tools/braveSearch.json`
(or `staanSearch.json`) any more. They are switched
on and off, and restricted to groups, on their engine under **Admin →
Integrations → Web search**. Their throttling is unchanged (Brave: one request
at a time, 1100 ms apart). The page reader `read_url` is a platform tool of the
web search feature, read from `server/defaults/tools/read_url.json` (see
[Page Reader](#page-reader-read_url)).

### Brave Search (`braveSearch`)

**Purpose**: Search the web using Brave Search API for up-to-date information.

**Parameters**:

- `query` (string, required): Search query
- `extractContent` (boolean, optional): Extract full content from top results (default: configured by app)
- `maxResults` (number, optional): Maximum results to return (default: configured by app, max: 10)
- `contentMaxLength` (number, optional): Maximum content length per page (default: configured by app)
- `focus` (string, optional): The question being researched. With `extractContent`, a result page longer than `contentMaxLength` contributes the sections that answer it, verbatim, instead of its first `contentMaxLength` characters — see [Focused reading](#focused-reading-focus)
- `language` (string, optional): Language or locale for the results, e.g. `en`, `de` or `en-GB` (default: the user's language — see [Search Language](#search-language))
- `freshness` (string, optional): Only results from the last `day`, `week`, `month` or `year` (sent to Brave as its own `freshness` parameter)
- `includeDomains` (string[], optional): Only results from these domains (max 10; sent as `site:` operators in the query)

**Returns**: Search results with title, URL, description and hostname, plus the page's date (`publishedDate` from Brave's `page_age`, and Brave's `age` label), extra snippets (on plans that include them) and the site's favicon; optionally extracted page content. See [Result Shape and Filters](#result-shape-and-filters).

### Staan Search (`staanSearch`)

**Purpose**: Search the web using [Staan](https://docs.staan.ai/docs/web-search) for up-to-date information.

Staan is the second keyed engine alongside `braveSearch`. It returns the same
result shape, so an app can switch `websearch.provider` between them without
the model seeing a different contract, and like Brave it is injected from the
app's `websearch` config. It takes **domain scoping** as a request parameter
(`include_domains` / `exclude_domains`); Brave restricts domains through
`site:` in the query, and only Staan can exclude them.

**Parameters**:

- `query` (string, required): Search query. Supports the `site:` and `-site:` operators; trimmed to 400 characters
- `extractContent` (boolean, optional): Extract full content from top results (default: configured by app)
- `maxResults` (number, optional): Maximum results to return (default: configured by app, max: 40). Staan serves 10 results per request, so more than 10 costs one extra request per further 10
- `contentMaxLength` (number, optional): Maximum content length per page (default: configured by app)
- `focus` (string, optional): The question being researched. With `extractContent`, a result page longer than `contentMaxLength` contributes the sections that answer it, verbatim, instead of its first `contentMaxLength` characters — see [Focused reading](#focused-reading-focus)
- `language` (string, optional): Language or locale for the results, e.g. `en`, `de`, `en-GB` (default: `en-us`)
- `includeDomains` (string[], optional): Only return results from these domains (max 10)
- `excludeDomains` (string[], optional): Drop results from these domains (max 10)
- `freshness` (string, optional): Prefer results from the last `day`, `week`, `month` or `year` (best effort). Staan has no such parameter and returns no dates, so the filter cannot drop anything; the tool description and the result say so

`includeDomains` and `excludeDomains` are mutually exclusive — the API rejects a
request carrying both, so `includeDomains` wins when both are given.

**Returns**: Search results with title, URL, description, `hostname` and the site's favicon (Staan's `favicon_url`), and optionally extracted page content.

### SearXNG Search (`searxngSearch`)

**Purpose**: Search the web through your own [SearXNG](#searxng-your-own-search-gateway) instance.

The same result shape and parameters as the other engines, so an app can switch `websearch.provider`
without the model seeing a different contract.

**Parameters**:

- `query` (string, required): Search query
- `extractContent` (boolean, optional): Extract full content from top results (default: configured by app)
- `maxResults` (number, optional): Maximum results to return (default: configured by app, max: 20)
- `contentMaxLength` (number, optional): Maximum content length per page (default: configured by app)
- `focus` (string, optional): The question being researched; see [Focused reading](#focused-reading-focus)
- `language` (string, optional): Language or locale for the results, e.g. `en`, `de`, `de-CH` (default: the user's language)
- `freshness` (string, optional): Only results from the last `day`, `week`, `month` or `year` (sent as `time_range`; dated results outside the window are dropped as well, undated ones kept)
- `includeDomains` (string[], optional): Only results from these domains (max 10; sent as `site:` operators)

**Returns**: Search results with title, URL, description, hostname and an optional `publishedDate`, and optionally extracted page content.

### Result Shape and Filters

All three shipped engines share one result shape (`tools/lib/searchWithExtraction.js`),
so an app can switch engine without the model seeing a different contract (a
third-party engine returns the same shape, see
[Writing your own engine](#writing-your-own-engine)):
`{ title, url, description, hostname }` plus, where the provider returns them,
`publishedDate` (ISO 8601), `age`, `snippets` and `favicon`. The chat's source
cards are drawn from these fields.

`freshness` and `includeDomains` work with every provider. A provider that
filters natively gets its own parameter (Brave `freshness`, Staan
`include_domains`); otherwise domains become `site:` operators in the query, and
freshness drops the dated results outside the window — keeping undated ones —
with a `note` in the result telling the model so. The filters applied are echoed
as `filters` in the result.

> [!NOTE]
> **Markets.** Staan serves the German, French and English markets
> (`de-de`, `fr-fr`, `en-us`, `en-gb`, `en-fr`, `en-ca`, `en-au`, `en-in`,
> `en-ie`, `en-nz`, `en-za`, `en-sg`). An unsupported region falls back to a
> supported one for the same language (`de-CH` → `de-de`), and an unsupported
> language to `en-us`. Note that iHub defaults to `en-us` rather than to the
> API's own default of `fr-fr`.

### Writing your own engine

An engine is any integration definition with `"type": "web-search"` (the
**engine contract**). A third party ships one as a `script` definition (its own
connector module) or an `openapi` definition from a marketplace registry; once
installed, it appears under **Admin → Integrations → Web search**, in the app
editor's engine list, in **All web search engines** (`type:web-search`) on the
group page, and after the shipped engines in `auto`'s order (by installation
id). The contract:

- The definition declares **one action named `search`** (the definition
  schema refuses a `web-search` definition without it, except for MCP and A2A
  definitions, whose actions are listed at run time). Its tool is
  `<installation id>__search`; only shipped definitions keep fixed tool ids.
- `search` takes **`query`** (string, required). It may take **`maxResults`**
  (integer), **`extractContent`** (boolean) and **`contentMaxLength`**
  (integer): when the parameter schema declares them, the app's
  `websearch.maxResults`, `extractContent` and `contentMaxLength` become their
  defaults, clamped to the schema's `minimum` / `maximum`. Further optional
  parameters (`language`, `freshness`, `includeDomains`) are passed through as
  the model sends them.
- It returns the result shape of the shipped engines: `{ results: [{ title,
url, description, hostname, publishedDate?, favicon? }] }`, optionally with
  `extractedContent: [{ url, contentExtracted, content }]`. The chat's sources
  panel reads the hits from it. A third-party engine's hits are kept
  **private** (not shared with a chat share), because iHub cannot know that it
  searched the open web; declare them public with a sources declaration
  (`"sources": { …, "public": true }`) if they are.
- The web search feature calls the action like any other integration action:
  the installation must be enabled and the user's groups must grant it; its
  `test` should run one search.

A minimal `script` engine:

```js
// connector.js of org.example__web-search (type "web-search")
export default {
  actions: {
    search: {
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for' },
          maxResults: { type: 'integer', minimum: 1, maximum: 20, default: 10 }
        },
        required: ['query']
      },
      async run({ query, maxResults = 10 }, ctx) {
        const hits = await searchMyIndex(query, maxResults, ctx.values);
        return {
          results: hits.map(h => ({
            title: h.title,
            url: h.url,
            description: h.snippet,
            hostname: new URL(h.url).hostname
          }))
        };
      }
    }
  },
  async test({ values }) {
    await searchMyIndex('test', 1, values);
    return [{ id: 'search', label: 'Search', status: 'ok', message: 'Answered' }];
  }
};
```

See [Building an Integration](integration-development.md#web-search-engines) for the
definition file and how to publish it.

### Native Search Providers (Google, OpenAI, Anthropic)

Google Search grounding, OpenAI Web Search, and Anthropic Web Search are **not** tools — there is no `googleSearch`, `webSearch`, or `anthropicWebSearch` entry in `contents/tools/`. Each is a provider capability resolved automatically from the app's `websearch` config (see [Unified Web Search Configuration](#unified-web-search-configuration) above) and injected directly into the request by the model adapter:

| Provider               | Native capability                                                                                                        | How it works                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google Gemini          | Google Search grounding                                                                                                  | Mutually exclusive with function calling (Gemini API limitation) — function tools are dropped when native search is active for that request                                                        |
| OpenAI (Responses API) | OpenAI Web Search                                                                                                        | Combinable with function tools in the same request                                                                                                                                                 |
| Anthropic Claude       | Anthropic's server-side [web search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool) | Combinable with function tools; Claude runs the search itself and returns results and citations in the same response, without a round trip through iHub; billed separately by Anthropic per search |

None of these take any parameters — they're automatically enabled when `websearch.useNativeSearch` is on and the app's model supports them (Anthropic additionally receives the app's search cap as `max_uses`). Search queries, results and citations are surfaced as grounding metadata, which powers the "Grounding" answer-source badge and the [sources panel and inline citations](#sources-and-citations). For OpenAI this includes streamed answers: the `url_citation` annotations and `web_search_call` items of the stream are read into the grounding metadata (before, only a non-streamed response's annotations were parsed, and nothing read them).

### Page Reader (`read_url`)

**Purpose**: Open a web page or PDF by URL and return its main content as Markdown, without headers, footers, navigation, ads and other non-content elements.

**Parameters**:

- `url` (string, required): The URL of the page to open
- `maxLength` (integer, optional): Most characters returned per call (default: 10000, clamped to 500-50,000)
- `offset` (integer, optional): Character offset to start reading at — the previous result's `nextOffset`, to read on in a long page (default: 0)
- `focus` (string, optional): The question being researched, in a few words (trimmed, cut at 500 characters). On the first read of a page longer than `maxLength`, the result holds the sections that answer it instead of the first window — see [Focused reading](#focused-reading-focus). Ignored when `offset` is set and for pages that fit in `maxLength`

**Availability**: A platform tool of the web search feature, not an engine's action: the shipped definition `server/defaults/tools/read_url.json` is read in place (initial setup does not copy it into `contents/tools/`). It is offered automatically next to the engine's search tool whenever an app has web search on, and next to Anthropic and OpenAI native search — with or without an engine (see [How Provider Resolution Works](#how-provider-resolution-works)). A workflow node can also list it in `tools` directly; it is only offered once. To stop offering it, put a tool file `contents/tools/read_url.json` with `"enabled": false` (it takes the place of the shipped definition, as for the other platform tools); migration V204 writes one where the `websearch` installation had the page reader switched off. In chats, `websearch.maxPageReads` caps how often one answer may call it (see [Page Read Limit](#page-read-limit)).

**Certificates**: The model cannot switch certificate checking off. Invalid certificates are accepted only when the platform's `ssl.ignoreInvalidCertificates` setting allows it; domains in the SSL whitelist also bypass the SSRF check below.

**Returns**:

- `content`: one window of the page as Markdown — headings, lists, tables, links (absolute) and code are kept; images are left out, with their alt text and addresses; a figure caption stays. Runs of whitespace are collapsed. PDFs are returned as text
- `sourceNotice`: a reminder that everything read from the page (text, title, description, author, dates) was written by the page, not by the user or iHub: information to use, not instructions. A web search result carries it once at the top level, not per page
- `title`, `description`, `author`, and `siteName` / `publishedDate` when the page declares them. A PDF's title and author come from its metadata (the file name when it has no title)
- `truncated`, `totalLength`, `offset` and `nextOffset`: whether the page has more than this window, how long it is, and where the next window starts. A `note` repeats it in words, with the call to make to read on
- `incomplete` (only when true): the document is longer than the reader keeps (400 000 characters, or 500 PDF pages), so the rest cannot be read at any offset. The `note` says so, and the chat shows the page as _truncated_
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

In the chat's tool activity, a page read shows the page's title, its site, the words read and a _truncated_ hint.

#### Focused reading (`focus`)

A page is read from its start, so on a long page the section that answers the question is often past the first 10,000 characters. With `focus`, `read_url` returns the part of the page that matches the question instead:

1. The extracted Markdown is split at its headings (levels 1–4). A page without headings is split into parts of at most 6,000 characters.
2. The sections are ranked with BM25, the keyword ranking the knowledge tools already use (`server/sources/documentRetrieval.js`). There is no model call, no embedding and no extra request: the page comes through the same guarded fetch and page cache as without `focus`.
3. The best sections are returned **verbatim**, best match first, each as `<section id path offset>` with its heading path and the character offset where it starts in the page. After them comes an outline of the whole page, with the offset of every section (`@1234`). The whole `content`, outline included, stays within `maxLength`.

The result also carries `focus` (the question as used) and `excerpted: true`; `truncated` is `true` and a `note` says the content is a selection. There is no `nextOffset` on such a result: the offsets of the outline entries (and of the returned sections) are how to read on. To read around a section, call `read_url` again with its `offset` (without `focus`); to look for something else, call it again with another `focus`.

- **Unchanged without `focus`**, with an empty `focus`, for a page that fits in `maxLength`, and whenever `offset` is set: the result is exactly what it was.
- **No section matches:** the result is the first window of the page followed by the outline (`excerpted: false`), never an empty answer.
- **Sources:** the sections the model was given appear as the passages of the page's source in the sources panel (private, like every page the reader opens). They have no numbered markers: a citation points to the page. A section cut short to fit the length shows only the start the model saw.
- **Counts as one page read** for `maxPageReads`. PDFs, the 400,000-character cap, caching and bot-protection results behave as before.

**Search results (`extractContent`).** The search tools of all three engines take the same optional `focus`. With `extractContent` and a `focus`, each result page longer than `contentMaxLength` is read the same way, within `contentMaxLength`: the best-matching sections, verbatim, each with its heading — but no outline (ten results would carry ten of them), and the `note` of such a page says to open it with `read_url` to read more. A page where no section matches, a page that fits, a search without `focus` and a search without `extractContent` are exactly what they were. The sections the model was given are the passages of that result in the sources panel, with the privacy of the search's other hits (public for the shipped engines). The model chooses `focus`; nothing sets it from the search query, and there is no app setting for it. No config change is needed: the engines' parameters ship with iHub.

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
    "en": "You are a helpful AI assistant with access to web search. When the user asks a question that requires current information, use the web search tool to find relevant content. Cite the source of each statement right after it.",
    "de": "Du bist ein hilfreicher KI-Assistent mit Zugriff auf Websuche. Wenn der Benutzer eine Frage stellt, die aktuelle Informationen erfordert, nutze das Websuch-Tool. Belege jede Aussage direkt dahinter mit ihrer Quelle."
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

The page reader uses the following approach:

1. **Fetch the page** with the user's `Accept-Language`, a browser user agent and a timeout, re-validating every redirect hop against the SSRF guard (or serve it from the page cache)
2. **Parse HTML** using JSDOM, with the page's URL as the base for relative links
3. **Find the main content** with Readability; when it finds no article, strip navigation, ads and chrome and take the first known content container
4. **Convert to Markdown** with Turndown (ATX headings, fenced code, GFM tables)
5. **Extract metadata** (title, description, author, site name, published date)
6. **Cache the whole document** and return the window starting at `offset`, ending at a paragraph break where possible, with `truncated` / `totalLength` / `nextOffset`

`services/pageReader/pageContent.js` holds the extraction rules as pure functions; `services/pageReader/pageReader.js` does the fetching and caching. The page reader is a platform service, not a tool: `read_url` (`tools/readUrl.js`) is only the model's door to it.

### One Way to Read a Web Page

Every read of a web page goes through the page reader (`services/pageReader/pageReader.js`), whoever asks:

| Caller                                                           | Entry                                                                                  |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| The model's `read_url` tool                                      | `readUrl` (`tools/readUrl.js`): checks what the model passed, then calls `readWebPage` |
| A search result's `extractContent` excerpt                       | `readWebPage` (via `tools/lib/searchWithExtraction.js`)                                |
| A project's web page item (`url` kind, the `url` source handler) | `readWebPage` (via `sources/URLHandler.js`)                                            |
| A project's site crawl and its linked-file download              | `fetchWebPage` (the same guarded fetch; the response is read as a file, not as a page) |

So they share one fetch (SSRF guard on every redirect hop, DNS pinning, proxy, `ssl.domainWhitelist`), one extraction (Readability and Turndown, `services/pageReader/pageContent.js`), one page cache and one bot-protection memory. An HTML file in a project is turned into Markdown by the same `extractHtmlPage`, so a saved page and a live one read alike. The only other HTML-to-text converter is the one for e-mail bodies (`.eml`, `.msg`), which are fragments, not pages.

A change to how a page is fetched or extracted belongs in these two files, not in a caller. The `url` source handler has no fetch or conversion of its own: it passes the item's length limit (`maxContentLength`) and the chat to the page reader.

### SSRF Protection

The page reader includes protection against Server-Side Request Forgery (SSRF):

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
- API keys encrypted at rest in the credential store (**Admin → Integrations → Credentials**)

## Troubleshooting

### Common Issues

1. **"Brave Search API key is not configured"**
   - Store the key as a **secret** credential under Admin → Integrations → Credentials and
     pick it in the **API key** field of the `brave` engine (Admin → Integrations → Web search →
     Brave Search) (recommended)
   - Or set the `BRAVE_SEARCH_API_KEY` environment variable and restart the server
   - Or switch the app to Staan (`websearch.provider: "staan"`), or uninstall or disable
     Brave so that `"auto"` takes the next engine

2. **"Failed to extract content"**
   - Check if the URL is accessible
   - Some websites may block automated requests
   - Try with a different URL to test functionality

3. **"Request timeout"**
   - The webpage is taking too long to load
   - Consider increasing timeout or trying a different URL

4. **Web search not working after upgrade**
   - Migration V025 automatically converts old tool-based configs to the new `websearch` format
   - Migrations V195 and V204 move the Brave and Staan keys from **Admin → Providers** into the
     credentials `integration-websearch-brave` / `integration-websearch-staan` and install one
     engine per key; check under **Admin → Integrations → Web
     search** that the app's engine exists and is enabled, and that one of the user's groups
     grants it (**Admin → Groups → Integrations**). Without an engine the app searches only on
     models with native search
   - Check server logs for migration output (`V204` names each engine it installed or not, and
     why)
   - Verify the app has `websearch.enabled: true` in its configuration

5. **Native search not activating for Gemini/GPT/Claude models**
   - Ensure `useNativeSearch` is `true` (default)
   - Verify the model's provider is correctly identified as `google`, `openai-responses`, or `anthropic`
   - Check the model configuration: `nativeWebSearch.enabled: false` switches that model to the app's engine

6. **Answers on a Claude model come from an engine although native search is on** (log line `Native web search unavailable — falling back to a search tool`)
   - The provider rejected the native search request. On Anthropic, check that web search is enabled for your organisation in the Claude Console and that the model supports the configured `nativeWebSearch.toolVersion` (the basic `web_search_20250305` works everywhere)
   - Gateways or proxies that do not implement the server tool: set `nativeWebSearch.enabled: false` on that model so it uses the app's engine without the failed attempt
   - The rejection is remembered for 15 minutes per model; restart the server to reset it earlier

7. **Brave Search requests hang or time out**
   - A search that works when called directly (e.g. from a browser or Postman on your own machine) but times out from iHub is usually the server's outbound proxy — either not configured when the network requires it, or configured but blocking/excluding Brave's domain
   - See [Proxy Configuration → Reproduce a failing request outside iHub](proxy-configuration.md#4-reproduce-a-failing-request-outside-ihub) for Linux/macOS and Windows commands that reproduce the exact request iHub sends, with and without the proxy, so you can tell which side is failing

### Debugging

Enable detailed logging by checking the console output when running the tools. The server logs include information about which websearch tool was selected and why.
