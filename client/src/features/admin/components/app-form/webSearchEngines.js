// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The web search engines as the app editor offers them: the installations of
 * type `web-search` (`GET /api/admin/integrations/installed`), in the order
 * `websearch.provider: "auto"` tries them on the server
 * (`server/services/search/webSearchEngines.js`): Brave, Staan, Qwant, then
 * every other engine by id.
 *
 * Pure module (no React), so the order and the status rules are tested on
 * their own.
 *
 * @module features/admin/components/app-form/webSearchEngines
 */

/** The `websearch.provider` value that takes the first engine a user may use. */
export const AUTO_ENGINE = 'auto';

/** The shipped engines, in the order `auto` tries them. */
export const BUILT_IN_ENGINE_ORDER = Object.freeze(['brave', 'staan', 'qwant']);

/**
 * The engine installations, sorted as `auto` tries them.
 *
 * @param {Array<{ id: string, type?: string|null }>|null|undefined} installed
 * @returns {Array<Object>} installations of type `web-search`
 * @example
 *   webSearchEnginesOf([{ id: 'qwant', type: 'web-search' }, { id: 'jira' },
 *                       { id: 'brave', type: 'web-search' }]).map(e => e.id); // ['brave', 'qwant']
 */
export function webSearchEnginesOf(installed) {
  const rank = id => {
    const index = BUILT_IN_ENGINE_ORDER.indexOf(id);
    return index === -1 ? BUILT_IN_ENGINE_ORDER.length : index;
  };
  return (Array.isArray(installed) ? installed : [])
    .filter(item => item?.type === 'web-search' && item.id)
    .sort((a, b) => rank(a.id) - rank(b.id) || String(a.id).localeCompare(String(b.id)));
}

/**
 * What the engine an app names means right now.
 *
 * @param {string|undefined} provider - `app.websearch.provider`
 * @param {Array<Object>|null} engines - from {@link webSearchEnginesOf}; null when unknown
 * @returns {'auto'|'ok'|'disabled'|'missing'|'unknown'}
 *   `auto`: the first engine a user may use; `missing`: no engine installation
 *   has this id; `disabled`: it exists but is switched off
 */
export function webSearchEngineStatus(provider, engines) {
  if (!provider || provider === AUTO_ENGINE) return 'auto';
  if (!Array.isArray(engines)) return 'unknown';
  const engine = engines.find(item => item.id === provider);
  if (!engine) return 'missing';
  return engine.enabled === false ? 'disabled' : 'ok';
}
