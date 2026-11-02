# Web search: one integration per engine (implementation notes)

**Date:** 2026-11-02
**Status:** Implemented on `claude/exciting-feynman-2aju98-websearch`
**Decision:** [07 · Types and built-in configuration, section 4](07-types-and-built-in-configuration.md) (product owner, 2026-11-01)
**User docs:** [docs/web-tools.md](../../docs/web-tools.md), [docs/integrations.md](../../docs/integrations.md#built-in-integrations), [docs/integration-development.md → Web search engines](../../docs/integration-development.md#web-search-engines)

These notes are for whoever continues the work: what changed, where it lives, why it is shaped
this way, and what is still open.

## What the product owner decided

1. Web search is **one integration per engine**, installed individually, all `type: "web-search"`.
2. With **no engine installed**, an app with web search on still uses the **model's native
   search** where the provider runs one (Google, OpenAI Responses, Anthropic).
3. Others can implement their own engine (a `script` or `openapi` definition of type `web-search`).
4. The page reader `read_url` belongs to the **web search feature**, not to an engine.
5. Upgrade keeps what worked; a fresh install ships no engine.

## The model in one picture

```
app.websearch.enabled ──► model runs native search? ──yes──► native directive (+ read_url on
        │                       (google, openai-responses,          anthropic / openai-responses)
        │                        anthropic, useNativeSearch)         needs NO engine, NO grant
        │                              │ no
        ▼                              ▼
  websearch.provider ──► resolveWebSearchEngine(provider, { user, tools })
     "auto"  → first engine: enabled + granted (+ its `search` tool loaded),
               order brave, staan, qwant, then other web-search installations by id
     "<id>"  → that engine, or nothing (never another engine)
        │
        ▼
  engine's search tool (braveSearch / staanSearch / qwantSearch / <id>__search) + read_url
```

## File map

| File | What it does |
| --- | --- |
| `server/defaults/integration-definitions/com.intrafind__{brave,staan,qwant}-search/` | The three definitions: `type: web-search`, `builtIn`, singleton `brave` / `staan` / `qwant`, `protocol: native` (module `braveSearch` / `staanSearch` / `qwantSearch`), one action `search` with the historical `toolId`, release `1.0.0` with notes. Brave and Staan have one install field `apiKeyRef` (credential). |
| `server/services/integrations/protocols/native/connectors/websearch/index.js` | `createEngineConnector(engineId)`: one connector per engine (`search` action running `server/tools/<engine>Search.js`, the throttle hints, the test). `apiKeyStep(engineId, values)` is the key step of the test. |
| `server/services/integrations/protocols/native/connectors/websearch/parameters.json` | The search tools' parameter schemas, keyed by engine id (the page reader moved out). |
| `server/services/search/webSearchEngines.js` | **Pure.** `BUILT_IN_ENGINES`, `isWebSearchDefinition`, `isWebSearchEngine`, `isWebSearchEngineTool`, `isBuiltInWebSearchEngineTool`, `sortWebSearchEngines` (Auto's order). No config read, so the source producers and `integrationRegistry.js` can import it. |
| `server/services/search/websearchConfig.js` | Reads config: `listWebSearchEngines()`, `getWebSearchEngine(id)`, `resolveEngineApiKeyDetails / resolveEngineApiKey(engineId, values?)` (credential, else env var), `isWebSearchEngineConfigured(engine)`. |
| `server/toolLoader.js` (web search section) | `resolveWebSearchEngine`, `isWebSearchAvailableTo`, `resolveWebSearchEngineTool`, `resolveWebSearchEngineToolId` (workflow nodes), `describeWebSearchAvailability(app, user)`, `resolveAppNativeWebSearch` (no grant, no engine), `resolveNativeWebSearchFallbackTools`, `resolveWebsearchTool` (private), and the `app.tools` exception for engine tools (exact id). |
| `server/defaults/tools/read_url.json`, `server/services/tools/platformTools.js`, `server/utils/setupUtils.js` | The page reader is a platform tool again (`PLATFORM_TOOL_FILE_IDS` has `read_url`); `RETIRED_IHUB_TOOL_FILES` keeps initial setup from copying it into `contents/tools/`. A `contents/tools/read_url.json` with `enabled: false` switches it off. |
| `server/integrationRegistry.js` | `requiredWebSearchKey(app)`: `websearch.required` now means "hide the app while its engine is not available" (`type:web-search` for Auto, the engine id otherwise). |
| `server/services/workflow/executors/PromptNodeExecutor.js` | A node's generic `webSearch` falls back to `resolveWebSearchEngineToolId('auto', { user })` instead of `braveSearch`. |
| `server/services/sources/producers/web.js` | Shipped engines' hits are public; a third-party engine's `search` is recognised by its definition type and its hits stay private. |
| `server/validators/appConfigSchema.js` | `websearch.provider` is any safe installation id (was an enum). |
| `server/validators/integrationDefinitionSchema.js` | A `web-search` definition (not MCP/A2A) must declare an action `search`. |
| `server/migrations/V204__web_search_engines.js` | The upgrade (below). |
| `client/src/features/admin/components/integrations/editors/WebSearchEngineEditor.jsx` | The dedicated editor, registered for the three definitions in `editors/index.js`. |
| `client/src/features/admin/components/integrations/integrationFacts.js` | Tile facts: `API key: set / not set` + `Without a key: <ENV>`; Qwant: `no key needed`. |
| `client/src/features/admin/components/app-form/WebSearchSection.jsx`, `webSearchEngines.js`, `IntegrationsConfigSection.jsx` | The app editor: panel on every chat app, engine select (Auto + installed engines in Auto's order, disabled marked, missing warned), no "not installed" notice. |
| `client/src/features/admin/pages/AdminAppsPage.jsx` | Names a missing required engine (`A web search engine` for `type:web-search`). |
| `client/src/features/admin/components/integrations/integrationBindings.js`, `pages/AdminInstallationPage.jsx` | An engine's Overview and the disable / remove confirmations list the apps that name it (`webSearch`) or use Auto (`webSearchAuto`). |
| `client/src/features/chat/components/ChatInputActionsMenu.jsx`, `ChatInput.jsx` | The web search toggle and chip are offered only on models web search works with (`modelSupportsWebSearch`: native search, or an engine available to the user per `websearchAvailability`). |

## Runtime rules (and why)

- **Auto order** is fixed: built-ins first (`brave`, `staan`, `qwant`), then other engines by
  installation id. Brave first keeps installs that had a Brave key on Brave.
- **Auto does not check API keys.** The decision says "first enabled engine the user's groups
  grant". The migration installs Brave and Staan only where a key existed, so in practice an
  installed keyed engine has a key. An admin who installs Brave without a key gets a failing
  search and a failing Test, which names the problem. `describeWebSearchAvailability` does check
  the key, so the model picker greys models out honestly.
- **Auto skips an engine whose `search` action is switched off** when the loaded tool list is at
  hand (`getToolsForApp`, the fallback tools, workflow nodes), so switching the action off on
  Brave makes Auto use the next engine.
- **A named engine never falls back.** Missing, disabled or not granted → no tool-based search,
  native search unaffected. The app editor warns about a missing or disabled named engine.
- **Native search** (`resolveAppNativeWebSearch`) checks only the app and the model. The
  integration grant (`permissions.integrations`) decides who may use an *engine*.
- **Page reader**: with an engine always; with native search only on `NATIVE_SEARCH_WITH_PAGE_READER`
  (`anthropic`, `openai-responses`), engine or not; never on Google native search; never when
  the app has neither.
- **References by id**: `braveSearch` etc. in `app.tools` / workflow nodes select the engine's tool
  by exact id, then `filterIntegrationToolsForUser` checks enabled + grant. `read_url` is a
  plain platform tool (exact or base id, like any tool file).

## Migration V204

Input: the `websearch` installation (V195) in `config/integrations.json`.

| Rule | Detail |
| --- | --- |
| `brave` | installed when `values.braveCredentialRef` is set (moves to `apiKeyRef`) or `BRAVE_SEARCH_API_KEY` is set |
| `staan` | same with `staanCredentialRef` / `STAAN_API_KEY` |
| `qwant` | installed when the default was `qwant`, or an app has `websearch.provider: "qwant"`, or the default was `auto` with neither key (not on a fresh install) |
| enabled | every new engine takes `websearch.enabled` |
| actions | an engine whose old action (`brave`, `staan`, `qwant`) was off gets `actions.disabled: ["search"]`; a switched-off `readUrl` becomes `contents/tools/read_url.json` with `enabled: false` |
| apps | explicit former default (`brave`/`staan`/`qwant`) → apps with `websearch.provider` `auto`/unset get that id; `app.integrations.websearch` / `["com.intrafind/web-search"]` and `tools: ["websearch"]` are removed |
| groups | `websearch` and `com.intrafind/web-search` in `permissions.integrations` → `type:web-search` (deduplicated) |
| credentials | V195's `integration-websearch-*` credentials get a new description naming the engine |
| removal | the `websearch` installation is deleted |

**Fresh install detection.** All migrations run on a fresh install too, after initial setup copied
the defaults. V195 (already applied elsewhere, so it cannot change) creates `websearch` with
default `auto` and no key — which would read as "Qwant was reachable". V204 therefore reads
`contents/.migration-history.json`: when its first entry is younger than 15 minutes
(`FRESH_RUN_WINDOW_MS`), the history began in this run and the install is fresh, so the `auto`
default is not taken as evidence. Keys and apps naming Qwant still count. A missing history counts
as an upgrade (keep what worked).

Example: `websearch` enabled with `braveCredentialRef: "integration-websearch-brave"`,
`defaultProvider: "brave"`, group `anonymous` granted `["ihub", "websearch"]` → installation
`brave` with `apiKeyRef: "integration-websearch-brave"`, no `qwant` (the default was not `auto`),
apps on `auto` set to `brave`, `anonymous` granted `["ihub", "type:web-search"]`, `websearch`
removed.

## Tests

| Test | Covers |
| --- | --- |
| `server/tests/websearch-provider-selection.test.js` | Auto order, disabled / not granted engines skipped, grant keys (id, definition, type, `*`), third-party engines after the built-ins, named engines without fallback, `describeWebSearchAvailability` |
| `server/tests/websearch-installation-access.test.js` | Native search without engine and grant, page reader on Anthropic/OpenAI without an engine, nothing on other models without an engine, named engine missing → native only, `app.tools` / workflow node references by id, `webSearch` fallback, the native-search fallback tools |
| `server/tests/websearch-page-reader.test.js` | The reader as a platform tool, switched off by a tool file, offered once |
| `server/tests/websearch-engine-connectors.test.js` | Definitions valid, connectors registered, API key step, test with the unsaved key |
| `server/tests/migration-v204.test.js` | Every migration rule, fresh install, idempotence, missing files |
| `server/tests/helpers/webSearchEngines.js` | Fixtures: real definitions and connectors, per-test installations, groups, tool files |
| `tests/unit/client/admin-installation-page.test.jsx`, `admin-integrations-page.test.jsx`, `integration-groups-and-facts.test.jsx`, `app-editor-integrations-section.test.jsx`, `chat-actions-menu-websearch-keyboard.test.jsx` | The editor, tiles and facts, the catalog group, the app editor's engine list and warnings, the chat toggle per model |

Run: `npm run test:websearch`, `test:tool-loading`, `test:integrations`, `test:migrations`,
`npx jest --config tests/config/jest.config.js tests/unit`.

## Open points

- The shipped workflows `claude-style-agent`, `claude-style-agent-phased` and `research-assistant`
  name `braveSearch` in their nodes: without a `brave` installation those nodes have no search.
  Switching them to the generic `webSearch` marker changes behaviour on Gemini (function tools are
  dropped next to Google grounding), so it was left for a decision.
- Auto ignores API keys (see above). If installs end up with keyless Brave installations, Auto
  could skip engines that `isWebSearchEngineConfigured` rejects.
- `docs/book/` is generated and still describes the `websearch` installation until it is rebuilt.
