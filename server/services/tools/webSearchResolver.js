// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Web search resolution: which search engine an app or user gets, whether the
 * model's own (native) web search is used instead, and the tools a provider that
 * rejects native search falls back to.
 */

import {
  getWebSearchEngine,
  isWebSearchEngineConfigured,
  listWebSearchEngines
} from '../search/websearchConfig.js';
import { AUTO_ENGINE, WEB_SEARCH_ACTION } from '../search/webSearchEngines.js';
import { mayUseIntegration } from '../integrations/integrationAccess.js';
import logger from '../../utils/logger.js';
import { loadTools } from './catalog.js';

/**
 * Model providers that can run web search themselves (server-side), without
 * a script-backed tool. Native search is a request-time capability the
 * adapter enables directly on the provider request — never a "tool" the
 * generic tool-calling pipeline has to know about or convert.
 * @type {Set<string>}
 */
const NATIVE_WEB_SEARCH_PROVIDERS = new Set(['google', 'openai-responses', 'anthropic']);

/**
 * Default cap on provider-run searches per model call. Anthropic bills every
 * search separately, so an uncapped research prompt can fan out into dozens of
 * billable searches for one answer. Overridable per app
 * (`websearch.maxSearches`) and per workflow node (`maxWebSearches`).
 */
export const DEFAULT_NATIVE_WEB_SEARCH_MAX_USES = 5;

/**
 * Native search providers whose requests take function tools next to the
 * search, so the page reader can be offered with it: the model searches with
 * the provider and opens a result, or a URL the user pasted, with the reader.
 *
 * Google is not one of them. Gemini drops every function declaration next to
 * `google_search` (see adapters/google.js); combining the two is a preview
 * feature for Gemini 3 only, and needs the server-side tool calls circulated
 * back through the conversation, which the adapter does not do.
 * @type {Set<string>}
 */
export const NATIVE_SEARCH_WITH_PAGE_READER = new Set(['anthropic', 'openai-responses']);

/**
 * The engine a native web search directive falls back to when the provider
 * turns native search down and no app says which engine to use (a workflow
 * node): the first engine the user may use.
 */
export const NATIVE_WEB_SEARCH_FALLBACK_ENGINE = AUTO_ENGINE;

/**
 * Page reader offered next to the engine's search tool, so the model can open
 * a result (or a URL the user gave it) in full instead of relying on the
 * search tool's short automatic excerpts. It belongs to the web search
 * feature, not to an engine: a platform tool (`services/tools/platformTools.js`).
 */
export const READ_URL_TOOL_ID = 'read_url';

/**
 * Whether an engine installation offers its search to a user: it is enabled
 * and the user's groups grant it (`permissions.integrations`: `*`, the
 * installation id, its definition id or `type:web-search`) — the checks
 * `runIntegrationTool` makes before it runs the search, so nothing is offered
 * that the call would then refuse.
 *
 * @param {Object|null} engine - the installation
 * @param {Object} [user]
 * @returns {boolean}
 */
function engineUsableBy(engine, user) {
  return Boolean(engine) && engine.enabled !== false && mayUseIntegration(engine, user);
}

/**
 * The `search` tool of an engine in a loaded tool list, or null (the
 * installation is off, or an admin switched its search action off).
 *
 * @param {{ id: string }} engine
 * @param {Object[]} tools - result of `loadTools()`
 * @returns {Object|null}
 */
function engineSearchTool(engine, tools) {
  return (
    tools.find(
      tool =>
        tool?._integration?.instanceId === engine.id &&
        tool._integration.action === WEB_SEARCH_ACTION
    ) || null
  );
}

/**
 * The web search engine an app's web search uses for a user.
 *
 * `provider` is `app.websearch.provider`:
 *
 * - `auto` (or unset): the first engine that is enabled and that the user's
 *   groups grant, in the order Brave, Staan, Qwant, then every other
 *   installation of type `web-search` by id (`sortWebSearchEngines`);
 * - an installation id: that engine, and nothing when it is missing, disabled
 *   or not granted to the user. It never falls back to another engine, so an
 *   app set to one engine does not silently answer from another.
 *
 * No engine means no tool-based search; native search is not affected (it is
 * the app's own feature and needs no engine, see {@link resolveAppNativeWebSearch}).
 *
 * @param {string} [provider='auto'] - `app.websearch.provider`
 * @param {Object} [options]
 * @param {Object} [options.user] - The acting user; none means the anonymous principal
 * @param {Object[]} [options.tools] - The loaded tools: when given, an engine
 *   counts only when its `search` tool is among them, so `auto` passes over an
 *   engine whose search action an admin switched off
 * @returns {Object|null} The engine installation, or null
 * @example
 * // brave disabled, staan not granted to the user, qwant enabled and granted
 * resolveWebSearchEngine('auto', { user })?.id;  // → 'qwant'
 * resolveWebSearchEngine('brave', { user });     // → null (no fallback)
 */
export function resolveWebSearchEngine(provider = AUTO_ENGINE, { user, tools } = {}) {
  const usable = engine =>
    engineUsableBy(engine, user) && (!tools || Boolean(engineSearchTool(engine, tools)));
  if (provider && provider !== AUTO_ENGINE) {
    const engine = getWebSearchEngine(provider);
    return usable(engine) ? engine : null;
  }
  return listWebSearchEngines().find(usable) || null;
}

/**
 * Whether a tool-based web search engine is available to a user: the engine
 * `provider` resolves to exists, is enabled and is granted to the user's
 * groups. Native search does not depend on it.
 *
 * @param {Object} [user] - The acting user; none means the anonymous principal
 * @param {string} [provider='auto'] - `app.websearch.provider`
 * @returns {boolean}
 */
export function isWebSearchAvailableTo(user, provider = AUTO_ENGINE) {
  return Boolean(resolveWebSearchEngine(provider, { user }));
}

/**
 * The `search` tool of the engine an app's web search uses, from the loaded
 * tool list (see {@link resolveWebSearchEngine}).
 *
 * @param {string} [provider='auto'] - `app.websearch.provider`
 * @param {Object[]} allTools - result of `loadTools()`
 * @param {Object} [user]
 * @returns {Object|null} The tool definition (`braveSearch`, `acme__search`, …), or null
 */
export function resolveWebSearchEngineTool(provider, allTools, user) {
  const engine = resolveWebSearchEngine(provider, { user, tools: allTools });
  return engine ? engineSearchTool(engine, allTools) : null;
}

/**
 * The tool id of the engine a workflow node's generic `webSearch` falls back
 * to on a model without native search (see `PromptNodeExecutor`).
 *
 * @param {string} [provider='auto']
 * @param {{ user?: Object, language?: string }} [options]
 * @returns {Promise<string|null>} e.g. `braveSearch`; null when no engine is available
 */
export async function resolveWebSearchEngineToolId(
  provider = AUTO_ENGINE,
  { user, language } = {}
) {
  const allTools = await loadTools(language);
  return resolveWebSearchEngineTool(provider, allTools, user)?.id || null;
}

/**
 * Whether web search can work for an app, as the chat's model picker needs to
 * know it: which providers run it natively (when the app allows native
 * search), and whether the app's engine is available to the user and has
 * what it needs to answer (Brave and Staan need a key; Qwant needs none). A
 * model supports web search in the app when it is on one of the native
 * providers, or when it can call tools and an engine works.
 *
 * @param {Object} app - App configuration
 * @param {Object} [user] - The user asking; the engine's group grant applies
 * @returns {Promise<{native: string[], script: boolean}|null>} null when the app has no web search
 */
export async function describeWebSearchAvailability(app, user) {
  if (!app?.websearch?.enabled) return null;
  const engine = resolveWebSearchEngine(app.websearch.provider, { user });
  return {
    native: app.websearch.useNativeSearch === false ? [] : [...NATIVE_WEB_SEARCH_PROVIDERS],
    script: Boolean(engine) && isWebSearchEngineConfigured(engine)
  };
}

function normalizeMaxUses(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_NATIVE_WEB_SEARCH_MAX_USES;
}

/**
 * Resolve the native web search directive for a model.
 *
 * Native search is a request-time capability the adapter enables directly on
 * the provider request — never a "tool" the generic tool-calling pipeline has
 * to know about. A model config can opt out with `nativeWebSearch.enabled:
 * false` (an Anthropic-compatible gateway without the server tool, an older
 * model); callers then use the app's web search engine, the same one the loop
 * switches to when the provider rejects the directive.
 *
 * @param {string} modelProvider - Provider of the selected model
 * @param {Object} [options]
 * @param {Object} [options.model] - Full model config (per-model opt-out)
 * @param {number} [options.maxUses] - Per-call search cap (Anthropic `max_uses`)
 * @returns {{provider: string, maxUses: number, fallback: string} | null} `fallback`
 *   is the engine to fall back to when no app names one (`auto`)
 */
export function resolveNativeWebSearchProvider(modelProvider, { model, maxUses } = {}) {
  if (!NATIVE_WEB_SEARCH_PROVIDERS.has(modelProvider)) return null;
  if (model?.nativeWebSearch?.enabled === false) return null;
  return {
    provider: modelProvider,
    maxUses: normalizeMaxUses(maxUses),
    fallback: NATIVE_WEB_SEARCH_FALLBACK_ENGINE
  };
}

/**
 * Resolve native web search for an app's unified `websearch` config + model provider.
 *
 * Native search is the app's own web search, run by the model's provider: it
 * needs no engine installation and no integration grant, so an app with web
 * search on searches natively on Google, OpenAI Responses and Anthropic
 * models even while no engine is installed. Returns null when native search
 * doesn't apply — the caller (getToolsForApp) uses the app's engine then.
 *
 * @param {Object} app - App configuration with optional websearch field
 * @param {string} modelProvider - Provider of the selected model (e.g. 'google', 'openai-responses')
 * @param {boolean|undefined} websearchEnabled - User toggle: undefined = use enabledByDefault, false = disabled
 * @param {Object} [model] - Full model config (per-model opt-out)
 * @returns {{provider: string, maxUses: number, fallback: string} | null}
 */
export function resolveAppNativeWebSearch(app, modelProvider, websearchEnabled, model) {
  if (!app?.websearch?.enabled) return null;

  const { enabledByDefault = false, useNativeSearch = true } = app.websearch;

  // When websearchEnabled is undefined (client didn't send a toggle value),
  // fall back to the admin-configured enabledByDefault setting.
  const effectiveEnabled = websearchEnabled !== undefined ? websearchEnabled : enabledByDefault;
  if (!effectiveEnabled || !useNativeSearch) return null;

  return resolveNativeWebSearchProvider(modelProvider, {
    model,
    maxUses: app.websearch.maxSearches
  });
}

/**
 * Clone an engine's search tool definition with an app's `websearch`
 * parameter defaults applied (never mutates the cached definition).
 *
 * Each engine's tool declares its own bounds — Qwant returns at most 10
 * results per search where Brave allows 20 — so an admin value is clamped to
 * what the chosen tool accepts instead of being written through verbatim and
 * failing schema validation at call time. A parameter the engine does not
 * declare (a third-party engine without `extractContent`) is left alone.
 *
 * @param {Object} toolDef - The engine's search tool (braveSearch, staanSearch, qwantSearch, …)
 * @param {Object} [websearch] - app.websearch config
 * @returns {Object} tool definition ready to offer to the model
 */
function buildWebsearchTool(toolDef, websearch = {}) {
  const { maxResults = 5, extractContent = true, contentMaxLength = 3000 } = websearch || {};
  const cloned = JSON.parse(JSON.stringify(toolDef));
  const props = cloned.parameters?.properties || {};

  // Override parameter defaults with admin-configured websearch values
  if (props.maxResults) props.maxResults.default = clampToSchema(maxResults, props.maxResults);
  if (props.extractContent) props.extractContent.default = extractContent;
  if (props.contentMaxLength) {
    props.contentMaxLength.default = clampToSchema(contentMaxLength, props.contentMaxLength);
  }

  return cloned;
}

/**
 * Clamp a number into a JSON Schema property's `minimum`/`maximum`.
 * @param {number} value
 * @param {{minimum?: number, maximum?: number}} schema
 * @returns {number}
 */
function clampToSchema(value, schema) {
  let n = Number(value);
  if (!Number.isFinite(n)) return value;
  if (Number.isFinite(schema?.minimum)) n = Math.max(schema.minimum, n);
  if (Number.isFinite(schema?.maximum)) n = Math.min(schema.maximum, n);
  return n;
}

/**
 * Tools to offer instead of a native web search directive the provider turned
 * down (see services/loop/nativeWebSearchFallback.js): the search tool of the
 * engine the app names (`auto` without an app: the first engine the user may
 * use) with the page reader. Empty when no engine is available to the user —
 * the retry then runs without web search.
 *
 * @param {{fallback?: string}|null} directive - the rejected directive
 * @param {{app?: Object, language?: string, user?: Object}} [context]
 * @returns {Promise<Object[]>}
 */
export async function resolveNativeWebSearchFallbackTools(directive, { app, language, user } = {}) {
  // With an app in hand, fall back to the engine that app is configured for —
  // an app set to Qwant should not silently answer from Brave just because
  // the model turned native search down.
  const provider = app?.websearch
    ? app.websearch.provider
    : directive?.fallback || NATIVE_WEB_SEARCH_FALLBACK_ENGINE;
  const allTools = await loadTools(language);
  const engineTool = resolveWebSearchEngineTool(provider, allTools, user);
  if (!engineTool) {
    logger.info('No web search engine to fall back to from native search', {
      component: 'ToolLoader',
      provider: provider || AUTO_ENGINE
    });
    return [];
  }
  return withPageReader(
    app?.websearch ? buildWebsearchTool(engineTool, app.websearch) : engineTool,
    allTools
  );
}

/**
 * Pair an engine's search tool with the page reader, so the model can open
 * what it found. The reader is left out when it is not in the tool list.
 * @param {Object} searchTool - Search tool definition to offer
 * @param {Object[]} allTools - All available tool definitions
 * @returns {Object[]} The search tool, followed by the page reader when available
 */
function withPageReader(searchTool, allTools) {
  const reader = allTools.find(t => t.id === READ_URL_TOOL_ID);
  return reader ? [searchTool, reader] : [searchTool];
}

/**
 * The web search tools of an app for one request: native search on the
 * model's provider wins (it is passed straight to the adapter by
 * resolveAppNativeWebSearch, not through the tools pipeline), with the page
 * reader next to it where the provider accepts function tools; otherwise the
 * search tool of the app's engine (`app.websearch.provider`, see
 * {@link resolveWebSearchEngine}) with the page reader. Overrides the engine
 * tool's parameter defaults with the values from app.websearch config.
 *
 * @param {Object} app - App configuration with optional websearch field
 * @param {string} modelProvider - Provider of the selected model
 * @param {Array} allTools - All available tool definitions
 * @param {boolean|undefined} websearchEnabled - User toggle: undefined = use enabledByDefault, false = disabled
 * @param {Object} [model] - Full model config (per-model native search opt-out)
 * @param {Object} [user] - The acting user; the engine's group grant applies
 * @returns {Array} No tools, the search tool followed by the page reader, or — with
 *   native search on a provider in {@link NATIVE_SEARCH_WITH_PAGE_READER} — the reader alone
 */
export function resolveWebsearchTool(app, modelProvider, allTools, websearchEnabled, model, user) {
  if (!app.websearch?.enabled) return [];

  const { enabledByDefault = false } = app.websearch;

  const effectiveEnabled = websearchEnabled !== undefined ? websearchEnabled : enabledByDefault;
  if (!effectiveEnabled) return [];

  // Native search handles this app/model combination — no search tool needed,
  // but the page reader still is where the provider accepts function tools.
  // It needs no engine.
  const native = resolveAppNativeWebSearch(app, modelProvider, websearchEnabled, model);
  if (native) {
    if (!NATIVE_SEARCH_WITH_PAGE_READER.has(native.provider)) return [];
    const reader = allTools.find(t => t.id === READ_URL_TOOL_ID);
    return reader ? [reader] : [];
  }

  const engineTool = resolveWebSearchEngineTool(app.websearch.provider, allTools, user);
  if (!engineTool) {
    logger.debug('No web search engine available for the app', {
      component: 'ToolLoader',
      appId: app.id,
      provider: app.websearch.provider || AUTO_ENGINE
    });
    return [];
  }

  return withPageReader(buildWebsearchTool(engineTool, app.websearch), allTools);
}
