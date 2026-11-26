// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Web search engines: the installed integrations of type `web-search`.
 *
 * Web search is a feature of the app (`app.websearch`); an **engine** is one
 * integration installation that searches the web for it. iHub ships three
 * built-in engine definitions, each a singleton whose installation id is the
 * value `app.websearch.provider` always used:
 *
 * | Installation | Definition                    | Tool id       | API key env fallback   |
 * | ------------ | ----------------------------- | ------------- | ---------------------- |
 * | `brave`      | `com.intrafind/brave-search`  | `braveSearch` | `BRAVE_SEARCH_API_KEY` |
 * | `staan`      | `com.intrafind/staan-search`  | `staanSearch` | `STAAN_API_KEY`        |
 * | `searxng`    | `com.intrafind/searxng-search`| `searxngSearch` | —                    |
 *
 * `searxng` is the only engine whose address is an install value
 * (`instanceUrl`): it searches through the customer's own SearXNG instance.
 * Its hits are not known to come from the open web (an instance can include
 * intranet engines), so they stay private (`publicHits: false`).
 *
 * A third party ships its own engine as a `script` or `openapi` definition of
 * `type: "web-search"` with one action named `search` (the **engine
 * contract**, see `docs/integration-development.md`); its tool is
 * `<installation id>__search`.
 *
 * `app.websearch.provider: "auto"` takes the first engine a user may use, in
 * the order of {@link sortWebSearchEngines}: the built-ins in the order above,
 * then every other engine by installation id.
 *
 * Pure module: no configuration is read here (see `websearchConfig.js` for the
 * installed engines), so the source producers and the tool loader can import
 * it without an import cycle.
 *
 * @module services/search/webSearchEngines
 */
import { getDefinitionTypes } from '../integrations/integrationTypes.js';

/** The integration type every web search engine declares. */
export const WEB_SEARCH_TYPE = 'web-search';

/** The one action the web search feature calls on an engine. */
export const WEB_SEARCH_ACTION = 'search';

/** The `app.websearch.provider` value that picks the first available engine. */
export const AUTO_ENGINE = 'auto';

/**
 * The shipped engines, in the order `auto` tries them.
 * `publicHits: false` marks an engine whose results are not known to come from
 * the open web.
 * @type {ReadonlyArray<{ id: string, definition: string, toolId: string, keyEnv: string|null, publicHits: boolean }>}
 */
export const BUILT_IN_ENGINES = Object.freeze([
  Object.freeze({
    id: 'brave',
    definition: 'com.intrafind/brave-search',
    toolId: 'braveSearch',
    keyEnv: 'BRAVE_SEARCH_API_KEY',
    publicHits: true
  }),
  Object.freeze({
    id: 'staan',
    definition: 'com.intrafind/staan-search',
    toolId: 'staanSearch',
    keyEnv: 'STAAN_API_KEY',
    publicHits: true
  }),
  Object.freeze({
    id: 'searxng',
    definition: 'com.intrafind/searxng-search',
    toolId: 'searxngSearch',
    keyEnv: null,
    publicHits: false
  })
]);

/** The install field of a keyed engine that references its API key credential. */
export const ENGINE_API_KEY_FIELD = 'apiKeyRef';

/** The install field holding the base URL of a self-hosted engine (SearXNG). */
export const ENGINE_INSTANCE_URL_FIELD = 'instanceUrl';

/** The install field of a self-hosted engine that references the credential its gateway expects. */
export const ENGINE_AUTHORIZATION_FIELD = 'authorizationRef';

const BUILT_IN_BY_ID = new Map(BUILT_IN_ENGINES.map(engine => [engine.id, engine]));
const BUILT_IN_DEFINITIONS = new Set(BUILT_IN_ENGINES.map(engine => engine.definition));
const PUBLIC_HIT_DEFINITIONS = new Set(
  BUILT_IN_ENGINES.filter(engine => engine.publicHits).map(engine => engine.definition)
);

/**
 * The shipped engine with this installation id, or null.
 * @param {string} id - e.g. `brave`
 * @returns {{ id: string, definition: string, toolId: string, keyEnv: string|null, publicHits: boolean }|null}
 */
export function builtInEngine(id) {
  return BUILT_IN_BY_ID.get(id) || null;
}

/**
 * Whether a definition is a web search engine: one of the shipped engine
 * definitions, or any definition the registry published with
 * `type: "web-search"`.
 *
 * @param {string} definitionId
 * @returns {boolean}
 */
export function isWebSearchDefinition(definitionId) {
  if (typeof definitionId !== 'string' || !definitionId) return false;
  if (BUILT_IN_DEFINITIONS.has(definitionId)) return true;
  const types = getDefinitionTypes();
  return Object.hasOwn(types, definitionId) && types[definitionId] === WEB_SEARCH_TYPE;
}

/**
 * Whether an installation is a web search engine.
 * @param {{ id?: string, definition?: string }|null|undefined} instance
 * @returns {boolean}
 */
export function isWebSearchEngine(instance) {
  return Boolean(instance?.id) && isWebSearchDefinition(instance.definition);
}

/**
 * Whether a loaded tool is the `search` action of a web search engine.
 * @param {{ _integration?: { action?: string, definition?: string } }|null|undefined} tool
 * @returns {boolean}
 */
export function isWebSearchEngineTool(tool) {
  const integration = tool?._integration;
  return (
    Boolean(integration) &&
    integration.action === WEB_SEARCH_ACTION &&
    isWebSearchDefinition(integration.definition)
  );
}

/**
 * Whether a loaded tool is the search action of a shipped engine whose hits
 * are known to come from the open web (Brave, Staan; not SearXNG, whose
 * instance may search an intranet).
 * @param {{ _integration?: { action?: string, definition?: string } }|null|undefined} tool
 * @returns {boolean}
 */
export function isBuiltInWebSearchEngineTool(tool) {
  const integration = tool?._integration;
  return (
    Boolean(integration) &&
    integration.action === WEB_SEARCH_ACTION &&
    PUBLIC_HIT_DEFINITIONS.has(integration.definition)
  );
}

/**
 * Engines in the order `auto` tries them: the built-ins (`brave`, `staan`,
 * `searxng`), then every other engine by installation id. Returns a new array.
 *
 * @template {{ id: string }} T
 * @param {T[]} engines
 * @returns {T[]}
 * @example
 * sortWebSearchEngines([{ id: 'zeta' }, { id: 'staan' }, { id: 'acme' }, { id: 'brave' }])
 *   .map(e => e.id); // → ['brave', 'staan', 'acme', 'zeta']
 */
export function sortWebSearchEngines(engines) {
  const rank = id => {
    const index = BUILT_IN_ENGINES.findIndex(engine => engine.id === id);
    return index === -1 ? BUILT_IN_ENGINES.length : index;
  };
  return [...(Array.isArray(engines) ? engines : [])].sort((a, b) => {
    const byRank = rank(a?.id) - rank(b?.id);
    if (byRank !== 0) return byRank;
    return String(a?.id).localeCompare(String(b?.id));
  });
}
