/**
 * The web search behind a live chat turn, as the sources view and the inline
 * citations read it — the same record the server stores with the answer
 * (`server/services/chat/chatMaterializer.js`), built by the same code
 * (`shared/webCitations.js`).
 *
 *   buildRunWebSearch(run) → { queries, sources, supports } | null
 *   webSearchLabel(t, webSearch) → "Searched for “…”" | "3 searches" | "Sources"
 *
 * @module features/chat/webSearch
 */
import { buildWebSearch } from '../../../../shared/webCitations.js';

/**
 * @param {Object|null} run - RunState from the run reducer
 * @returns {{queries: string[], sources: Object[], supports: Object[]}|null}
 */
export function buildRunWebSearch(run) {
  if (!run) return null;
  const tools = (run.tools || [])
    .filter(tool => !tool.execution || tool.execution === 'server')
    .map(tool => ({
      toolId: tool.toolId,
      args: tool.args,
      webSources: tool.webSources,
      status: tool.status,
      error: tool.error
    }));
  // A completed step carries the server-merged grounding of that step; while
  // streaming, the progress frames the reducer merged stand in.
  const stepGrounding = Object.values(run.steps || {})
    .map(step => step.groundingMetadata)
    .filter(Boolean);
  const grounding = stepGrounding.length ? stepGrounding : run.grounding ? [run.grounding] : [];
  return buildWebSearch({ tools, grounding });
}

/**
 * The entry point's label: the query when there was one, the count when there
 * were several, "Sources" when the provider reported none.
 * @param {Function} t - i18next t
 * @param {{queries?: string[]}|null} webSearch
 * @returns {string}
 */
export function webSearchLabel(t, webSearch) {
  const queries = webSearch?.queries || [];
  if (queries.length === 1) {
    return t('webSources.searchedFor', 'Searched for “{{query}}”', { query: queries[0] });
  }
  if (queries.length > 1) return t('webSources.searches', { count: queries.length });
  return t('webSources.title', 'Sources');
}

/** Providers that run web search themselves (mirrors the server's list). */
const NATIVE_WEB_SEARCH_PROVIDERS = ['google', 'openai-responses', 'anthropic'];

/**
 * Whether web search works with a model in an app, for the model picker's
 * marker: natively on a provider that runs it (unless the app or the model
 * opted out), or through the app's script-backed search tool when the model
 * can call tools and that search is usable. `app.websearchAvailability` comes
 * from the server (`GET /api/apps/:id`); without it, script-backed search is
 * assumed to work.
 *
 * @param {Object} app
 * @param {Object} model
 * @returns {boolean|null} null when the app has no web search (no marker at all)
 */
export function modelSupportsWebSearch(app, model) {
  if (!app?.websearch?.enabled || !model) return null;
  const availability = app.websearchAvailability;
  const nativeProviders = Array.isArray(availability?.native)
    ? availability.native
    : app.websearch.useNativeSearch === false
      ? []
      : NATIVE_WEB_SEARCH_PROVIDERS;
  const native =
    nativeProviders.includes(model.provider) && model.nativeWebSearch?.enabled !== false;
  const script = availability?.script !== false && Boolean(model.supportsTools);
  return native || script;
}
