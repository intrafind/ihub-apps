/**
 * Whether web search works with a model in an app — for the model picker.
 * The sources a web search found are part of the answer's sources
 * (`shared/sources`, `features/chat/sources/`).
 *
 * @module features/chat/webSearch
 */

import { modelSupportsTools } from '../../../../shared/modelCapabilities.js';

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
  const script = availability?.script !== false && modelSupportsTools(model);
  return native || script;
}
